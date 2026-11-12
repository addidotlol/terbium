import type { Bytes } from '$lib/bytes';

export interface StreamSource {
	stream: ReadableStream<Uint8Array>;
	size: number;
}

export interface FlashProgress {
	percent: number;
	bytesWritten: number;
	bytesSkipped: number;
	totalBytes: number;
	elapsedMs: number;
	etaMs: number;
	rateKiBps: number;
	avgRateKiBps: number;
}

const RATE_WINDOW_MS = 250;

export class ProgressTracker {
	private readonly totalBytes: number;
	private readonly startedAt = performance.now();
	private written = 0;
	private skipped = 0;
	private lastAt = performance.now();
	private lastTransferred = 0;
	private lastRateKiBps = 0;

	constructor(totalBytes: number) {
		this.totalBytes = totalBytes;
	}

	markWritten(bytes: number): void {
		this.written += bytes;
	}

	markSkipped(bytes: number): void {
		this.skipped += bytes;
	}

	snapshot(inFlightBytes = 0): FlashProgress {
		const now = performance.now();
		const transferred = this.written + inFlightBytes;
		const done = transferred + this.skipped;
		const elapsedMs = now - this.startedAt;

		const sinceMs = now - this.lastAt;
		if (sinceMs >= RATE_WINDOW_MS) {
			this.lastRateKiBps = ((transferred - this.lastTransferred) / 1024 / sinceMs) * 1000;
			this.lastAt = now;
			this.lastTransferred = transferred;
		}

		const avgRateKiBps = elapsedMs > 0 ? (transferred / 1024 / elapsedMs) * 1000 : 0;
		const remaining = Math.max(0, this.totalBytes - done);
		return {
			percent: this.totalBytes > 0 ? Math.min(100, (done / this.totalBytes) * 100) : 100,
			bytesWritten: transferred,
			bytesSkipped: this.skipped,
			totalBytes: this.totalBytes,
			elapsedMs,
			etaMs: avgRateKiBps > 0 ? (remaining / 1024 / avgRateKiBps) * 1000 : 0,
			rateKiBps: this.lastRateKiBps || avgRateKiBps,
			avgRateKiBps
		};
	}
}

export class StreamChunker {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private pending: Uint8Array | null = null;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	async read(length: number): Promise<Bytes> {
		const out = new Uint8Array(length);
		let filled = 0;
		while (filled < length) {
			if (!this.pending || this.pending.byteLength === 0) {
				const { done, value } = await this.reader.read();
				if (done) throw new Error(`archive entry ended ${length - filled} bytes early`);
				this.pending = value;
				continue;
			}
			const take = Math.min(length - filled, this.pending.byteLength);
			out.set(this.pending.subarray(0, take), filled);
			this.pending = this.pending.subarray(take);
			filled += take;
		}
		return out;
	}

	async cancel(): Promise<void> {
		await this.reader.cancel().catch(() => {});
	}
}
