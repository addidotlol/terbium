import { SvelteDate } from 'svelte/reactivity';
import { asset } from '$app/paths';
import {
	protocol,
	Superbird,
	SuperbirdError,
	type ConnectStatus,
	type FlashProgress
} from 'libsuperbird';
import type { DiscoverManifest, Release } from './manifest';
import { settings } from '$lib/settings.svelte';
import { fetchRelease, fetchZip, type DownloadProgress } from './download';
import { FlashArchive } from './archive';
import { runFlashConfig, stepWeights, type StepEvent } from './runner';

export type FlasherPhase =
	'idle' | 'connecting' | 'connected' | 'downloading' | 'preparing' | 'flashing' | 'done' | 'error';

export type InterruptedFlash = 'cancelled' | 'disconnected';

export interface LogLine {
	time: Date;
	message: string;
	kind: 'info' | 'error' | 'command';
}

export interface FirmwareSelection {
	name: string;
	version: string;
	summary?: string;
	source: 'manifest' | 'file' | 'url';
	manifest?: DiscoverManifest;
	release?: Release;
	file?: File;
	url?: string;
	sha256?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const CONNECT_STATUS_TEXT: Record<ConnectStatus, string> = {
	connecting: 'connecting to device',
	'bl2-boot': 'sending bootloader',
	resetting: 'restarting into burn mode',
	'waiting-reconnect': 'waiting for the device to come back',
	connected: 'connected'
};

export class Flasher {
	phase = $state<FlasherPhase>('idle');
	connectStatus = $state<ConnectStatus | null>(null);
	error = $state<string | null>(null);
	interrupted = $state<InterruptedFlash | null>(null);
	logs = $state<LogLine[]>([]);
	selection = $state<FirmwareSelection | null>(null);
	downloadProgress = $state<DownloadProgress | null>(null);
	stepIndex = $state(0);
	totalSteps = $state(0);
	stepLabel = $state('');
	stepProgress = $state<FlashProgress | null>(null);
	overallPercent = $state(0);
	flashedName = $state('');

	bird: Superbird | null = null;
	private abortController: AbortController | null = null;
	private weights: number[] = [];
	private wakeLock: WakeLockSentinel | null = null;
	private onVisibilityChange: (() => void) | null = null;

	get connectStatusText(): string {
		return this.connectStatus ? CONNECT_STATUS_TEXT[this.connectStatus] : '';
	}

	get busy(): boolean {
		return ['connecting', 'downloading', 'preparing', 'flashing'].includes(this.phase);
	}

	log(message: string, kind: LogLine['kind'] = 'info'): void {
		this.logs = [...this.logs, { time: new SvelteDate(), message, kind }];
	}

	static supported(): boolean {
		return typeof navigator !== 'undefined' && 'usb' in navigator;
	}

	async connect(): Promise<void> {
		if (this.busy) return;
		this.phase = 'connecting';
		this.error = null;
		this.interrupted = null;
		try {
			const [bl2, bootloader] = await Promise.all([
				settings.customBl2?.arrayBuffer() ?? fetchBootImage('bin/superbird.bl2.encrypted.bin'),
				settings.customBootloader?.arrayBuffer() ?? fetchBootImage('bin/superbird.bootloader.img')
			]);
			if (settings.customBl2 || settings.customBootloader) {
				this.log('using custom boot images');
			}
			this.bird = await Superbird.connect({
				bl2,
				bootloader,
				onStatus: (status) => {
					this.connectStatus = status;
					this.log(CONNECT_STATUS_TEXT[status]);
					if (status === 'waiting-reconnect') {
						this.requestBurnDevice({ silent: true });
					}
				}
			});
			this.phase = 'connected';
			this.watchDisconnect();
		} catch (error) {
			this.bird = null;
			this.connectStatus = null;
			await this.releaseOpenDevices();
			if (error instanceof SuperbirdError && error.code === 'not-found') {
				this.phase = 'idle';
				this.log('no device selected', 'error');
				return;
			}
			this.fail(error);
		}
	}

	async requestBurnDevice(options: { silent?: boolean } = {}): Promise<void> {
		try {
			await navigator.usb.requestDevice({
				filters: [{ vendorId: protocol.VENDOR_ID, productId: protocol.PRODUCT_ID }]
			});
			this.log('device re-paired');
		} catch {
			if (!options.silent) this.log('no device selected', 'error');
		}
	}

	private watchDisconnect(): void {
		const device = this.bird?.usbDevice;
		if (!device) return;
		const onDisconnect = (event: USBConnectionEvent) => {
			if (event.device !== device) return;
			navigator.usb.removeEventListener('disconnect', onDisconnect);
			if (this.busy) {
				this.abortController?.abort();
				this.bird = null;
				this.interrupted = 'disconnected';
				this.error = 'the device was unplugged before the flash finished';
				this.phase = 'error';
				this.log('device disconnected mid-flash', 'error');
				return;
			}
			this.reset();
			this.log('device disconnected');
		};
		navigator.usb.addEventListener('disconnect', onDisconnect);
	}

	async flash(selection: FirmwareSelection): Promise<void> {
		if (!this.bird || this.busy) return;
		this.selection = selection;
		this.error = null;
		this.interrupted = null;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		try {
			await this.holdWakeLock();
			let blob: Blob;
			if (selection.source === 'manifest' && selection.release) {
				this.phase = 'downloading';
				this.downloadProgress = null;
				blob = await fetchRelease(selection.release.download, {
					signal,
					onProgress: (progress) => (this.downloadProgress = progress)
				});
			} else if (selection.source === 'url' && selection.url) {
				this.phase = 'downloading';
				this.downloadProgress = null;
				blob = await fetchZip(selection.url, {
					signal,
					sha256: selection.sha256,
					onProgress: (progress) => (this.downloadProgress = progress)
				});
			} else if (selection.file) {
				blob = selection.file;
			} else {
				throw new Error('nothing selected to flash');
			}

			this.phase = 'preparing';
			const archive = await FlashArchive.open(blob);
			this.weights = stepWeights(archive.meta, archive);
			this.totalSteps = archive.meta.steps.length;
			this.stepIndex = 0;
			this.stepProgress = null;
			this.overallPercent = 0;
			this.log(`flashing ${archive.meta.name} ${archive.meta.version}`);

			this.phase = 'flashing';
			await runFlashConfig(this.bird, archive.meta, archive, {
				signal,
				onLog: (message) => this.log(message),
				onStep: (event) => this.onStep(event),
				forceSparse: settings.forceSparse
			});

			this.overallPercent = 100;
			this.flashedName = `${selection.name} ${selection.version}`;
			this.phase = 'done';
			this.log('flash complete');
		} catch (error) {
			if (signal.aborted) {
				if (this.interrupted !== 'disconnected') {
					this.interrupted = 'cancelled';
					this.error = 'the flash was cancelled before it finished';
					this.phase = 'error';
					this.log('flash cancelled', 'error');
				}
				return;
			}
			this.fail(error);
		} finally {
			this.abortController = null;
			this.releaseWakeLock();
		}
	}

	private async holdWakeLock(): Promise<void> {
		if (!('wakeLock' in navigator)) return;
		this.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
		this.onVisibilityChange = () => {
			if (document.visibilityState !== 'visible' || !this.busy || this.wakeLock) return;
			navigator.wakeLock
				.request('screen')
				.then((lock) => (this.wakeLock = lock))
				.catch(() => {});
		};
		document.addEventListener('visibilitychange', this.onVisibilityChange);
	}

	private releaseWakeLock(): void {
		if (this.onVisibilityChange) {
			document.removeEventListener('visibilitychange', this.onVisibilityChange);
			this.onVisibilityChange = null;
		}
		this.wakeLock?.release().catch(() => {});
		this.wakeLock = null;
	}

	private onStep(event: StepEvent): void {
		this.stepIndex = event.stepIndex;
		this.totalSteps = event.totalSteps;
		this.stepLabel = event.label;
		this.stepProgress = event.progress ?? null;

		const totalWeight = this.weights.reduce((sum, weight) => sum + weight, 0);
		const completedWeight = this.weights.slice(0, event.stepIndex).reduce((s, w) => s + w, 0);
		const stepFraction = event.progress ? event.progress.percent / 100 : 0;
		const currentWeight = this.weights[event.stepIndex] ?? 0;
		this.overallPercent = Math.min(
			100,
			((completedWeight + currentWeight * stepFraction) / totalWeight) * 100
		);
	}

	cancelFlash(): void {
		this.abortController?.abort();
	}

	async runCommand(command: string): Promise<string> {
		if (!this.bird) throw new Error('not connected');
		this.log(`> ${command}`, 'command');
		try {
			const response = await this.bird.bulkcmd(command);
			this.log(response);
			return response;
		} catch (error) {
			this.log(errorMessage(error), 'error');
			throw error;
		}
	}

	async writeEnv(env: string, save: boolean): Promise<void> {
		if (!this.bird) throw new Error('not connected');
		await this.bird.writeEnv(env, { save });
		this.log(save ? 'environment written and saved' : 'environment written');
	}

	private fail(error: unknown): void {
		const message = errorMessage(error);
		this.error = message;
		this.phase = 'error';
		this.log(message, 'error');
	}

	reset(): void {
		const bird = this.bird;
		this.bird = null;
		bird?.close().catch(() => {});
		this.phase = 'idle';
		this.connectStatus = null;
		this.error = null;
		this.interrupted = null;
		this.downloadProgress = null;
		this.stepProgress = null;
		this.overallPercent = 0;
	}

	readyForNextFlash(): void {
		this.error = null;
		this.interrupted = null;
		this.selection = null;
		this.downloadProgress = null;
		this.stepProgress = null;
		this.stepIndex = 0;
		this.totalSteps = 0;
		this.stepLabel = '';
		this.overallPercent = 0;
		this.phase = this.bird ? 'connected' : 'idle';
	}

	private async releaseOpenDevices(): Promise<void> {
		const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
		await Promise.all(
			devices.filter((device) => device.opened).map((device) => device.close().catch(() => {}))
		);
	}
}

const MIN_BOOT_IMAGE_BYTES = 16 * 1024;

async function fetchBootImage(path: Parameters<typeof asset>[0]): Promise<ArrayBuffer> {
	const url = asset(path);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`failed to load ${url}: HTTP ${response.status}`);
	if ((response.headers.get('content-type') ?? '').includes('text/html')) {
		throw new Error(`${url} served a web page instead of a boot image; check the deployment`);
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength < MIN_BOOT_IMAGE_BYTES) {
		throw new Error(
			`${url} is only ${buffer.byteLength} bytes, too small to be a boot image; check the deployment`
		);
	}
	return buffer;
}

export const flasher = new Flasher();
