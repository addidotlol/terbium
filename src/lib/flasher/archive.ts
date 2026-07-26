import { parseFlashConfig } from 'libsuperbird/meta';
import type { FlashConfig, FlashStep } from 'libsuperbird/meta';
import { STOCK_META } from 'libsuperbird/meta';
import type { StreamSource } from 'libsuperbird';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ArchiveEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

async function bytesAt(blob: Blob, start: number, length: number): Promise<DataView> {
	const buffer = await blob.slice(start, start + length).arrayBuffer();
	return new DataView(buffer);
}

function readUint64(view: DataView, offset: number): number {
	const value = view.getBigUint64(offset, true);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip value exceeds safe integer');
	return Number(value);
}

async function findCentralDirectory(blob: Blob): Promise<{ offset: number; size: number }> {
	const tailLength = Math.min(blob.size, 65557 + 20);
	const tailStart = blob.size - tailLength;
	const tail = await bytesAt(blob, tailStart, tailLength);

	let eocdPos = -1;
	for (let i = tailLength - 22; i >= 0; i--) {
		if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
			eocdPos = i;
			break;
		}
	}
	if (eocdPos < 0) throw new Error('not a zip file (no end-of-central-directory record)');

	let size = tail.getUint32(eocdPos + 12, true);
	let offset = tail.getUint32(eocdPos + 16, true);

	if (size === 0xffffffff || offset === 0xffffffff) {
		let locatorPos = -1;
		for (let i = eocdPos - 20; i >= 0; i--) {
			if (tail.getUint32(i, true) === EOCD64_LOCATOR_SIGNATURE) {
				locatorPos = i;
				break;
			}
		}
		if (locatorPos < 0) throw new Error('zip64 locator not found');
		const eocd64Offset = readUint64(tail, locatorPos + 8);
		const eocd64 = await bytesAt(blob, eocd64Offset, 56);
		if (eocd64.getUint32(0, true) !== EOCD64_SIGNATURE) throw new Error('invalid zip64 record');
		size = readUint64(eocd64, 40);
		offset = readUint64(eocd64, 48);
	}

	return { offset, size };
}

function parseCentralDirectory(directory: DataView): ArchiveEntry[] {
	const decoder = new TextDecoder();
	const entries: ArchiveEntry[] = [];
	let pos = 0;
	while (
		pos + 46 <= directory.byteLength &&
		directory.getUint32(pos, true) === CENTRAL_HEADER_SIGNATURE
	) {
		const method = directory.getUint16(pos + 10, true);
		let compressedSize: number = directory.getUint32(pos + 20, true);
		let uncompressedSize: number = directory.getUint32(pos + 24, true);
		const nameLength = directory.getUint16(pos + 28, true);
		const extraLength = directory.getUint16(pos + 30, true);
		const commentLength = directory.getUint16(pos + 32, true);
		let localHeaderOffset: number = directory.getUint32(pos + 42, true);
		const name = decoder.decode(
			new Uint8Array(directory.buffer, directory.byteOffset + pos + 46, nameLength)
		);

		let extraPos = pos + 46 + nameLength;
		const extraEnd = extraPos + extraLength;
		while (extraPos + 4 <= extraEnd) {
			const fieldId = directory.getUint16(extraPos, true);
			const fieldSize = directory.getUint16(extraPos + 2, true);
			if (fieldId === 0x0001) {
				let fieldOffset = extraPos + 4;
				if (uncompressedSize === 0xffffffff) {
					uncompressedSize = readUint64(directory, fieldOffset);
					fieldOffset += 8;
				}
				if (compressedSize === 0xffffffff) {
					compressedSize = readUint64(directory, fieldOffset);
					fieldOffset += 8;
				}
				if (localHeaderOffset === 0xffffffff) {
					localHeaderOffset = readUint64(directory, fieldOffset);
				}
			}
			extraPos += 4 + fieldSize;
		}

		entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
		pos += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

export class FlashArchive {
	private constructor(
		private blob: Blob,
		readonly entries: Map<string, ArchiveEntry>,
		readonly meta: FlashConfig,
		readonly stock: boolean
	) {}

	static async open(blob: Blob): Promise<FlashArchive> {
		const { offset, size } = await findCentralDirectory(blob);
		const directory = await bytesAt(blob, offset, size);
		const entries = new Map(parseCentralDirectory(directory).map((entry) => [entry.name, entry]));

		const metaEntry = entries.get('meta.json');
		if (metaEntry) {
			const bytes = await new FlashArchive(blob, entries, STOCK_META, false).bytesOf('meta.json');
			const meta = parseFlashConfig(new TextDecoder().decode(bytes));
			return new FlashArchive(blob, entries, meta, false);
		}

		const stockSteps = STOCK_META.steps.filter((step) => {
			const file = referencedFile(step);
			return file === undefined || entries.has(file);
		});
		if (!stockSteps.some((step) => step.type === 'restorePartition')) {
			throw new Error('archive has no meta.json and no recognizable stock dump files');
		}
		return new FlashArchive(blob, entries, { ...STOCK_META, steps: stockSteps }, true);
	}

	has(path: string): boolean {
		return this.entries.has(path);
	}

	private entry(path: string): ArchiveEntry {
		const entry = this.entries.get(path);
		if (!entry) throw new Error(`archive is missing file: ${path}`);
		return entry;
	}

	async streamOf(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
		const entry = this.entry(path);
		const localHeader = await bytesAt(this.blob, entry.localHeaderOffset, 30);
		const nameLength = localHeader.getUint16(26, true);
		const extraLength = localHeader.getUint16(28, true);
		const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
		const compressed = this.blob.slice(dataStart, dataStart + entry.compressedSize).stream();

		if (entry.method === METHOD_STORED) {
			return { stream: compressed, size: entry.uncompressedSize };
		}
		if (entry.method === METHOD_DEFLATE) {
			return {
				stream: compressed.pipeThrough(new DecompressionStream('deflate-raw')),
				size: entry.uncompressedSize
			};
		}
		throw new Error(`unsupported compression method ${entry.method} for ${path}`);
	}

	async sourceOf(path: string): Promise<StreamSource> {
		return this.streamOf(path);
	}

	async bytesOf(path: string): Promise<Uint8Array> {
		const { stream, size } = await this.streamOf(path);
		const out = new Uint8Array(size);
		const reader = stream.getReader();
		let filled = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (filled + value.length > size)
				throw new Error(`archive entry ${path} larger than declared`);
			out.set(value, filled);
			filled += value.length;
		}
		if (filled !== size) throw new Error(`archive entry ${path} truncated: ${filled}/${size}`);
		return out;
	}

	async textOf(path: string): Promise<string> {
		return new TextDecoder().decode(await this.bytesOf(path));
	}
}

function referencedFile(step: FlashStep): string | undefined {
	if (!('value' in step) || typeof step.value !== 'object' || step.value === null) return undefined;
	const value = step.value as Record<string, unknown>;
	const data = 'data' in value ? value.data : step.type === 'writeEnv' ? value : undefined;
	if (data && typeof data === 'object' && 'filePath' in data) {
		return (data as { filePath: string }).filePath;
	}
	return undefined;
}
