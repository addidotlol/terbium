import { SvelteDate } from 'svelte/reactivity';
import { asset } from '$app/paths';
import {
	protocol,
	Superbird,
	SuperbirdError,
	type ConnectStatus as BurnModeConnectStatus
} from 'libsuperbird';
import type { DiscoverManifest, Release } from './manifest';
import { settings } from '$lib/settings.svelte';
import { fetchRelease, fetchZip, type DownloadProgress } from './download';
import { FlashArchive } from './archive';
import { stepWeights, type StepEvent } from './runner';
import type { FlashProgress } from './types';
import {
	BurnModeFlashDevice,
	FastbootFlashDevice,
	type FlashDevice,
	type FlashMethod
} from './device';
import {
	Fastboot,
	FASTBOOT_PRODUCT_ID,
	FASTBOOT_VENDOR_ID,
	isFastbootDevice
} from '$lib/fastboot/client';
import {
	Maskrom,
	MASKROM_PRODUCT_ID,
	MASKROM_VENDOR_ID,
	isMaskromDevice
} from '$lib/fastboot/maskrom';

export type FlasherPhase =
	'idle' | 'connecting' | 'connected' | 'downloading' | 'preparing' | 'flashing' | 'done' | 'error';

export type InterruptedFlash = 'cancelled' | 'disconnected';

export type ConnectStatus =
	'connecting' | 'bootstrapping' | 'resetting' | 'reconnecting' | 'connected';

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
	bootstrapping: 'sending bootloader',
	resetting: 'restarting into burn mode',
	reconnecting: 'waiting for the device to come back',
	connected: 'connected'
};

const BURN_MODE_CONNECT_STATUS: Record<BurnModeConnectStatus, ConnectStatus> = {
	connecting: 'connecting',
	'bl2-boot': 'bootstrapping',
	resetting: 'resetting',
	'waiting-reconnect': 'reconnecting',
	connected: 'connected'
};

const RECONNECT_FILTERS: Record<FlashMethod, USBDeviceFilter> = {
	fastboot: { vendorId: FASTBOOT_VENDOR_ID, productId: FASTBOOT_PRODUCT_ID },
	'burn-mode': { vendorId: protocol.VENDOR_ID, productId: protocol.PRODUCT_ID }
};

const BUNDLED_BOOTLOADER: Record<FlashMethod, Parameters<typeof asset>[0]> = {
	fastboot: 'bin/carthing.fip.bin',
	'burn-mode': 'bin/superbird.bootloader.img'
};

const FASTBOOT_REAPPEAR_TIMEOUT_MS = 20_000;
const FASTBOOT_REAPPEAR_POLL_MS = 250;

export class Flasher {
	phase = $state<FlasherPhase>('idle');
	method = $state<FlashMethod | null>(null);
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

	device: FlashDevice | null = null;
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

	private setStatus(status: ConnectStatus): void {
		this.connectStatus = status;
		this.log(CONNECT_STATUS_TEXT[status]);
	}

	async connect(): Promise<void> {
		if (this.busy) return;
		this.phase = 'connecting';
		this.error = null;
		this.interrupted = null;
		this.method = settings.useBurnMode ? 'burn-mode' : 'fastboot';
		this.log(
			this.method === 'burn-mode' ? 'connecting in legacy burn mode' : 'connecting over fastboot'
		);
		try {
			this.device =
				this.method === 'burn-mode' ? await this.connectBurnMode() : await this.connectFastboot();
			this.phase = 'connected';
			this.watchDisconnect();
		} catch (error) {
			this.device = null;
			this.connectStatus = null;
			await this.releaseOpenDevices();
			if (isNoDeviceSelected(error)) {
				this.phase = 'idle';
				this.log('no device selected', 'error');
				return;
			}
			this.fail(error);
		}
	}

	private async connectFastboot(): Promise<FlashDevice> {
		let usb = await requestFastbootOrMaskromDevice();

		if (isMaskromDevice(usb)) {
			this.setStatus('connecting');
			const [bl2, fip] = await this.loadBootImages('fastboot');
			this.setStatus('bootstrapping');
			const maskrom = await Maskrom.open(usb);
			try {
				await maskrom.bl2Boot(new Uint8Array(bl2), new Uint8Array(fip), (message) =>
					this.log(message)
				);
			} finally {
				await maskrom.close();
			}
			this.setStatus('reconnecting');
			usb = await waitForFastbootDevice(FASTBOOT_REAPPEAR_TIMEOUT_MS);
		} else if (!isFastbootDevice(usb)) {
			throw new Error('that device is not a Car Thing in USB mode');
		}

		this.setStatus('connecting');
		const fastboot = await Fastboot.open(usb);
		this.setStatus('connected');
		return new FastbootFlashDevice(fastboot);
	}

	private async connectBurnMode(): Promise<FlashDevice> {
		const [bl2, bootloader] = await this.loadBootImages('burn-mode');
		const bird = await Superbird.connect({
			bl2,
			bootloader,
			onStatus: (status) => {
				const mapped = BURN_MODE_CONNECT_STATUS[status];
				this.setStatus(mapped);
				if (mapped === 'reconnecting') this.requestReconnectDevice({ silent: true });
			}
		});
		return new BurnModeFlashDevice(bird);
	}

	private async loadBootImages(method: FlashMethod): Promise<[ArrayBuffer, ArrayBuffer]> {
		const images = await Promise.all([
			settings.customBl2?.arrayBuffer() ?? fetchBootImage('bin/superbird.bl2.encrypted.bin'),
			settings.customBootloader?.arrayBuffer() ?? fetchBootImage(BUNDLED_BOOTLOADER[method])
		]);
		if (settings.customBl2 || settings.customBootloader) {
			this.log('using custom boot images');
		}
		return images;
	}

	async requestReconnectDevice(options: { silent?: boolean } = {}): Promise<void> {
		if (!this.method) return;
		try {
			await navigator.usb.requestDevice({ filters: [RECONNECT_FILTERS[this.method]] });
			this.log('device re-paired');
		} catch {
			if (!options.silent) this.log('no device selected', 'error');
		}
	}

	private watchDisconnect(): void {
		const usb = this.device?.usbDevice;
		if (!usb) return;
		const onDisconnect = (event: USBConnectionEvent) => {
			if (event.device !== usb) return;
			navigator.usb.removeEventListener('disconnect', onDisconnect);
			if (this.busy) {
				this.abortController?.abort();
				this.device = null;
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
		if (!this.device || this.busy) return;
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
			await this.device.flash(archive.meta, archive, {
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
		if (!this.device) throw new Error('not connected');
		this.log(`> ${command}`, 'command');
		try {
			const response = await this.device.runCommand(command);
			if (response.trim()) this.log(response);
			return response;
		} catch (error) {
			this.log(errorMessage(error), 'error');
			throw error;
		}
	}

	async writeEnv(env: string, save: boolean): Promise<void> {
		if (!this.device) throw new Error('not connected');
		const { saved } = await this.device.writeEnv(env, save, (message) => this.log(message));
		this.log(saved ? 'environment written and saved' : 'environment written');
	}

	private fail(error: unknown): void {
		const message = errorMessage(error);
		this.error = message;
		this.phase = 'error';
		this.log(message, 'error');
	}

	reset(): void {
		const device = this.device;
		this.device = null;
		device?.close().catch(() => {});
		this.phase = 'idle';
		this.method = null;
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
		this.phase = this.device ? 'connected' : 'idle';
	}

	private async releaseOpenDevices(): Promise<void> {
		const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
		await Promise.all(
			devices.filter((device) => device.opened).map((device) => device.close().catch(() => {}))
		);
	}
}

function isNoDeviceSelected(error: unknown): boolean {
	return (
		(error instanceof SuperbirdError && error.code === 'not-found') ||
		(error instanceof DOMException && error.name === 'NotFoundError')
	);
}

async function requestFastbootOrMaskromDevice(): Promise<USBDevice> {
	const paired = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
	const alreadyPaired = paired.find(
		(device) => isFastbootDevice(device) || isMaskromDevice(device)
	);
	if (alreadyPaired) return alreadyPaired;

	return navigator.usb.requestDevice({
		filters: [
			{ vendorId: FASTBOOT_VENDOR_ID, productId: FASTBOOT_PRODUCT_ID },
			{ vendorId: MASKROM_VENDOR_ID, productId: MASKROM_PRODUCT_ID }
		]
	});
}

async function waitForFastbootDevice(timeoutMs: number): Promise<USBDevice> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
		const found = devices.find(isFastbootDevice);
		if (found) return found;
		if (Date.now() >= deadline) {
			throw new Error('the device did not come back in fastboot mode');
		}
		await new Promise((resolve) => setTimeout(resolve, FASTBOOT_REAPPEAR_POLL_MS));
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
