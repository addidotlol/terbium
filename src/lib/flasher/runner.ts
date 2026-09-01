// Translation layer: v2 flash archives → fastboot.
//
// Flash archives are written against the amlogic vendor burn-mode protocol
// (bulkcmd, writeUserArea, restorePartition, …). Terbium no longer speaks it;
// the device runs our mainline u-boot and answers fastboot. Rather than break
// every published archive, each v2 step is translated into the equivalent
// fastboot operation here. The mapping:
//
//   writeUserArea       raw LBA write via a `fastboot_raw_partition_*` alias
//   writeBootPartition  flash:mmc0boot0 / flash:mmc0boot1  (+ hwpart reset)
//   restorePartition    the stock partition's LBA range, else a GPT name
//   ├─ named bootloader info sector + image, to user-area LBA 0 and both hwparts
//   writeEnv            download + `env import -t` + `saveenv`, falling back to a
//                       vendor-format image at the stock env LBA on amlogic layouts
//   bulkcmd             rewritten vendor command via `oem console`
//   identify            getvar
//   bl2Boot & friends   dropped, the bootstrap happens at connect time
//
// Raw writes deliberately go through `flash:` rather than `mmc write`: u-boot
// then does its own bounds checking and sparse-image handling, and we get one
// round trip per chunk instead of two.

import type { DataOrFile, FlashConfig, FlashStep, StringOrFile } from 'libsuperbird/meta';
import type { Bytes } from '$lib/bytes';
import { Fastboot } from '$lib/fastboot/client';
import {
	BOOT_HWPART_BYTES,
	BOOT_IMAGE_BYTES,
	INFO_SECTOR_BYTES,
	infoSector,
	needsInfoSector,
	toBootImage
} from '$lib/fastboot/boot-image';
import { parseEnvText, vendorEnvImage } from '$lib/fastboot/uboot-env';
import type { FlashArchive } from './archive';
import { ProgressTracker, StreamChunker, type FlashProgress, type StreamSource } from './types';

export interface StepEvent {
	stepIndex: number;
	totalSteps: number;
	label: string;
	progress?: FlashProgress;
}

export interface RunnerCallbacks {
	onStep?: (event: StepEvent) => void;
	onLog?: (message: string) => void;
	signal?: AbortSignal;
	forceSparse?: boolean;
}

const SECTOR_BYTES = 512;

/**
 * eMMC erase-group size in sectors: 4 MiB, from HC_ERASE_GRP_SIZE 0x08 with
 * ERASE_GROUP_DEF set on the superbird's eMMC. A sparse write can only erase
 * whole groups; a partial one at either end would take neighbouring data with it.
 */
const ERASE_GROUP_SECTORS = 8 * 1024;

/**
 * Alias used for raw-LBA writes. Kept to two characters on purpose: the whole
 * `oem console setenv fastboot_raw_partition_tb <lba> <sectors>` line has to
 * fit in u-boot's 64-byte fastboot command buffer.
 */
const RAW_ALIAS = 'tb';

/**
 * Host-side chunk ceiling.
 *
 * The device would accept 112 MiB (CONFIG_FASTBOOT_BUF_SIZE), but a chunk is a
 * strictly serialized round trip: upload, then a blocking `flash:` while the
 * eMMC commits it, with no progress reported for the second half. At 32 MiB
 * that write is a 3-5 second dead stop; at 8 MiB it's under a second, which
 * reads as continuous. The extra `setenv`+`flash` round trips cost microseconds
 * each, and total transfer time is unchanged either way.
 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** CONFIG_FASTBOOT_BUF_ADDR on our u-boot, where a download lands in DRAM. */
const FASTBOOT_BUF_ADDR = 0x6000000;

/**
 * Share of a chunk's progress credited to the upload half of its round trip.
 *
 * A chunk is uploaded and then committed to eMMC, and only the upload reports
 * bytes; `flash:` returns nothing until the write is done. Crediting the
 * upload with the whole chunk would park the bar at the chunk boundary for the
 * entire commit. Holding back half leaves room for `commitWithProgress` to keep
 * it moving, and the two halves take roughly comparable time in practice.
 */
const UPLOAD_SHARE = 0.5;

/** How often the bar advances while waiting on a commit. */
const COMMIT_TICK_MS = 100;

/** Fraction of the remaining gap closed per tick, asymptotic so it never overshoots. */
const COMMIT_EASE = 0.12;

/**
 * Run a blocking `flash:` while easing the progress bar across the share of the
 * chunk that the upload didn't claim.
 *
 * The device gives no progress signal during a commit and we can't know ahead
 * of time how long it takes, so the bar eases toward the chunk boundary
 * asymptotically: a quick write ends after a couple of ticks, a slow one keeps
 * crawling without ever reaching (and therefore never overstating) the end of
 * the chunk. The real value lands the moment `flash:` returns.
 */
async function commitWithProgress(
	tracker: ProgressTracker,
	chunkBytes: number,
	commit: () => Promise<void>,
	onProgress?: (progress: FlashProgress) => void
): Promise<void> {
	let credited = chunkBytes * UPLOAD_SHARE;
	const timer = setInterval(() => {
		credited += (chunkBytes - credited) * COMMIT_EASE;
		onProgress?.(tracker.snapshot(credited));
	}, COMMIT_TICK_MS);
	try {
		await commit();
	} finally {
		clearInterval(timer);
	}
}

/**
 * Stock amlogic user-area layout, in 512-byte sectors. `restorePartition`
 * is a vendor-layout concept, so a step naming one of these means the stock
 * offsets, not whatever GPT the device happens to be carrying right now.
 */
const STOCK_PARTITIONS: Record<string, { offset: number; size: number }> = {
	bootloader: { offset: 0, size: 4096 },
	reserved: { offset: 73728, size: 131072 },
	cache: { offset: 221184, size: 0 },
	env: { offset: 237568, size: 16384 },
	fip_a: { offset: 270336, size: 8192 },
	fip_b: { offset: 294912, size: 8192 },
	logo: { offset: 319488, size: 16384 },
	dtbo_a: { offset: 352256, size: 8192 },
	dtbo_b: { offset: 376832, size: 8192 },
	vbmeta_a: { offset: 401408, size: 2048 },
	vbmeta_b: { offset: 419840, size: 2048 },
	boot_a: { offset: 438272, size: 32768 },
	boot_b: { offset: 487424, size: 32768 },
	system_a: { offset: 536576, size: 1056856 },
	system_b: { offset: 1609816, size: 1056856 },
	misc: { offset: 2683056, size: 16384 },
	settings: { offset: 2715824, size: 524288 },
	data: { offset: 3256496, size: 4476752 }
};

export function stepLabel(step: FlashStep): string {
	switch (step.type) {
		case 'bulkcmd':
		case 'bulkcmdStat':
			return `running command: ${step.value}`;
		case 'restorePartition':
			return `flashing ${step.value.name}`;
		case 'writeBootPartition':
			return `writing boot${step.value.hwpart - 1} bootloader`;
		case 'writeUserArea':
			return `writing disk image at sector ${step.value.lba}`;
		case 'writeEnv':
			return 'writing environment';
		case 'identify':
			return 'identifying the device';
		case 'validatePartitionSize':
			return `checking ${step.value.name}`;
		case 'log':
			return step.value;
		case 'wait':
			return 'waiting';
		default:
			return (step as FlashStep).type;
	}
}

function weightOf(step: FlashStep, archive: FlashArchive): number {
	const file = fileOf(step);
	if (file && archive.has(file)) return archive.entries.get(file)!.uncompressedSize;
	return 64 * 1024;
}

function fileOf(step: FlashStep): string | undefined {
	switch (step.type) {
		case 'restorePartition':
		case 'writeUserArea':
		case 'writeBootPartition':
		case 'writeSimpleMemory':
		case 'writeLargeMemory':
		case 'writeAMLCData': {
			const data = step.value.data;
			return typeof data === 'object' && 'filePath' in data ? data.filePath : undefined;
		}
		case 'writeEnv':
			return typeof step.value === 'object' ? step.value.filePath : undefined;
		default:
			return undefined;
	}
}

export function stepWeights(config: FlashConfig, archive: FlashArchive): number[] {
	return config.steps.map((step) => weightOf(step, archive));
}

async function dataBytes(archive: FlashArchive, data: DataOrFile): Promise<Bytes> {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.bytesOf(data.filePath);
}

async function textValue(archive: FlashArchive, value: StringOrFile): Promise<string> {
	if (typeof value === 'string') return value;
	return archive.textOf(value.filePath);
}

/** Present an in-memory buffer as a StreamSource, so it can go through `flashRaw`. */
function inlineSource(bytes: Bytes): StreamSource {
	return {
		size: bytes.byteLength,
		stream: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		})
	};
}

async function sourceFor(archive: FlashArchive, data: DataOrFile): Promise<StreamSource> {
	if (Array.isArray(data)) return inlineSource(new Uint8Array(data));
	return archive.sourceOf(data.filePath);
}

/**
 * Leading bytes we need in hand to tell a bare bootloader image from a prepared
 * one, a whole sector, since the test is "does an info sector start here?".
 */
const BOOTLOADER_PROBE_BYTES = INFO_SECTOR_BYTES;

/**
 * Give a bootloader image its info sector on the way to LBA 0, if it hasn't got
 * one already.
 *
 * A raw write at LBA 0 is a bootloader write: that's where the mask ROM looks,
 * and it expects a 512-byte info sector first, with BL2 itself starting at LBA
 * 1. Vendor u-boot builds that sector as part of `amlmmc write bootloader`, so
 * archives written against burn mode carry a *bare* dump and never mention it.
 * Written raw here every byte lands one sector early, and the device sits at a
 * black screen with the whole image reading back correct, the most expensive
 * mistake available on this path.
 *
 * Rather than require every published archive be rebuilt, we sniff for it: a
 * payload already carrying an info sector goes through untouched, anything else
 * gets one.
 *
 * Sniffing alone is not enough, though. A whole-disk image such as `unbrick.bin`
 * also starts at LBA 0, and its own first sector is high-entropy rather than an
 * info sector, so it reads as bare too, and prepending 512 bytes would shift 64
 * MiB of disk image by a sector and ruin it. The size bound is what separates
 * the two: a bootloader never exceeds the boot hwpart size, a whole-disk image
 * always does.
 */
export async function withInfoSector(
	source: StreamSource,
	onLog?: (message: string) => void
): Promise<StreamSource> {
	// too big to be a bootloader, so it is a whole-disk image and must not move
	if (source.size > BOOT_IMAGE_BYTES) return source;

	const reader = source.stream.getReader();
	const pending: Uint8Array[] = [];
	let probed = 0;
	while (probed < BOOTLOADER_PROBE_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		pending.push(value);
		probed += value.byteLength;
	}

	const probe = new Uint8Array(probed);
	for (let offset = 0, index = 0; index < pending.length; index++) {
		probe.set(pending[index], offset);
		offset += pending[index].byteLength;
	}

	const bare = needsInfoSector(probe);
	if (bare) {
		onLog?.('the bootloader image has no info sector, adding one so BL2 lands at sector 1');
		pending.unshift(infoSector());
	}

	return {
		size: bare ? source.size + INFO_SECTOR_BYTES : source.size,
		stream: new ReadableStream<Uint8Array>({
			async pull(controller) {
				const buffered = pending.shift();
				if (buffered) {
					controller.enqueue(buffered);
					return;
				}
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			}
		})
	};
}

export async function runFlashConfig(
	fastboot: Fastboot,
	config: FlashConfig,
	archive: FlashArchive,
	callbacks: RunnerCallbacks = {}
): Promise<void> {
	const { onStep, onLog, signal, forceSparse } = callbacks;
	const totalSteps = config.steps.length;

	for (const [stepIndex, step] of config.steps.entries()) {
		signal?.throwIfAborted();
		const emit = (progress?: FlashProgress) =>
			onStep?.({ stepIndex, totalSteps, label: stepLabel(step), progress });
		emit();
		const sparse = sparseFlag(step) || forceSparse === true;

		switch (step.type) {
			case 'log':
				onLog?.(step.value);
				break;

			case 'wait':
				if (step.value.type === 'time') await sleep(step.value.time);
				break;

			case 'writeUserArea': {
				let source = await sourceFor(archive, step.value.data);
				// A bootloader-sized raw write at LBA 0 is a bootloader write, and
				// burn-mode archives carry a bare dump because vendor u-boot built the
				// info sector for them. Add it here if it's missing; whole-disk images
				// landing at LBA 0 are left alone.
				if (step.value.lba === 0) source = await withInfoSector(source, onLog);
				await flashRaw(fastboot, step.value.lba, source, {
					sparse,
					signal,
					onProgress: emit,
					onLog
				});
				break;
			}

			case 'writeBootPartition': {
				const data = await dataBytes(archive, step.value.data);
				// A bare bootloader dump gets its info sector here; an image that
				// already has one is written as-is.
				await writeBootHwpart(fastboot, step.value.hwpart, toBootImage(data), {
					signal,
					onProgress: emit
				});
				break;
			}

			case 'restorePartition': {
				const name = step.value.name;

				if (name === 'bootloader') {
					// Not a partition write: the image needs an info sector, and goes to
					// the user-area mirror at LBA 0 and to both boot hwparts. A raw write
					// here would land a sector early and leave the hwparts empty.
					//
					// Both hwparts, not just boot0: stock ships EXT_CSD PARTITION_CONFIG
					// = 0x50, which points the mask ROM at boot1, so a device still
					// carrying that value with an empty boot1 would rest the whole
					// restore on the user-area mirror being reached first.
					const image = toBootImage(await dataBytes(archive, step.value.data));
					await flashRaw(fastboot, 0, inlineSource(image), { signal, onProgress: emit });
					await writeBootHwpart(fastboot, 1, image, { signal, onProgress: emit });
					await writeBootHwpart(fastboot, 2, image, { signal, onProgress: emit });
					break;
				}

				const source = await sourceFor(archive, step.value.data);
				const stock = STOCK_PARTITIONS[name];
				if (stock) {
					const limit = stock.size * SECTOR_BYTES;
					if (stock.size > 0 && source.size > limit) {
						throw new Error(
							`${name} image is ${source.size} bytes but the partition only holds ${limit}`
						);
					}
					await flashRaw(fastboot, stock.offset, source, {
						sparse,
						signal,
						onProgress: emit,
						onLog
					});
				} else {
					// Not a stock partition, assume the device's GPT names it.
					onLog?.(`${name} is not a stock partition, flashing it by GPT name`);
					await flashByName(fastboot, name, source, { signal, onProgress: emit });
				}
				break;
			}

			case 'writeEnv': {
				const text = await textValue(archive, step.value);
				const { saved } = await writeEnv(fastboot, text, { signal, onLog });
				if (!saved) {
					// The vendor bootloader this archive restores reads the stock env
					// partition, which our saveenv can't reach; hand it an image in
					// its own format instead.
					onLog?.('writing the environment to the stock env partition instead');
					const image = vendorEnvImage(parseEnvText(text));
					await flashRaw(fastboot, STOCK_PARTITIONS.env.offset, inlineSource(image), {
						signal,
						onProgress: emit
					});
				}
				break;
			}

			case 'bulkcmd':
			case 'bulkcmdStat': {
				const translated = translateVendorCommand(step.value);
				if (!translated) {
					onLog?.(`skipping vendor-only command: ${step.value}`);
					break;
				}
				if (translated !== step.value) {
					onLog?.(`${step.value} -> ${translated}`);
				}
				const output = await fastboot.console(translated);
				if (output.trim()) onLog?.(output);
				if (/unknown command/i.test(output)) {
					throw new Error(`the bootloader does not understand "${translated}"`);
				}
				break;
			}

			case 'identify': {
				const version = await fastboot.getvar('version-bootloader').catch(() => 'unknown');
				const product = await fastboot.getvar('product').catch(() => 'unknown');
				onLog?.(`device: ${product}, bootloader ${version}`);
				break;
			}

			case 'validatePartitionSize': {
				const name = step.value.name;
				const stock = STOCK_PARTITIONS[name];
				if (stock) {
					onLog?.(`${name}: ${stock.size} sectors`);
					break;
				}
				const size = await fastboot.getvar(`partition-size:${name}`);
				onLog?.(`${name}: ${size}`);
				break;
			}

			// Mask-ROM-only steps. An archive carrying these is describing its own
			// bootstrap, which terbium now performs at connect time instead; by
			// the time we get here the device is already running our u-boot.
			// The memory writes also show up as staging for a vendor `store`
			// command, which is dropped by translateVendorCommand.
			case 'bl2Boot':
			case 'run':
			case 'writeSimpleMemory':
			case 'writeLargeMemory':
			case 'writeAMLCData':
			case 'getBootAMLC':
				onLog?.(`skipping ${step.type}: the device is already booted into fastboot`);
				break;

			case 'readSimpleMemory':
			case 'readLargeMemory':
				throw new Error(`${step.type} has no fastboot equivalent`);

			default:
				throw new Error(`unsupported step type: ${(step as FlashStep).type}`);
		}
	}
}

interface WriteOptions {
	sparse?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: FlashProgress) => void;
	onLog?: (message: string) => void;
}

/**
 * Write an already-prepared boot image to an eMMC boot hwpart, then put the
 * hwpart selection back.
 *
 * The image must already be in on-disk form, see `$lib/fastboot/boot-image`.
 */
async function writeBootHwpart(
	fastboot: Fastboot,
	hwpart: number,
	image: Bytes,
	options: WriteOptions = {}
): Promise<void> {
	const { signal, onProgress } = options;
	// mmc0boot0 / mmc0boot1 are u-boot's names for the eMMC boot hwparts.
	if (hwpart !== 1 && hwpart !== 2) {
		throw new Error(`boot hwpart must be 1 or 2, got ${hwpart}`);
	}
	const target = hwpart === 1 ? 'mmc0boot0' : 'mmc0boot1';

	// Sized for the smaller of the two boot hwparts in the wild; the tail of a
	// stock dump is zero padding. Real content past the bound would be silently
	// lost, so refuse instead.
	let payload = image;
	if (payload.byteLength > BOOT_HWPART_BYTES) {
		if (!isAllZero(payload.subarray(BOOT_HWPART_BYTES))) {
			throw new Error(
				`boot image carries content past ${BOOT_HWPART_BYTES} bytes and will not fit a 2 MiB boot hwpart`
			);
		}
		payload = payload.subarray(0, BOOT_HWPART_BYTES);
	}

	const tracker = new ProgressTracker(payload.byteLength);
	await fastboot.download(payload, {
		signal,
		onProgress: (sent) => onProgress?.(tracker.snapshot(sent * UPLOAD_SHARE))
	});
	await commitWithProgress(tracker, payload.byteLength, () => fastboot.flash(target), onProgress);
	tracker.markWritten(payload.byteLength);
	onProgress?.(tracker.snapshot());

	// Flashing a boot hwpart leaves it selected; anything touching the user area
	// next would land in the wrong place.
	await fastboot.selectHwpart(0);
}

/**
 * Write a stream to a raw LBA range, one download-buffer-sized chunk at a time.
 *
 * Each chunk points the throwaway `tb` alias at its own sector range and then
 * flashes it, so u-boot handles the actual block writes.
 *
 * `sparse` means what it means on the amlogic path: the whole-erase-group span
 * of the target range is erased up front, and chunks that are entirely zero and
 * land inside that span are then skipped rather than written, since the erase
 * has already put them where the image wants them. That's what makes a 64 MiB
 * unbrick image or a mostly-empty rootfs finish in a fraction of the time
 * *without* leaving stale bytes behind. If the erase fails the skipping is
 * abandoned and every chunk is written, so a zero in the image is never
 * silently a no-op.
 */
async function flashRaw(
	fastboot: Fastboot,
	startLba: number,
	source: StreamSource,
	options: WriteOptions = {}
): Promise<void> {
	const { sparse, signal, onProgress, onLog } = options;
	const limit = await fastboot.maxDownloadSize();
	const chunkBytes =
		Math.max(1, Math.floor(Math.min(limit, MAX_CHUNK_BYTES) / SECTOR_BYTES)) * SECTOR_BYTES;

	// Only the whole erase groups strictly inside the range can be erased; a
	// partial group at either end would take neighbouring data with it. Byte
	// offsets, relative to the start of the payload.
	let erasedFrom = 0;
	let erasedTo = 0;
	if (sparse) {
		const spanSectors = Math.ceil(source.size / SECTOR_BYTES);
		const eraseStart = Math.ceil(startLba / ERASE_GROUP_SECTORS) * ERASE_GROUP_SECTORS;
		const eraseEnd =
			Math.floor((startLba + spanSectors) / ERASE_GROUP_SECTORS) * ERASE_GROUP_SECTORS;

		if (eraseEnd > eraseStart) {
			try {
				await fastboot.setRawTarget(RAW_ALIAS, eraseStart, eraseEnd - eraseStart);
				await fastboot.erase(RAW_ALIAS);
				erasedFrom = (eraseStart - startLba) * SECTOR_BYTES;
				erasedTo = (eraseEnd - startLba) * SECTOR_BYTES;
			} catch (error) {
				// Better to spend the bandwidth than to leave the caller's zeroes unwritten.
				onLog?.(
					`erase failed (${describe(error)}); writing every chunk instead of skipping zeroes`
				);
			}
		} else {
			onLog?.(`sparse write at sector ${startLba} spans no whole erase group; writing it in full`);
		}
	}

	const chunker = new StreamChunker(source.stream);
	const tracker = new ProgressTracker(source.size);
	let lba = startLba;
	let offset = 0;

	try {
		while (offset < source.size) {
			signal?.throwIfAborted();
			const length = Math.min(chunkBytes, source.size - offset);
			const chunk = await chunker.read(length);
			const chunkStart = offset;
			offset += length;
			const sectors = Math.ceil(length / SECTOR_BYTES);

			// Only skippable where the up-front erase has already laid the zeroes down.
			const erased = chunkStart >= erasedFrom && chunkStart + length <= erasedTo;
			if (erased && isAllZero(chunk)) {
				tracker.markSkipped(length);
				onProgress?.(tracker.snapshot());
				lba += sectors;
				continue;
			}

			await fastboot.setRawTarget(RAW_ALIAS, lba, sectors);
			await fastboot.download(padToSector(chunk), {
				signal,
				onProgress: (sent) => onProgress?.(tracker.snapshot(sent * UPLOAD_SHARE))
			});
			await commitWithProgress(tracker, length, () => fastboot.flash(RAW_ALIAS), onProgress);
			tracker.markWritten(length);
			onProgress?.(tracker.snapshot());
			lba += sectors;
		}
	} finally {
		await chunker.cancel();
		// Leave no stray alias behind: a later `flash tb` would otherwise hit a
		// stale range instead of failing loudly.
		await fastboot.clearRawTarget(RAW_ALIAS).catch(() => {});
	}
}

/**
 * Flash a partition the device resolves itself (a GPT name). Unlike a raw
 * write we can't split this across chunks (u-boot restarts at the partition
 * start for every `flash:`), so the image has to fit the download buffer.
 */
async function flashByName(
	fastboot: Fastboot,
	name: string,
	source: StreamSource,
	options: WriteOptions = {}
): Promise<void> {
	const { signal, onProgress } = options;
	const limit = await fastboot.maxDownloadSize();
	if (source.size > limit) {
		throw new Error(
			`${name} is ${source.size} bytes, larger than the device's ${limit}-byte download buffer; it needs to be a sparse image`
		);
	}

	const chunker = new StreamChunker(source.stream);
	const tracker = new ProgressTracker(source.size);
	try {
		const bytes = await chunker.read(source.size);
		await fastboot.download(bytes, {
			signal,
			onProgress: (sent) => onProgress?.(tracker.snapshot(sent * UPLOAD_SHARE))
		});
		await commitWithProgress(tracker, source.size, () => fastboot.flash(name), onProgress);
		tracker.markWritten(source.size);
		onProgress?.(tracker.snapshot());
	} finally {
		await chunker.cancel();
	}
}

/**
 * Import a `key=value` environment into u-boot and persist it.
 *
 * The text goes into the download buffer and `env import -t` parses it in
 * place, which sidesteps the 64-byte command limit that a `setenv` per
 * variable would keep running into. Our u-boot keeps its environment in
 * `uboot.env` on the FAT `env` partition, so `saveenv` is what makes it stick.
 *
 * That lookup goes through the GPT, and mainline u-boot cannot read the amlogic
 * partition table. An archive restoring a vendor layout therefore leaves no
 * `env` partition we can see and `saveenv` has nowhere to go, which is an
 * expected outcome of that restore rather than a failed flash, so it's reported
 * and stepped over with `saved: false`; the caller decides whether the vendor
 * env partition needs writing by hand (see `vendorEnvImage`). The import
 * itself still applied to the running u-boot.
 */
export async function writeEnv(
	fastboot: Fastboot,
	env: string,
	options: {
		signal?: AbortSignal;
		save?: boolean;
		onLog?: (message: string) => void;
	} = {}
): Promise<{ saved: boolean }> {
	const normalised = env.endsWith('\n') ? env : `${env}\n`;
	const bytes = new TextEncoder().encode(normalised);
	await fastboot.download(bytes, { signal: options.signal });
	const output = await fastboot.console(
		`env import -t 0x${FASTBOOT_BUF_ADDR.toString(16)} ${bytes.byteLength}`
	);
	if (/error|failed|unknown command/i.test(output)) {
		throw new Error(`the bootloader rejected the environment: ${output.trim()}`);
	}
	if (options.save === false) return { saved: false };
	const saved = await fastboot.console('saveenv');
	if (NO_ENV_PARTITION.test(saved)) {
		options.onLog?.(
			'there is no env partition this bootloader can see, so saveenv had nowhere to go; ' +
				'expected when the image being restored uses the amlogic partition table'
		);
		return { saved: false };
	}
	if (/error|failed/i.test(saved)) {
		throw new Error(`saving the environment failed: ${saved.trim()}`);
	}
	return { saved: true };
}

/**
 * u-boot's complaints when `saveenv` can't resolve `mmc 0#env`: the partition
 * isn't in the GPT, because the device is carrying an amlogic table instead.
 */
const NO_ENV_PARTITION = /bad device specification|could ?n['o]t find|no partition/i;

/**
 * Rewrite a vendor burn-mode u-boot command for our u-boot, or return null if
 * it has no meaning here.
 *
 * Only a handful of differences matter in practice. Vendor burn-mode reaches
 * the eMMC as `mmc dev 1`; ours is `mmc dev 0`. The `amlmmc` command is the
 * vendor's fork of `mmc` and its partition/key subcommands operate on an
 * amlogic partition table that our layout doesn't have. Anything unrecognised
 * is passed through, u-boot will say so if it doesn't know the command.
 */
export function translateVendorCommand(command: string): string | null {
	const trimmed = command.trim();

	// Vendor partition-table / key-enclave setup: no equivalent, and nothing
	// downstream depends on it once we're writing raw LBAs. `store dtb write`
	// commits a dtb staged in RAM by a (skipped) writeLargeMemory into the
	// amlogic dtb slots, and `store init` re-reads the partition table out of
	// it; archives that do this restore those slots by raw LBA anyway.
	if (/^(amlmmc\s+(key|part|partition)|disk_initial|store\s+(dtb|init))\b/i.test(trimmed)) {
		return null;
	}

	// Vendor burn-mode numbers the eMMC as device 1.
	if (/^mmc\s+dev\s+1\b/i.test(trimmed)) return 'mmc dev 0 0';
	if (/^amlmmc\s+dev\s+1\b/i.test(trimmed)) return 'mmc dev 0 0';

	// Everything else amlmmc does that we care about (read/write/erase) has the
	// same argument shape as plain mmc.
	if (/^amlmmc\b/i.test(trimmed)) return trimmed.replace(/^amlmmc\b/i, 'mmc');

	return trimmed;
}

function sparseFlag(step: FlashStep): boolean {
	if (!('value' in step) || typeof step.value !== 'object' || step.value === null) return false;
	return (step.value as { sparse?: boolean }).sparse === true;
}

function isAllZero(data: Bytes): boolean {
	for (let i = 0; i < data.byteLength; i++) {
		if (data[i] !== 0) return false;
	}
	return true;
}

function padToSector(data: Bytes): Bytes {
	const remainder = data.byteLength % SECTOR_BYTES;
	if (remainder === 0) return data;
	const padded = new Uint8Array(data.byteLength + (SECTOR_BYTES - remainder));
	padded.set(data);
	return padded;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
