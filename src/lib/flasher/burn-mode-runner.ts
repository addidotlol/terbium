import type { PartitionName, Superbird } from 'libsuperbird';
import type { DataOrFile, FlashConfig, FlashStep } from 'libsuperbird/meta';
import type { FlashArchive } from './archive';
import { dataBytes, sleep, sparseFlag, stepLabel, textValue, type RunnerCallbacks } from './runner';
import type { FlashProgress } from './types';

export async function runBurnModeFlash(
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
		const sparse = sparseFlag(step) || forceSparse === true;

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
					sparse
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
				await bird.writeUserArea(step.value.lba, source, { onProgress: emit, signal, sparse });
				break;
			}
			case 'writeEnv':
				await bird.writeEnv(await textValue(archive, step.value));
				break;
			case 'log':
				onLog?.(step.value);
				break;
			case 'wait':
				if (step.value.type === 'time') await sleep(step.value.time);
				break;
			default:
				throw new Error(`unsupported step type: ${(step as FlashStep).type}`);
		}
	}
}

async function sourceFor(archive: FlashArchive, data: DataOrFile) {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.sourceOf(data.filePath);
}
