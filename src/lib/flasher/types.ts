import type { Bytes } from '$lib/bytes';

/** A lazily-decompressed archive entry: the bytes, plus how many to expect. */
export interface StreamSource {
	stream: ReadableStream<Uint8Array>;
	size: number;
}

export interface FlashProgress {
	percent: number;
	bytesWritten: number;
	/** Bytes we didn't send because the region was all zeros (sparse writes). */
	bytesSkipped: number;
	totalBytes: number;
	elapsedMs: number;
	etaMs: number;
	rateKiBps: number;
	avgRateKiBps: number;
}

/**
 * Progress accounting for one flash step.
 *
 * `rateKiBps` is measured over the most recent report so the UI reacts to the
 * device slowing down, while `avgRateKiBps` and the ETA use the whole run;
 * an ETA driven by the instantaneous rate jitters uselessly. Skipped bytes
 * count toward completion but not toward either rate; they were never sent.
 */
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

	/** @param inFlight bytes of the current chunk already on the wire but not yet flashed. */
	snapshot(inFlight = 0): FlashProgress {
		const now = performance.now();
		const transferred = this.written + inFlight;
		const done = transferred + this.skipped;
		const elapsedMs = now - this.startedAt;

		const sinceMs = now - this.lastAt;
		if (sinceMs >= 250) {
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

/**
 * Reads exact-length chunks out of a ReadableStream.
 *
 * Archive entries arrive as inflate streams that hand back arbitrary slice
 * sizes, but every fastboot download has to be announced with its length up
 * front, so we need to gather precisely N bytes at a time.
 */
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
