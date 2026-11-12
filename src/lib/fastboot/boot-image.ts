import type { Bytes } from '$lib/bytes';

export const INFO_SECTOR_BYTES = 512;
export const BOOT_IMAGE_BYTES = 4 * 1024 * 1024;
export const BOOT_HWPART_BYTES = 2 * 1024 * 1024;

const INFO_SECTOR_RESERVED_FROM = 0x18;
const INFO_SECTOR_CHECKSUM_OFFSET = INFO_SECTOR_BYTES - 4;

function wordSumBeforeChecksum(view: DataView): number {
	let checksum = 0;
	for (let offset = 0; offset < INFO_SECTOR_CHECKSUM_OFFSET; offset += 4) {
		checksum = (checksum + view.getUint32(offset, true)) >>> 0;
	}
	return checksum;
}

function hasInfoSector(data: Bytes): boolean {
	if (data.byteLength < INFO_SECTOR_BYTES) return false;
	for (let offset = INFO_SECTOR_RESERVED_FROM; offset < INFO_SECTOR_CHECKSUM_OFFSET; offset++) {
		if (data[offset] !== 0) return false;
	}
	const view = new DataView(data.buffer, data.byteOffset, INFO_SECTOR_BYTES);
	return wordSumBeforeChecksum(view) === view.getUint32(INFO_SECTOR_CHECKSUM_OFFSET, true);
}

export function infoSector(): Bytes {
	const sector = new Uint8Array(INFO_SECTOR_BYTES);
	const view = new DataView(sector.buffer);

	const version = 1;
	const reservedRegionSector = 0x12000;
	const ddrSectorInReservedRegion = 0x4000;
	const ddrSectors = 4;

	view.setUint32(0x000, version, true);
	view.setUint32(0x004, reservedRegionSector, true);
	view.setUint32(0x008, 0, true);
	view.setUint32(0x00c, 0, true);
	view.setUint32(0x010, ddrSectorInReservedRegion, true);
	view.setUint32(0x014, ddrSectors, true);
	view.setUint32(INFO_SECTOR_CHECKSUM_OFFSET, wordSumBeforeChecksum(view), true);

	return sector;
}

export function needsInfoSector(data: Bytes): boolean {
	return !hasInfoSector(data);
}

export function toBootImage(data: Bytes): Bytes {
	if (!needsInfoSector(data)) {
		return data.subarray(0, Math.min(data.byteLength, BOOT_IMAGE_BYTES)).slice();
	}

	const length = Math.min(data.byteLength + INFO_SECTOR_BYTES, BOOT_IMAGE_BYTES);
	const image = new Uint8Array(length);
	image.set(infoSector());
	image.set(data.subarray(0, length - INFO_SECTOR_BYTES), INFO_SECTOR_BYTES);
	return image;
}
