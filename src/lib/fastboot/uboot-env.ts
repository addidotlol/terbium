// Vendor u-boot environment image, for devices carrying the amlogic
// partition table. Mainline u-boot can't `saveenv` there (no GPT `env`
// partition to resolve), so the image is built here and raw-written to the
// stock env partition instead. Layout, verified against a stock dump:
//
//   0x0000  uint32 LE  crc32 of the data area
//   0x0004  data       "key=value\0" entries, an empty string ends the list,
//                      zero-padded to the env size
//
// No redundancy flag byte: vendor builds without CONFIG_SYS_REDUNDAND_ENVIRONMENT.

import type { Bytes } from '$lib/bytes';

/** CONFIG_ENV_SIZE of the vendor u-boot. */
export const VENDOR_ENV_BYTES = 0x10000;

let crcTable: Uint32Array | undefined;

export function crc32(data: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.byteLength; i++) {
		crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parse `env import -t` text: one `key=value` per line, blank lines and
 * `#` comments ignored, a trailing backslash continues onto the next line.
 * Later duplicates win, as they do in u-boot.
 */
export function parseEnvText(text: string): Map<string, string> {
	const vars = new Map<string, string>();
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		while (line.endsWith('\\') && i + 1 < lines.length) {
			line = line.slice(0, -1) + '\n' + lines[++i];
		}
		const trimmed = line.trimStart();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) throw new Error(`environment line has no "key=value": ${trimmed}`);
		vars.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
	}
	return vars;
}

/** Serialise `vars` the way vendor u-boot's `saveenv` would. */
export function vendorEnvImage(vars: Map<string, string>, size = VENDOR_ENV_BYTES): Bytes {
	// u-boot exports sorted by key, which keeps our image byte-identical to
	// one it would have written itself.
	const keys = [...vars.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const body = keys.map((k) => `${k}=${vars.get(k)}\0`).join('') + '\0';
	const data = new TextEncoder().encode(body);
	const image = new Uint8Array(new ArrayBuffer(size));
	if (data.byteLength > size - 4) {
		throw new Error(
			`environment is ${data.byteLength} bytes, the vendor env area holds ${size - 4}`
		);
	}
	image.set(data, 4);
	new DataView(image.buffer).setUint32(0, crc32(image.subarray(4)), true);
	return image;
}
