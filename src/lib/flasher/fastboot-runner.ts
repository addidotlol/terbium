import { SUPERBIRD_PARTITIONS, type PartitionInfo } from 'libsuperbird';
import type { DataOrFile, FlashConfig, FlashStep } from 'libsuperbird/meta';
import type { Bytes } from '$lib/bytes';
import type { Fastboot } from '$lib/fastboot/client';
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
import { dataBytes, sleep, sparseFlag, stepLabel, textValue, type RunnerCallbacks } from './runner';
import { ProgressTracker, StreamChunker, type FlashProgress, type StreamSource } from './types';

const SECTOR_BYTES = 512;
const ERASE_GROUP_SECTORS = 8 * 1024;
const RAW_ALIAS = 'tb';
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const FASTBOOT_BUF_ADDR = 0x6000000;

const UPLOAD_PROGRESS_SHARE = 0.5;
const COMMIT_TICK_MS = 100;
const COMMIT_EASE_PER_TICK = 0.12;

const NO_ENV_PARTITION = /bad device specification|could ?n['o]t find|no partition/i;
const VENDOR_ONLY_COMMAND = /^(amlmmc\s+(key|part|partition)|disk_initial|store\s+(dtb|init))\b/i;
const VENDOR_EMMC_DEVICE_SELECT = /^(aml)?mmc\s+dev\s+1\b/i;

interface WriteOptions {
	sparse?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: FlashProgress) => void;
	onLog?: (message: string) => void;
}

function stockPartition(name: string): PartitionInfo | undefined {
	return (SUPERBIRD_PARTITIONS as Record<string, PartitionInfo | undefined>)[name];
}

export async function runFastbootFlash(
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
				const image = toBootImage(await dataBytes(archive, step.value.data));
				await writeBootHwpart(fastboot, step.value.hwpart, image, { signal, onProgress: emit });
				break;
			}

			case 'restorePartition': {
				const name = step.value.name;
				if (name === 'bootloader') {
					const image = toBootImage(await dataBytes(archive, step.value.data));
					await restoreBootloader(fastboot, image, { signal, onProgress: emit });
					break;
				}

				const source = await sourceFor(archive, step.value.data);
				const stock = stockPartition(name);
				if (!stock) {
					onLog?.(`${name} is not a stock partition, flashing it by GPT name`);
					await flashByName(fastboot, name, source, { signal, onProgress: emit });
					break;
				}
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
				break;
			}

			case 'writeEnv': {
				const text = await textValue(archive, step.value);
				const { saved } = await writeFastbootEnv(fastboot, text, { signal, onLog });
				if (!saved) {
					onLog?.('writing the environment to the stock env partition instead');
					const image = vendorEnvImage(parseEnvText(text));
					await flashRaw(fastboot, SUPERBIRD_PARTITIONS.env.offset, inlineSource(image), {
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
				if (translated !== step.value) onLog?.(`${step.value} -> ${translated}`);
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
				const stock = stockPartition(name);
				const size = stock
					? `${stock.size} sectors`
					: await fastboot.getvar(`partition-size:${name}`);
				onLog?.(`${name}: ${size}`);
				break;
			}

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

export async function withInfoSector(
	source: StreamSource,
	onLog?: (message: string) => void
): Promise<StreamSource> {
	const isWholeDiskImage = source.size > BOOT_IMAGE_BYTES;
	if (isWholeDiskImage) return source;

	const reader = source.stream.getReader();
	const pending: Uint8Array[] = [];
	let probed = 0;
	while (probed < INFO_SECTOR_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		pending.push(value);
		probed += value.byteLength;
	}

	const probe = new Uint8Array(probed);
	let offset = 0;
	for (const piece of pending) {
		probe.set(piece, offset);
		offset += piece.byteLength;
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

async function commitWithProgress(
	tracker: ProgressTracker,
	chunkBytes: number,
	commit: () => Promise<void>,
	onProgress?: (progress: FlashProgress) => void
): Promise<void> {
	let credited = chunkBytes * UPLOAD_PROGRESS_SHARE;
	const timer = setInterval(() => {
		credited += (chunkBytes - credited) * COMMIT_EASE_PER_TICK;
		onProgress?.(tracker.snapshot(credited));
	}, COMMIT_TICK_MS);
	try {
		await commit();
	} finally {
		clearInterval(timer);
	}
}

async function uploadAndFlash(
	fastboot: Fastboot,
	target: string,
	payload: Bytes,
	tracker: ProgressTracker,
	creditedBytes: number,
	options: WriteOptions
): Promise<void> {
	const { signal, onProgress } = options;
	await fastboot.download(payload, {
		signal,
		onProgress: (sent) => onProgress?.(tracker.snapshot(sent * UPLOAD_PROGRESS_SHARE))
	});
	await commitWithProgress(tracker, creditedBytes, () => fastboot.flash(target), onProgress);
	tracker.markWritten(creditedBytes);
	onProgress?.(tracker.snapshot());
}

async function restoreBootloader(
	fastboot: Fastboot,
	image: Bytes,
	options: WriteOptions
): Promise<void> {
	await flashRaw(fastboot, 0, inlineSource(image), options);
	await writeBootHwpart(fastboot, 1, image, options);
	await writeBootHwpart(fastboot, 2, image, options);
}

function trimToBootHwpart(image: Bytes): Bytes {
	if (image.byteLength <= BOOT_HWPART_BYTES) return image;
	if (!isAllZero(image.subarray(BOOT_HWPART_BYTES))) {
		throw new Error(
			`boot image carries content past ${BOOT_HWPART_BYTES} bytes and will not fit a 2 MiB boot hwpart`
		);
	}
	return image.subarray(0, BOOT_HWPART_BYTES);
}

async function writeBootHwpart(
	fastboot: Fastboot,
	hwpart: number,
	image: Bytes,
	options: WriteOptions = {}
): Promise<void> {
	if (hwpart !== 1 && hwpart !== 2) {
		throw new Error(`boot hwpart must be 1 or 2, got ${hwpart}`);
	}
	const ubootHwpartName = hwpart === 1 ? 'mmc0boot0' : 'mmc0boot1';
	const payload = trimToBootHwpart(image);
	const tracker = new ProgressTracker(payload.byteLength);
	await uploadAndFlash(fastboot, ubootHwpartName, payload, tracker, payload.byteLength, options);
	await fastboot.selectHwpart(0);
}

async function eraseWholeGroupsIn(
	fastboot: Fastboot,
	startLba: number,
	byteLength: number,
	onLog?: (message: string) => void
): Promise<{ from: number; to: number }> {
	const nothingErased = { from: 0, to: 0 };
	const spanSectors = Math.ceil(byteLength / SECTOR_BYTES);
	const eraseStart = Math.ceil(startLba / ERASE_GROUP_SECTORS) * ERASE_GROUP_SECTORS;
	const eraseEnd = Math.floor((startLba + spanSectors) / ERASE_GROUP_SECTORS) * ERASE_GROUP_SECTORS;

	if (eraseEnd <= eraseStart) {
		onLog?.(`sparse write at sector ${startLba} spans no whole erase group; writing it in full`);
		return nothingErased;
	}
	try {
		await fastboot.setRawTarget(RAW_ALIAS, eraseStart, eraseEnd - eraseStart);
		await fastboot.erase(RAW_ALIAS);
		return {
			from: (eraseStart - startLba) * SECTOR_BYTES,
			to: (eraseEnd - startLba) * SECTOR_BYTES
		};
	} catch (error) {
		onLog?.(`erase failed (${describe(error)}); writing every chunk instead of skipping zeroes`);
		return nothingErased;
	}
}

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

	const erased = sparse
		? await eraseWholeGroupsIn(fastboot, startLba, source.size, onLog)
		: { from: 0, to: 0 };

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

			const alreadyErased = chunkStart >= erased.from && chunkStart + length <= erased.to;
			if (alreadyErased && isAllZero(chunk)) {
				tracker.markSkipped(length);
				onProgress?.(tracker.snapshot());
				lba += sectors;
				continue;
			}

			await fastboot.setRawTarget(RAW_ALIAS, lba, sectors);
			await uploadAndFlash(fastboot, RAW_ALIAS, padToSector(chunk), tracker, length, options);
			lba += sectors;
		}
	} finally {
		await chunker.cancel();
		await fastboot.clearRawTarget(RAW_ALIAS).catch(() => {});
	}
}

async function flashByName(
	fastboot: Fastboot,
	name: string,
	source: StreamSource,
	options: WriteOptions = {}
): Promise<void> {
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
		await uploadAndFlash(fastboot, name, bytes, tracker, source.size, options);
	} finally {
		await chunker.cancel();
	}
}

export async function writeFastbootEnv(
	fastboot: Fastboot,
	env: string,
	options: { signal?: AbortSignal; save?: boolean; onLog?: (message: string) => void } = {}
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

export function translateVendorCommand(command: string): string | null {
	const trimmed = command.trim();
	if (VENDOR_ONLY_COMMAND.test(trimmed)) return null;
	if (VENDOR_EMMC_DEVICE_SELECT.test(trimmed)) return 'mmc dev 0 0';
	if (/^amlmmc\b/i.test(trimmed)) return trimmed.replace(/^amlmmc\b/i, 'mmc');
	return trimmed;
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
