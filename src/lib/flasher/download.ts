import { createSHA256 } from 'hash-wasm';
import type { Download } from './manifest';

export interface DownloadProgress {
	receivedBytes: number;
	totalBytes: number;
	bytesPerSecond: number;
	phase: 'downloading' | 'verifying';
}

export interface DownloadOptions {
	onProgress?: (progress: DownloadProgress) => void;
	signal?: AbortSignal;
}

function encodedUrl(url: string): string {
	return url.replace(/\+/g, '%2B');
}

async function cacheDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
	if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return undefined;
	try {
		const root = await navigator.storage.getDirectory();
		return await root.getDirectoryHandle('firmware-cache', { create: true });
	} catch {
		return undefined;
	}
}

async function hashBlob(
	blob: Blob,
	onProgress?: (hashed: number) => void,
	signal?: AbortSignal
): Promise<string> {
	const hasher = await createSHA256();
	hasher.init();
	const reader = blob.stream().getReader();
	let hashed = 0;
	for (;;) {
		signal?.throwIfAborted();
		const { done, value } = await reader.read();
		if (done) break;
		hasher.update(value);
		hashed += value.length;
		onProgress?.(hashed);
	}
	return hasher.digest('hex');
}

async function cachedRelease(
	download: Download,
	options: DownloadOptions
): Promise<File | undefined> {
	const cache = await cacheDirectory();
	if (!cache) return undefined;
	try {
		const handle = await cache.getFileHandle(`${download.sha256}.zip`);
		const file = await handle.getFile();
		if (file.size !== download.size) return undefined;
		const digest = await hashBlob(
			file,
			(hashed) =>
				options.onProgress?.({
					receivedBytes: hashed,
					totalBytes: download.size,
					bytesPerSecond: 0,
					phase: 'verifying'
				}),
			options.signal
		);
		return digest === download.sha256 ? file : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchRelease(
	download: Download,
	options: DownloadOptions = {}
): Promise<Blob> {
	const cached = await cachedRelease(download, options);
	if (cached) return cached;

	const response = await fetch(encodedUrl(download.url), { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status}`);
	}

	const cache = await cacheDirectory();
	const fileName = `${download.sha256}.zip`;
	let writable: FileSystemWritableFileStream | undefined;
	if (cache) {
		try {
			const handle = await cache.getFileHandle(fileName, { create: true });
			writable = await handle.createWritable();
		} catch {
			writable = undefined;
		}
	}

	const hasher = await createSHA256();
	hasher.init();
	const chunks: Uint8Array[] = [];
	const reader = response.body.getReader();
	let received = 0;
	const started = performance.now();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
			if (writable) await writable.write(value as unknown as FileSystemWriteChunkType);
			else chunks.push(value);
			received += value.length;
			const elapsed = (performance.now() - started) / 1000;
			options.onProgress?.({
				receivedBytes: received,
				totalBytes: download.size,
				bytesPerSecond: elapsed > 0 ? received / elapsed : 0,
				phase: 'downloading'
			});
		}
	} catch (error) {
		if (writable) {
			await writable.abort().catch(() => {});
			await cache?.removeEntry(fileName).catch(() => {});
		}
		throw error;
	}

	const digest = hasher.digest('hex');
	if (digest !== download.sha256) {
		if (writable) {
			await writable.abort().catch(() => {});
			await cache?.removeEntry(fileName).catch(() => {});
		}
		throw new Error(`download corrupted: sha256 mismatch (got ${digest})`);
	}

	if (writable && cache) {
		await writable.close();
		const handle = await cache.getFileHandle(fileName);
		return handle.getFile();
	}
	return new Blob(chunks as BlobPart[]);
}

export interface ZipDownloadOptions extends DownloadOptions {
	sha256?: string;
}

export async function fetchZip(url: string, options: ZipDownloadOptions = {}): Promise<Blob> {
	const response = await fetch(encodedUrl(url), { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status}`);
	}
	const totalBytes = Number(response.headers.get('content-length')) || 0;
	const hasher = options.sha256 ? await createSHA256() : undefined;
	hasher?.init();
	const chunks: Uint8Array[] = [];
	const reader = response.body.getReader();
	let received = 0;
	const started = performance.now();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		hasher?.update(value);
		chunks.push(value);
		received += value.length;
		const elapsed = (performance.now() - started) / 1000;
		options.onProgress?.({
			receivedBytes: received,
			totalBytes,
			bytesPerSecond: elapsed > 0 ? received / elapsed : 0,
			phase: 'downloading'
		});
	}

	if (hasher && options.sha256) {
		const digest = hasher.digest('hex');
		if (digest !== options.sha256) {
			throw new Error(`download corrupted: sha256 mismatch (got ${digest})`);
		}
	}
	return new Blob(chunks as BlobPart[]);
}

export async function clearFirmwareCache(): Promise<void> {
	const cache = await cacheDirectory();
	if (!cache) return;
	for await (const name of cache.keys()) {
		await cache.removeEntry(name).catch(() => {});
	}
}
