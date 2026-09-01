// Amlogic mask-ROM USB protocol: the *only* amlogic code left in terbium.
//
// The SoC's boot ROM is burned in silicon and speaks nothing but this, so a
// stock (or bricked) Car Thing has to be met on its own terms exactly once.
// We use it for a single job: stream a mask-ROM-signed BL2 into SRAM, kick it
// off, and feed it our signed FIP over the AMLC handshake. Our u-boot then
// comes up in DRAM, notices it was booted over USB, and drops straight into
// fastboot, after which every other operation in terbium is fastboot.
//
// Deliberately *not* ported from the old amlogic path: bulkcmd, partition
// tables, restorePartition, writeUserArea, the whole vendor burn-mode u-boot.
// Those are all fastboot's job now.
//
// Ported from pyamlboot (https://github.com/superna9999/pyamlboot).

import type { Bytes } from '$lib/bytes';

export const MASKROM_VENDOR_ID = 0x1b8e;
export const MASKROM_PRODUCT_ID = 0xc003;

const REQ_WRITE_MEM = 0x01;
const REQ_RUN_IN_ADDR = 0x05;
const REQ_WR_LARGE_MEM = 0x11;
const REQ_GET_AMLC = 0x50;
const REQ_WRITE_AMLC = 0x60;

// pyamlboot ORs this into the run-address payload. Without it the mask ROM
// silently NOPs (no STALL, no error) and the following AMLC read hangs.
// Empirically required on G12A.
const FLAG_KEEP_POWER_ON = 0x10;

const AMLC_AMLS_BLOCK_LENGTH = 0x200; // 512
const AMLC_MAX_BLOCK_LENGTH = 0x4000; // 16 KiB
const AMLC_MAX_TRANSFER_LENGTH = 65536;
const MAX_LARGE_BLOCK_COUNT = 65535;

/** BL2's fixed SRAM load address on G12A. */
const ADDR_BL2 = 0xfffa0000;

/** BL2 needs this long after run() to bring up DDR before it can serve AMLC. */
const BL2_SETTLE_MS = 2000;

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
			if (endpoint.direction === 'out' && endpointOut === null) endpointOut = endpoint.endpointNumber;
			if (endpoint.direction === 'in' && endpointIn === null) endpointIn = endpoint.endpointNumber;
		}
		if (endpointIn === null || endpointOut === null) {
			throw new Error('mask-ROM bulk endpoints not found');
		}
		await device.claimInterface(iface.interfaceNumber);
		return new Maskrom(device, endpointIn, endpointOut);
	}

	get usbDevice(): USBDevice {
		return this.device;
	}

	async close(): Promise<void> {
		try {
			await this.device.close();
		} catch {
			// the device usually vanishes off the bus the moment BL2 launches
		}
	}

	/**
	 * Load BL2 into SRAM, start it, then service its AMLC requests for the FIP
	 * body. BL2 signals "I have everything, launching now" by repeating the
	 * (length, offset) pair it just asked for.
	 */
	async bl2Boot(bl2: Bytes, fip: Bytes, onLog?: (message: string) => void): Promise<void> {
		// 4096-byte blocks: BL2's reception loop in mask ROM expects that size,
		// not send_file's 512-byte default.
		onLog?.(`uploading BL2 (${bl2.byteLength} bytes)`);
		await this.writeLargeMemory(ADDR_BL2, bl2, 4096, true);
		onLog?.('starting BL2');
		await this.run(ADDR_BL2);
		await sleep(BL2_SETTLE_MS);

		let previousLength = -1;
		let previousOffset = -1;
		let seq = 0;
		for (;;) {
			const { length, offset } = await this.getBootAmlc();
			if (length === previousLength && offset === previousOffset) {
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
			seq += 1;
		}
	}

	// ---- low-level USB ------------------------------------------------------

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

	// WebUSB has no per-call timeout, so race the transfer against one.
	private async bulkIn(length: number, timeoutMs: number): Promise<USBInTransferResult> {
		const transfer = this.device.transferIn(this.endpointIn, length);
		if (!timeoutMs) return transfer;
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('USB read timed out')), timeoutMs);
		});
		try {
			return await Promise.race([transfer, timeout]);
		} finally {
			clearTimeout(timer!);
		}
	}

	// ---- pyamlboot-equivalent operations ------------------------------------

	async writeSimpleMemory(address: number, data: Bytes): Promise<void> {
		if (data.byteLength > 64) throw new Error('simple memory write is capped at 64 bytes');
		await this.controlOut(REQ_WRITE_MEM, address >>> 16, address & 0xffff, data);
	}

	async writeLargeMemory(
		address: number,
		data: Bytes,
		blockLength = 64,
		appendZeros = false
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
		// Header: address, length, then two reserved u32s, all little-endian.
		const header = new DataView(new ArrayBuffer(16));
		header.setUint32(0, address >>> 0, true);
		header.setUint32(4, body.byteLength, true);
		await this.controlOut(REQ_WR_LARGE_MEM, blockLength, blockCount, header);

		for (let offset = 0; offset < body.byteLength; offset += blockLength) {
			await this.bulkOut(body.subarray(offset, Math.min(offset + blockLength, body.byteLength)));
		}
	}

	/** Branch the ROM to `address`. Mask ROM checks both the setup packet and the body. */
	async run(address: number): Promise<void> {
		const payload = new DataView(new ArrayBuffer(4));
		payload.setUint32(0, (address | FLAG_KEEP_POWER_ON) >>> 0, true);
		await this.controlOut(REQ_RUN_IN_ADDR, address >>> 16, address & 0xffff, payload);
	}

	/** Read one AMLC chunk request from BL2 and ack it. */
	private async getBootAmlc(): Promise<{ length: number; offset: number }> {
		await this.controlOut(REQ_GET_AMLC, AMLC_AMLS_BLOCK_LENGTH, 0);

		let result: USBInTransferResult;
		try {
			result = await this.bulkIn(AMLC_AMLS_BLOCK_LENGTH, 5000);
		} catch {
			// A stalled IN endpoint right after BL2 launches is recoverable.
			try {
				await this.device.clearHalt('in', this.endpointIn);
			} catch {
				// nothing useful to do; the retry below will surface the real error
			}
			result = await this.bulkIn(AMLC_AMLS_BLOCK_LENGTH, 5000);
		}
		if (result.status !== 'ok' || !result.data) {
			throw new Error(`mask-ROM read failed (status ${result.status})`);
		}

		const view = result.data;
		// Layout: "AMLC" | 4 reserved | length:u32 | offset:u32
		const tag = String.fromCharCode(
			view.getUint8(0),
			view.getUint8(1),
			view.getUint8(2),
			view.getUint8(3)
		);
		if (tag !== 'AMLC') throw new Error(`unexpected mask-ROM reply '${tag}'`);

		const okay = new Uint8Array(16);
		okay.set([0x4f, 0x4b, 0x41, 0x59]); // "OKAY"
		await this.bulkOut(okay);

		return { length: view.getUint32(8, true), offset: view.getUint32(12, true) };
	}

	async writeAmlcData(seq: number, amlcOffset: number, data: Bytes): Promise<void> {
		for (let offset = 0; offset < data.byteLength; offset += AMLC_MAX_TRANSFER_LENGTH) {
			const length = Math.min(AMLC_MAX_TRANSFER_LENGTH, data.byteLength - offset);
			await this.writeAmlcBlock(offset, data.subarray(offset, offset + length));
		}

		// Closing AMLS marker: tag, sequence number, checksum over the whole
		// chunk, then bytes 16..512 of the chunk itself (pyamlboot does the same).
		const amls = new Uint8Array(AMLC_AMLS_BLOCK_LENGTH);
		amls.set([0x41, 0x4d, 0x4c, 0x53]); // "AMLS"
		amls[4] = seq & 0xff;
		new DataView(amls.buffer).setUint32(8, amlsChecksum(data), true);
		amls.set(data.subarray(16, AMLC_AMLS_BLOCK_LENGTH), 16);
		await this.writeAmlcBlock(amlcOffset, amls);
	}

	private async writeAmlcBlock(offset: number, data: Bytes): Promise<void> {
		const writeLength = data.byteLength;
		await this.controlOut(
			REQ_WRITE_AMLC,
			Math.floor(offset / AMLC_AMLS_BLOCK_LENGTH),
			writeLength - 1
		);

		for (let sent = 0; sent < writeLength; ) {
			const blockLength = Math.min(writeLength - sent, AMLC_MAX_BLOCK_LENGTH);
			await this.bulkOut(data.subarray(sent, sent + blockLength));
			sent += blockLength;
		}

		const ack = await this.bulkIn(16, 2000);
		if (!ack.data) throw new Error('no acknowledgement from the bootloader');
		const tag = String.fromCharCode(
			ack.data.getUint8(0),
			ack.data.getUint8(1),
			ack.data.getUint8(2),
			ack.data.getUint8(3)
		);
		if (tag !== 'OKAY') throw new Error(`bootloader rejected a chunk ('${tag}')`);
	}
}

/** Sum of little-endian u32 words; a short tail is zero-padded. */
function amlsChecksum(data: Bytes): number {
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
