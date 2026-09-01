// Android fastboot client over WebUSB.
//
// Wire protocol: a command is a single ASCII string of at most 64 bytes on the
// bulk OUT endpoint. The device answers with one or more 64-byte packets on
// the bulk IN endpoint, each carrying a 4-character tag:
//
//   INFO<text>     informational, keep reading
//   TEXT<text>     continuation of the previous INFO (rare)
//   OKAY<payload>  terminal success
//   FAIL<reason>   terminal failure
//   DATA<8 hex>    device is ready to receive that many bytes
//
// Everything terbium does to a device running our mainline u-boot goes through
// here. See src/lib/flasher/runner.ts for how flash archives are translated
// into these calls.

import type { Bytes } from '$lib/bytes';

export const FASTBOOT_VENDOR_ID = 0x18d1;
export const FASTBOOT_PRODUCT_ID = 0xfada;

const INTERFACE_CLASS = 0xff;
const INTERFACE_SUBCLASS = 0x42;
const INTERFACE_PROTOCOL = 0x03;

/** u-boot's FASTBOOT_COMMAND_LEN. Commands over this are silently truncated. */
export const MAX_COMMAND_BYTES = 64;

const PACKET_BYTES = 64;

/** Bulk OUT slice size during a download. 1 MiB is the sweet spot on Chrome. */
const TRANSFER_CHUNK_BYTES = 1024 * 1024;

/** Fallback when the device doesn't report `max-download-size`. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 0x7000000; // 112 MiB, u-boot's default

export interface FastbootReply {
	ok: boolean;
	/** Every INFO line, in order. u-boot sends one console line per packet. */
	info: string[];
	/** Payload of the terminal OKAY/FAIL. */
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

		// Match on class/subclass/protocol rather than taking interface 0: our
		// u-boot only exposes fastboot, but a device also offering adb would
		// otherwise be a coin flip.
		for (const iface of device.configuration!.interfaces) {
			for (const alternate of iface.alternates) {
				if (
					alternate.interfaceClass !== INTERFACE_CLASS ||
					alternate.interfaceSubclass !== INTERFACE_SUBCLASS ||
					alternate.interfaceProtocol !== INTERFACE_PROTOCOL
				) {
					continue;
				}
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
		try {
			await this.device.releaseInterface(this.interfaceNumber);
		} catch {
			// already gone
		}
		try {
			await this.device.close();
		} catch {
			// already gone
		}
	}

	// ---- protocol primitives ------------------------------------------------

	/** Send one command and read packets until OKAY or FAIL. Never throws on FAIL. */
	async send(command: string): Promise<FastbootReply> {
		const bytes = new TextEncoder().encode(command);
		if (bytes.byteLength > MAX_COMMAND_BYTES) {
			throw new Error(
				`fastboot command is ${bytes.byteLength} bytes, over the ${MAX_COMMAND_BYTES}-byte limit: ${command}`
			);
		}
		await this.device.transferOut(this.endpointOut, bytes);
		return this.readReply();
	}

	/** Send one command and throw unless it comes back OKAY. */
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
				// Continuation of the previous line rather than a new one.
				if (info.length) info[info.length - 1] += body;
				else info.push(body);
				continue;
			}
			if (tag === 'OKAY') return { ok: true, info, response: body };
			if (tag === 'FAIL') return { ok: false, info, response: body };
			throw new Error(`unexpected fastboot reply tag '${tag}'`);
		}
	}

	// ---- commands -----------------------------------------------------------

	async getvar(name: string): Promise<string> {
		const reply = await this.send(`getvar:${name}`);
		if (!reply.ok) throw new FastbootError(`getvar:${name}`, reply.response);
		return reply.response;
	}

	/** Largest single download the device will accept, cached after the first ask. */
	async maxDownloadSize(): Promise<number> {
		if (this.maxDownload !== null) return this.maxDownload;
		try {
			const raw = await this.getvar('max-download-size');
			const value = Number.parseInt(raw.trim(), raw.trim().startsWith('0x') ? 16 : 10);
			this.maxDownload = Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_DOWNLOAD_BYTES;
		} catch {
			this.maxDownload = DEFAULT_MAX_DOWNLOAD_BYTES;
		}
		return this.maxDownload;
	}

	/**
	 * Upload a buffer into the device's scratch buffer (CONFIG_FASTBOOT_BUF_ADDR,
	 * 0x6000000 on our u-boot). The data stays there until the next download, so
	 * a following `flash:` (or an `oem console` reading that address) sees it.
	 */
	async download(
		data: Bytes,
		options: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}
	): Promise<void> {
		const { onProgress, signal } = options;
		const size = data.byteLength;
		if (size === 0) throw new Error('refusing to download an empty image');

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const command = `download:${size.toString(16).padStart(8, '0')}`;
		await this.device.transferOut(this.endpointOut, encoder.encode(command));

		const ack = await this.device.transferIn(this.endpointIn, PACKET_BYTES);
		const ackText = ack.data ? decoder.decode(ack.data) : '';
		if (!ackText.startsWith('DATA')) {
			throw new FastbootError(command, ackText.slice(4) || ackText || 'no reply');
		}
		const accepted = Number.parseInt(ackText.slice(4, 12), 16);
		if (accepted !== size) {
			throw new Error(`the device accepted ${accepted} bytes but we offered ${size}`);
		}

		for (let sent = 0; sent < size; ) {
			signal?.throwIfAborted();
			const end = Math.min(sent + TRANSFER_CHUNK_BYTES, size);
			await this.device.transferOut(this.endpointOut, data.subarray(sent, end));
			sent = end;
			onProgress?.(sent, size);
		}

		const final = await this.readReply();
		if (!final.ok) throw new FastbootError(command, final.response);
	}

	/** Write whatever was last downloaded to a partition (GPT name, raw alias, or mmc0boot0/1). */
	async flash(partition: string): Promise<void> {
		await this.expect(`flash:${partition}`);
	}

	async erase(partition: string): Promise<void> {
		await this.expect(`erase:${partition}`);
	}

	/**
	 * Run a u-boot command and return its console output.
	 *
	 * `oem console <cmd>` resets u-boot's console ring buffer, runs the command,
	 * then replays the buffer as INFO packets, so it's execute-and-read in a
	 * single round trip. Note it reports the *drain* succeeding, not the command:
	 * a u-boot command that fails still comes back OKAY, with the complaint in
	 * the output. Callers that care have to read the text.
	 */
	async console(command: string): Promise<string> {
		const full = `oem console ${command}`;
		const reply = await this.send(full);
		if (!reply.ok) throw new FastbootError(full, reply.response);
		return reply.info.join('\n');
	}

	/** Drain whatever u-boot has printed since the last reset, running nothing. */
	async drainConsole(): Promise<string> {
		const reply = await this.send('oem console');
		return reply.info.join('\n');
	}

	/**
	 * Point a throwaway fastboot partition alias at a raw LBA range so plain
	 * `flash:` can write anywhere on the eMMC.
	 *
	 * u-boot resolves an unknown flash target by looking up
	 * `fastboot_raw_partition_<name>` = "<start_lba> <sector_count>", which
	 * means we get its sparse-image handling and bounds checks for free instead
	 * of hand-rolling `mmc write`. The alias is deliberately short: the whole
	 * command has to fit in 64 bytes.
	 */
	async setRawTarget(alias: string, startLba: number, sectorCount: number): Promise<void> {
		await this.console(`setenv fastboot_raw_partition_${alias} ${startLba} ${sectorCount}`);
	}

	async clearRawTarget(alias: string): Promise<void> {
		await this.console(`setenv fastboot_raw_partition_${alias}`);
	}

	/**
	 * Select an eMMC hardware partition (0 = user area, 1 = boot0, 2 = boot1).
	 *
	 * Flashing mmc0boot0/mmc0boot1 leaves the hwpart selected, so anything that
	 * touches the user area afterwards has to switch back or it writes into a
	 * boot partition. Always pair a boot-partition write with a hwpart 0 reset.
	 */
	async selectHwpart(hwpart: 0 | 1 | 2): Promise<void> {
		await this.console(`mmc dev 0 ${hwpart}`);
	}

	async reboot(): Promise<void> {
		await this.expect('reboot');
	}

	async rebootBootloader(): Promise<void> {
		await this.expect('reboot-bootloader');
	}

	/** Hand the device back to the boot ROM (1b8e:c003) via our u-boot's `oem maskrom`. */
	async rebootMaskrom(): Promise<void> {
		await this.expect('oem maskrom');
	}

	async continueBoot(): Promise<void> {
		await this.expect('continue');
	}

	async setActiveSlot(slot: string): Promise<void> {
		await this.expect(`set_active:${slot}`);
	}
}
