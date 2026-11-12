import type { Bytes } from '$lib/bytes';

export const FASTBOOT_VENDOR_ID = 0x18d1;
export const FASTBOOT_PRODUCT_ID = 0xfada;

const INTERFACE_CLASS = 0xff;
const INTERFACE_SUBCLASS = 0x42;
const INTERFACE_PROTOCOL = 0x03;

const UBOOT_FASTBOOT_COMMAND_LEN = 64;
const PACKET_BYTES = 64;
const TRANSFER_CHUNK_BYTES = 1024 * 1024;
const UBOOT_DEFAULT_MAX_DOWNLOAD_BYTES = 0x7000000;

export interface FastbootReply {
	ok: boolean;
	info: string[];
	response: string;
}

export class FastbootError extends Error {
	readonly command: string;

	constructor(command: string, reason: string) {
		super(reason ? `${command}: ${reason}` : `${command} failed`);
		this.name = 'FastbootError';
		this.command = command;
	}
}

export function isFastbootDevice(device: USBDevice): boolean {
	return device.vendorId === FASTBOOT_VENDOR_ID && device.productId === FASTBOOT_PRODUCT_ID;
}

function isFastbootInterface(alternate: USBAlternateInterface): boolean {
	return (
		alternate.interfaceClass === INTERFACE_CLASS &&
		alternate.interfaceSubclass === INTERFACE_SUBCLASS &&
		alternate.interfaceProtocol === INTERFACE_PROTOCOL
	);
}

export class Fastboot {
	private readonly device: USBDevice;
	private readonly interfaceNumber: number;
	private readonly endpointIn: number;
	private readonly endpointOut: number;
	private maxDownload: number | null = null;

	private constructor(
		device: USBDevice,
		interfaceNumber: number,
		endpointIn: number,
		endpointOut: number
	) {
		this.device = device;
		this.interfaceNumber = interfaceNumber;
		this.endpointIn = endpointIn;
		this.endpointOut = endpointOut;
	}

	static async open(device: USBDevice): Promise<Fastboot> {
		if (!device.opened) await device.open();
		if (device.configuration === null) await device.selectConfiguration(1);

		for (const iface of device.configuration!.interfaces) {
			for (const alternate of iface.alternates) {
				if (!isFastbootInterface(alternate)) continue;
				let endpointIn: number | null = null;
				let endpointOut: number | null = null;
				for (const endpoint of alternate.endpoints) {
					if (endpoint.type !== 'bulk') continue;
					if (endpoint.direction === 'in') endpointIn = endpoint.endpointNumber;
					if (endpoint.direction === 'out') endpointOut = endpoint.endpointNumber;
				}
				if (endpointIn === null || endpointOut === null) continue;
				await device.claimInterface(iface.interfaceNumber);
				return new Fastboot(device, iface.interfaceNumber, endpointIn, endpointOut);
			}
		}
		throw new Error('this device is not in fastboot mode');
	}

	get usbDevice(): USBDevice {
		return this.device;
	}

	async close(): Promise<void> {
		await this.device.releaseInterface(this.interfaceNumber).catch(() => {});
		await this.device.close().catch(() => {});
	}

	async send(command: string): Promise<FastbootReply> {
		const bytes = new TextEncoder().encode(command);
		if (bytes.byteLength > UBOOT_FASTBOOT_COMMAND_LEN) {
			throw new Error(
				`fastboot command is ${bytes.byteLength} bytes, over the ${UBOOT_FASTBOOT_COMMAND_LEN}-byte limit: ${command}`
			);
		}
		await this.device.transferOut(this.endpointOut, bytes);
		return this.readReply();
	}

	async expect(command: string): Promise<FastbootReply> {
		const reply = await this.send(command);
		if (!reply.ok) throw new FastbootError(command, reply.response);
		return reply;
	}

	private async readReply(): Promise<FastbootReply> {
		const decoder = new TextDecoder();
		const info: string[] = [];
		for (;;) {
			const result = await this.device.transferIn(this.endpointIn, PACKET_BYTES);
			if (!result.data || result.data.byteLength < 4) {
				throw new Error('the device sent a truncated fastboot reply');
			}
			const text = decoder.decode(result.data);
			const tag = text.slice(0, 4);
			const body = text.slice(4);
			if (tag === 'INFO') {
				info.push(body);
				continue;
			}
			if (tag === 'TEXT') {
				if (info.length) info[info.length - 1] += body;
				else info.push(body);
				continue;
			}
			if (tag === 'OKAY') return { ok: true, info, response: body };
			if (tag === 'FAIL') return { ok: false, info, response: body };
			throw new Error(`unexpected fastboot reply tag '${tag}'`);
		}
	}

	async getvar(name: string): Promise<string> {
		const reply = await this.expect(`getvar:${name}`);
		return reply.response;
	}

	async maxDownloadSize(): Promise<number> {
		if (this.maxDownload !== null) return this.maxDownload;
		try {
			const raw = (await this.getvar('max-download-size')).trim();
			const value = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
			this.maxDownload =
				Number.isFinite(value) && value > 0 ? value : UBOOT_DEFAULT_MAX_DOWNLOAD_BYTES;
		} catch {
			this.maxDownload = UBOOT_DEFAULT_MAX_DOWNLOAD_BYTES;
		}
		return this.maxDownload;
	}

	async download(
		data: Bytes,
		options: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}
	): Promise<void> {
		const { onProgress, signal } = options;
		const size = data.byteLength;
		if (size === 0) throw new Error('refusing to download an empty image');

		const command = `download:${size.toString(16).padStart(8, '0')}`;
		await this.device.transferOut(this.endpointOut, new TextEncoder().encode(command));

		const ack = await this.device.transferIn(this.endpointIn, PACKET_BYTES);
		const ackText = ack.data ? new TextDecoder().decode(ack.data) : '';
		if (!ackText.startsWith('DATA')) {
			throw new FastbootError(command, ackText.slice(4) || ackText || 'no reply');
		}
		const accepted = Number.parseInt(ackText.slice(4, 12), 16);
		if (accepted !== size) {
			throw new Error(`the device accepted ${accepted} bytes but we offered ${size}`);
		}

		for (let sent = 0; sent < size;) {
			signal?.throwIfAborted();
			const end = Math.min(sent + TRANSFER_CHUNK_BYTES, size);
			await this.device.transferOut(this.endpointOut, data.subarray(sent, end));
			sent = end;
			onProgress?.(sent, size);
		}

		const final = await this.readReply();
		if (!final.ok) throw new FastbootError(command, final.response);
	}

	async flash(partition: string): Promise<void> {
		await this.expect(`flash:${partition}`);
	}

	async erase(partition: string): Promise<void> {
		await this.expect(`erase:${partition}`);
	}

	async console(command: string): Promise<string> {
		const reply = await this.expect(`oem console ${command}`);
		return reply.info.join('\n');
	}

	async setRawTarget(alias: string, startLba: number, sectorCount: number): Promise<void> {
		await this.console(`setenv fastboot_raw_partition_${alias} ${startLba} ${sectorCount}`);
	}

	async clearRawTarget(alias: string): Promise<void> {
		await this.console(`setenv fastboot_raw_partition_${alias}`);
	}

	async selectHwpart(hwpart: 0 | 1 | 2): Promise<void> {
		await this.console(`mmc dev 0 ${hwpart}`);
	}
}
