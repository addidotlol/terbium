// The on-disk form of the amlogic bootloader.
//
// A stock `bootloader.dump` is a bare bootloader image: signed BL2 first, then
// the FIP. That is *not* what the SoC expects to find on eMMC. Both places a
// bootloader lives (the eMMC boot hwparts and the user-area mirror at LBA 0)
// hold a 512-byte info sector first, so that BL2 itself begins at LBA 1. The
// mask ROM reads BL2 from LBA 1, not LBA 0.
//
// Vendor u-boot builds that info sector itself, which is why `amlmmc write
// bootloader` can be handed a bare dump. Nothing outside vendor u-boot does, so
// anything writing a bootloader over fastboot (or any other raw path) has to
// prepend it: a bare dump written at offset 0 puts every byte one sector early
// and simply will not boot, while reading back byte-perfect.

import type { Bytes } from '$lib/bytes';

/** Size of the info sector, and therefore the offset the bootloader image itself sits at. */
export const INFO_SECTOR_BYTES = 512;

/**
 * Largest a bootloader image is taken to be, and the cap on what `toBootImage`
 * returns.
 *
 * This is the size of a stock `bootloader.dump`, so it is also the right bound
 * for "is this payload a bootloader or a whole-disk image?", which is what
 * `withInfoSector` uses it for. It is *not* what gets written to a boot
 * hwpart; see `BOOT_HWPART_BYTES`.
 */
export const BOOT_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * How much of a boot image is written to an eMMC boot hwpart.
 *
 * `BOOT_SIZE_MULT` is factory-set per eMMC chip and Car Things exist with both
 * 4 MiB and 2 MiB boot hwparts. A 4 MiB write to a 2 MiB part is rejected
 * outright (`MMC: block number 0x1001 exceeds max(0x1000)`), so everything is
 * sized for the smaller one. Nothing is lost: an info sector plus a real
 * bootloader comes to about 1.3 MiB and the rest of a stock dump is zero
 * padding. Content past this bound is an error rather than a silent truncation.
 */
export const BOOT_HWPART_BYTES = 2 * 1024 * 1024;

/**
 * First bytes of the *stock* Car Thing BL2.
 *
 * Kept only as a cross-check and a landmark when reading hex dumps. It is
 * tempting to use as an "is this a bare image?" test, since every bootloader we
 * shipped starts with it, but they are all derived from the same stock BL2,
 * and BL2 is encrypted, so these are one build's first ciphertext block rather
 * than a magic. A differently-signed bootloader (an 8.9.2 thinglabs dump, say)
 * shares none of it. Testing for it treats every other build as already
 * prepared, which is the one mistake on this path that produces a black screen.
 */
export const STOCK_BL2_PREFIX = [0x0c, 0x62, 0x7a, 0x15, 0xbe, 0x94, 0x07, 0xb2];

/** Offset past the info sector's defined fields; everything from here is reserved. */
const INFO_SECTOR_RESERVED_FROM = 0x18;

/**
 * Whether `data` already opens with an info sector.
 *
 * Detecting the sector is far more reliable than detecting the bootloader
 * behind it. BL2 is encrypted, so its leading bytes differ per build and per
 * signing key and can't be recognised at all; an info sector is a fixed shape:
 * a handful of small header fields, ~480 bytes of zero padding, and a checksum
 * of everything ahead of it in the last word. High-entropy ciphertext does not
 * accidentally take that shape.
 *
 * An all-zero sector passes too, which is intended: that is what `unbrick.bin`
 * and other whole-disk images carry at LBA 0, and it boots.
 */
function hasInfoSector(data: Bytes): boolean {
	if (data.byteLength < INFO_SECTOR_BYTES) return false;
	for (let offset = INFO_SECTOR_RESERVED_FROM; offset < INFO_SECTOR_BYTES - 4; offset++) {
		if (data[offset] !== 0) return false;
	}

	const view = new DataView(data.buffer, data.byteOffset, INFO_SECTOR_BYTES);
	let checksum = 0;
	for (let offset = 0; offset < INFO_SECTOR_BYTES - 4; offset += 4) {
		checksum = (checksum + view.getUint32(offset, true)) >>> 0;
	}
	return checksum === view.getUint32(INFO_SECTOR_BYTES - 4, true);
}

/**
 * Build the info sector for a Car Thing.
 *
 * This is amlogic's `storage_emmc_boot_info`. BL2 never reads it; its only job
 * is to occupy LBA 0 as a spacer, and an all-zero sector boots just as well,
 * but a well-formed one is free and keeps the image byte-compatible with vendor
 * tooling. The values are the ones read off a Car Thing that boots.
 */
export function infoSector(): Uint8Array {
	const sector = new Uint8Array(INFO_SECTOR_BYTES);
	const view = new DataView(sector.buffer);

	view.setUint32(0x000, 1, true); // version
	view.setUint32(0x004, 0x12000, true); // rsv_base_addr, in sectors: the reserved region at 36 MiB
	view.setUint32(0x008, 0, true); // dtb.addr, vendor leaves these zero
	view.setUint32(0x00c, 0, true); // dtb.size
	view.setUint32(0x010, 0x4000, true); // ddr.addr, in sectors, relative to the reserved region
	view.setUint32(0x014, 4, true); // ddr.size, in sectors

	// The checksum is a wrapping sum of every u32 ahead of it, and lives in the last one.
	let checksum = 0;
	for (let offset = 0; offset < INFO_SECTOR_BYTES - 4; offset += 4) {
		checksum = (checksum + view.getUint32(offset, true)) >>> 0;
	}
	view.setUint32(INFO_SECTOR_BYTES - 4, checksum, true);

	return sector;
}

/**
 * Whether `data` is a bare bootloader image that still needs an info sector in
 * front of it, i.e. anything that isn't already carrying one.
 *
 * Defaulting to "bare" is deliberate. Getting it wrong in this direction writes
 * a spurious 512 bytes ahead of an image that didn't need it, which is visible
 * immediately; getting it wrong the other way puts a whole bootloader one sector
 * early, where every byte reads back correct and the device just never boots.
 */
export function needsInfoSector(data: Bytes): boolean {
	return !hasInfoSector(data);
}

/**
 * Put a bootloader image into the form the SoC expects to find on eMMC.
 *
 * A bare image gets an info sector prepended; one that already has it is passed
 * through untouched, so callers can hand this either a stock `bootloader.dump`
 * or a pre-built boot-partition image without having to know which.
 */
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
