import type { Bytes } from '$lib/bytes';

export const MASKROM_VENDOR_ID = 0x1b8e;
export const MASKROM_PRODUCT_ID = 0xc003;

const REQ_RUN_IN_ADDR = 0x05;
const REQ_WR_LARGE_MEM = 0x11;
const REQ_GET_AMLC = 0x50;
const REQ_WRITE_AMLC = 0x60;

const FLAG_KEEP_POWER_ON = 0x10;

const AMLC_AMLS_BLOCK_LENGTH = 0x200;
const AMLC_MAX_BLOCK_LENGTH = 0x4000;
const AMLC_MAX_TRANSFER_LENGTH = 65536;
const MAX_LARGE_BLOCK_COUNT = 65535;

const G12A_BL2_SRAM_ADDRESS = 0xfffa0000;
const BL2_UPLOAD_BLOCK_BYTES = 4096;
const BL2_DDR_INIT_MS = 2000;

const AMLC_READ_TIMEOUT_MS = 5000;
const AMLC_ACK_TIMEOUT_MS = 2000;

export function isMaskromDevice(device: USBDevice): boolean {
	return device.vendorId === MASKROM_VENDOR_ID && device.productId === MASKROM_PRODUCT_ID;
}

export class Maskrom {
	private readonly device: USBDevice;
	private readonly endpointIn: number;
	private readonly endpointOut: number;

	private constructor(device: USBDevice, endpointIn: number, endpointOut: number) {
		this.device = device;
		this.endpointIn = endpointIn;
		this.endpointOut = endpointOut;
	}

	static async open(device: USBDevice): Promise<Maskrom> {
		if (!device.opened) await device.open();
		if (device.configuration === null) await device.selectConfiguration(1);

		const iface = device.configuration!.interfaces[0];
		const alternate = iface.alternates[0];
		let endpointIn: number | null = null;
		let endpointOut: number | null = null;
		for (const endpoint of alternate.endpoints) {
			if (endpoint.type !== 'bulk') continue;
			if (endpoint.direction === 'out' && endpointOut === null)
				endpointOut = endpoint.endpointNumber;
			if (endpoint.direction === 'in' && endpointIn === null) endpointIn = endpoint.endpointNumber;
		}
		if (endpointIn === null || endpointOut === null) {
			throw new Error('mask-ROM bulk endpoints not found');
		}
		await device.claimInterface(iface.interfaceNumber);
		return new Maskrom(device, endpointIn, endpointOut);
	}

	async close(): Promise<void> {
		await this.device.close().catch(() => {});
	}

	async bl2Boot(bl2: Bytes, fip: Bytes, onLog?: (message: string) => void): Promise<void> {
		onLog?.(`uploading BL2 (${bl2.byteLength} bytes)`);
		await this.writeLargeMemory(G12A_BL2_SRAM_ADDRESS, bl2, BL2_UPLOAD_BLOCK_BYTES, true);
		onLog?.('starting BL2');
		await this.run(G12A_BL2_SRAM_ADDRESS);
		await sleep(BL2_DDR_INIT_MS);

		let previousLength = -1;
		let previousOffset = -1;
		for (let seq = 0; ; seq++) {
			const { length, offset } = await this.getBootAmlc();
			const bl2RepeatedItsLastRequest = length === previousLength && offset === previousOffset;
			if (bl2RepeatedItsLastRequest) {
				onLog?.('bootloader accepted, device is starting');
				return;
			}
			previousLength = length;
			previousOffset = offset;
			if (offset + length > fip.byteLength) {
				throw new Error(
					`bootloader asked for bytes ${offset}..${offset + length} but the image is only ${fip.byteLength} bytes`
				);
			}
			await this.writeAmlcData(seq, offset, fip.subarray(offset, offset + length));
		}
	}

	private async controlOut(request: number, value: number, index: number, data?: BufferSource) {
		const setup: USBControlTransferParameters = {
			requestType: 'vendor',
			recipient: 'device',
			request,
			value: value & 0xffff,
			index: index & 0xffff
		};
		return data
			? this.device.controlTransferOut(setup, data)
			: this.device.controlTransferOut(setup);
	}

	private async bulkOut(data: BufferSource): Promise<USBOutTransferResult> {
		return this.device.transferOut(this.endpointOut, data);
	}

	private async bulkIn(length: number, timeoutMs: number): Promise<USBInTransferResult> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('USB read timed out')), timeoutMs);
		});
		try {
			return await Promise.race([this.device.transferIn(this.endpointIn, length), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async writeLargeMemory(
		address: number,
		data: Bytes,
		blockLength: number,
		appendZeros: boolean
	): Promise<void> {
		const chunkBytes = MAX_LARGE_BLOCK_COUNT * blockLength;
		for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
			const length = Math.min(chunkBytes, data.byteLength - offset);
			await this.writeLargeMemoryChunk(
				address + offset,
				data.subarray(offset, offset + length),
				blockLength,
				appendZeros
			);
		}
	}

	private async writeLargeMemoryChunk(
		address: number,
		data: Bytes,
		blockLength: number,
		appendZeros: boolean
	): Promise<void> {
		let body: Bytes = data;
		const remainder = data.byteLength % blockLength;
		if (remainder) {
			if (!appendZeros) throw new Error('large write must be a multiple of the block length');
			body = new Uint8Array(data.byteLength + (blockLength - remainder));
			body.set(data);
		}

		const blockCount = Math.ceil(body.byteLength / blockLength);
		const header = new DataView(new ArrayBuffer(16));
		header.setUint32(0, address >>> 0, true);
		header.setUint32(4, body.byteLength, true);
		await this.controlOut(REQ_WR_LARGE_MEM, blockLength, blockCount, header);

		for (let offset = 0; offset < body.byteLength; offset += blockLength) {
			await this.bulkOut(body.subarray(offset, Math.min(offset + blockLength, body.byteLength)));
		}
	}

	private async run(address: number): Promise<void> {
		const payload = new DataView(new ArrayBuffer(4));
		payload.setUint32(0, (address | FLAG_KEEP_POWER_ON) >>> 0, true);
		await this.controlOut(REQ_RUN_IN_ADDR, address >>> 16, address & 0xffff, payload);
	}

	private async readAmlcRequest(): Promise<USBInTransferResult> {
		try {
			return await this.bulkIn(AMLC_AMLS_BLOCK_LENGTH, AMLC_READ_TIMEOUT_MS);
		} catch {
			await this.device.clearHalt('in', this.endpointIn).catch(() => {});
			return this.bulkIn(AMLC_AMLS_BLOCK_LENGTH, AMLC_READ_TIMEOUT_MS);
		}
	}

	private async getBootAmlc(): Promise<{ length: number; offset: number }> {
		await this.controlOut(REQ_GET_AMLC, AMLC_AMLS_BLOCK_LENGTH, 0);

		const result = await this.readAmlcRequest();
		if (result.status !== 'ok' || !result.data) {
			throw new Error(`mask-ROM read failed (status ${result.status})`);
		}

		const view = result.data;
		const tag = asciiTag(view);
		if (tag !== 'AMLC') throw new Error(`unexpected mask-ROM reply '${tag}'`);

		const okay = new Uint8Array(16);
		okay.set(new TextEncoder().encode('OKAY'));
		await this.bulkOut(okay);

		return { length: view.getUint32(8, true), offset: view.getUint32(12, true) };
	}

	private async writeAmlcData(seq: number, amlcOffset: number, data: Bytes): Promise<void> {
		for (let offset = 0; offset < data.byteLength; offset += AMLC_MAX_TRANSFER_LENGTH) {
			const length = Math.min(AMLC_MAX_TRANSFER_LENGTH, data.byteLength - offset);
			await this.writeAmlcBlock(offset, data.subarray(offset, offset + length));
		}
		await this.writeAmlcBlock(amlcOffset, amlsTrailer(seq, data));
	}

	private async writeAmlcBlock(offset: number, data: Bytes): Promise<void> {
		const writeLength = data.byteLength;
		await this.controlOut(
			REQ_WRITE_AMLC,
			Math.floor(offset / AMLC_AMLS_BLOCK_LENGTH),
			writeLength - 1
		);

		for (let sent = 0; sent < writeLength;) {
			const blockLength = Math.min(writeLength - sent, AMLC_MAX_BLOCK_LENGTH);
			await this.bulkOut(data.subarray(sent, sent + blockLength));
			sent += blockLength;
		}

		const ack = await this.bulkIn(16, AMLC_ACK_TIMEOUT_MS);
		if (!ack.data) throw new Error('no acknowledgement from the bootloader');
		const tag = asciiTag(ack.data);
		if (tag !== 'OKAY') throw new Error(`bootloader rejected a chunk ('${tag}')`);
	}
}

function amlsTrailer(seq: number, data: Bytes): Bytes {
	const amls = new Uint8Array(AMLC_AMLS_BLOCK_LENGTH);
	amls.set(new TextEncoder().encode('AMLS'));
	amls[4] = seq & 0xff;
	new DataView(amls.buffer).setUint32(8, littleEndianWordSum(data), true);
	amls.set(data.subarray(16, AMLC_AMLS_BLOCK_LENGTH), 16);
	return amls;
}

function asciiTag(view: DataView): string {
	return String.fromCharCode(
		view.getUint8(0),
		view.getUint8(1),
		view.getUint8(2),
		view.getUint8(3)
	);
}

function littleEndianWordSum(data: Bytes): number {
	let sum = 0;
	for (let offset = 0; offset < data.byteLength; offset += 4) {
		const remaining = data.byteLength - offset;
		let word = data[offset];
		if (remaining >= 2) word |= data[offset + 1] << 8;
		if (remaining >= 3) word |= data[offset + 2] << 16;
		if (remaining >= 4) word |= data[offset + 3] << 24;
		sum = (sum + (word >>> 0)) >>> 0;
	}
	return sum;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
