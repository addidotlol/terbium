import type { Bytes } from '$lib/bytes';

export const VENDOR_ENV_BYTES = 0x10000;

const CRC_BYTES = 4;

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

export function vendorEnvImage(vars: Map<string, string>, size = VENDOR_ENV_BYTES): Bytes {
	const keysInUbootExportOrder = [...vars.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const body = keysInUbootExportOrder.map((key) => `${key}=${vars.get(key)}\0`).join('') + '\0';
	const data = new TextEncoder().encode(body);
	if (data.byteLength > size - CRC_BYTES) {
		throw new Error(
			`environment is ${data.byteLength} bytes, the vendor env area holds ${size - CRC_BYTES}`
		);
	}
	const image = new Uint8Array(new ArrayBuffer(size));
	image.set(data, CRC_BYTES);
	new DataView(image.buffer).setUint32(0, crc32(image.subarray(CRC_BYTES)), true);
	return image;
}
