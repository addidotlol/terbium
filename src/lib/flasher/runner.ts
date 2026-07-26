import type { FlashProgress, PartitionName, Superbird } from 'libsuperbird';
import type { DataOrFile, FlashConfig, FlashStep, StringOrFile } from 'libsuperbird/meta';
import type { FlashArchive } from './archive';

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

export function stepLabel(step: FlashStep): string {
	switch (step.type) {
		case 'bulkcmd':
			return `running command: ${step.value}`;
		case 'run':
			return `executing at 0x${step.value.address.toString(16)}`;
		case 'writeSimpleMemory':
		case 'writeLargeMemory':
			return `writing memory at 0x${step.value.address.toString(16)}`;
		case 'writeAMLCData':
			return 'writing AMLC data';
		case 'bl2Boot':
			return 'booting bootloader';
		case 'restorePartition':
			return `flashing ${step.value.name}`;
		case 'writeBootPartition':
			return `writing boot${step.value.hwpart - 1} bootloader`;
		case 'writeUserArea':
			return `writing disk image at sector ${step.value.lba}`;
		case 'writeEnv':
			return 'writing environment';
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

async function dataBytes(archive: FlashArchive, data: DataOrFile): Promise<Uint8Array> {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.bytesOf(data.filePath);
}

async function textValue(archive: FlashArchive, value: StringOrFile): Promise<string> {
	if (typeof value === 'string') return value;
	return archive.textOf(value.filePath);
}

export async function runFlashConfig(
	bird: Superbird,
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

		switch (step.type) {
			case 'bulkcmd':
				await bird.bulkcmd(step.value);
				break;
			case 'run':
				await bird.run(step.value.address, step.value.keepPower ?? true);
				break;
			case 'writeSimpleMemory':
				await bird.writeMemory(step.value.address, await dataBytes(archive, step.value.data));
				break;
			case 'writeLargeMemory':
				await bird.writeLargeMemory(
					step.value.address,
					await dataBytes(archive, step.value.data),
					step.value.blockLength,
					step.value.appendZeros ?? true
				);
				break;
			case 'writeAMLCData':
				await bird.writeAmlcDataPacket(
					step.value.seq,
					step.value.amlcOffset,
					await dataBytes(archive, step.value.data)
				);
				break;
			case 'bl2Boot':
				await bird.bl2Boot(
					await dataBytes(archive, step.value.bl2),
					await dataBytes(archive, step.value.bootloader)
				);
				break;
			case 'restorePartition': {
				const source = await sourceFor(archive, step.value.data);
				await bird.restorePartition(step.value.name as PartitionName, source, {
					onProgress: emit,
					signal,
					sparse: sparseFlag(step) || forceSparse === true
				});
				break;
			}
			case 'writeBootPartition':
				await bird.writeBootPartition(
					step.value.hwpart as 1 | 2,
					await dataBytes(archive, step.value.data)
				);
				break;
			case 'writeUserArea': {
				const source = await sourceFor(archive, step.value.data);
				await bird.writeUserArea(step.value.lba, source, {
					onProgress: emit,
					signal,
					sparse: sparseFlag(step) || forceSparse === true
				});
				break;
			}
			case 'writeEnv':
				await bird.writeEnv(await textValue(archive, step.value));
				break;
			case 'log':
				onLog?.(step.value);
				break;
			case 'wait': {
				const wait = step.value;
				if (wait.type === 'time') {
					await new Promise((resolve) => setTimeout(resolve, wait.time));
				}
				break;
			}
			default:
				throw new Error(`unsupported step type: ${(step as FlashStep).type}`);
		}
	}
}

async function sourceFor(archive: FlashArchive, data: DataOrFile) {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.sourceOf(data.filePath);
}

function sparseFlag(step: FlashStep): boolean {
	if (!('value' in step) || typeof step.value !== 'object' || step.value === null) return false;
	return (step.value as { sparse?: boolean }).sparse === true;
}
