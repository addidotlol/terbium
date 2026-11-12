import type { DataOrFile, FlashConfig, FlashStep, StringOrFile } from 'libsuperbird/meta';
import type { Bytes } from '$lib/bytes';
import type { FlashArchive } from './archive';
import type { FlashProgress } from './types';

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
		case 'bulkcmdStat':
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

export async function dataBytes(archive: FlashArchive, data: DataOrFile): Promise<Bytes> {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.bytesOf(data.filePath);
}

export async function textValue(archive: FlashArchive, value: StringOrFile): Promise<string> {
	if (typeof value === 'string') return value;
	return archive.textOf(value.filePath);
}

export function sparseFlag(step: FlashStep): boolean {
	if (!('value' in step) || typeof step.value !== 'object' || step.value === null) return false;
	return (step.value as { sparse?: boolean }).sparse === true;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
