import { SvelteDate } from 'svelte/reactivity';
import { asset } from '$app/paths';
import type { DiscoverManifest, Release } from './manifest';
import { settings } from '$lib/settings.svelte';
import { fetchRelease, fetchZip, type DownloadProgress } from './download';
import { FlashArchive } from './archive';
import { runFlashConfig, stepWeights, writeEnv, type StepEvent } from './runner';
import type { FlashProgress } from './types';
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

/**
 * `bootstrapping` and `waiting-fastboot` only happen for a device found in
 * mask-ROM; one already in fastboot goes straight from `connecting` to
 * `connected`.
 */
export type ConnectStatus = 'connecting' | 'bootstrapping' | 'waiting-fastboot' | 'connected';

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
	bootstrapping: 'starting the bootloader',
	'waiting-fastboot': 'waiting for the device to come back',
	connected: 'connected'
};

/** How long to wait for the device to re-enumerate in fastboot after a bl2 boot. */
const FASTBOOT_REAPPEAR_TIMEOUT_MS = 20_000;

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

	device: Fastboot | null = null;
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

	/**
	 * Get to a device that speaks fastboot.
	 *
	 * A device already running our u-boot shows up as 18d1:fada and we just
	 * talk to it. A stock or bricked one only offers the SoC boot ROM
	 * (1b8e:c003), which speaks nothing but the amlogic protocol, so we use it
	 * exactly once to load our signed bootloader into RAM. That bootloader sees
	 * it was started over USB and enters fastboot on its own, and everything
	 * from there is fastboot.
	 */
	async connect(): Promise<void> {
		if (this.busy) return;
		this.phase = 'connecting';
		this.error = null;
		this.interrupted = null;
		try {
			let usb = await requestSupportedDevice();

			if (isMaskromDevice(usb)) {
				this.setStatus('connecting');
				const [bl2, fip] = await Promise.all([
					settings.customBl2?.arrayBuffer() ?? fetchBootImage('bin/superbird.bl2.encrypted.bin'),
					settings.customFip?.arrayBuffer() ?? fetchBootImage('bin/carthing.fip.bin')
				]);
				if (settings.customBl2 || settings.customFip) {
					this.log('using custom boot images');
				}

				this.setStatus('bootstrapping');
				const maskrom = await Maskrom.open(usb);
				try {
					await maskrom.bl2Boot(new Uint8Array(bl2), new Uint8Array(fip), (message) =>
						this.log(message)
					);
				} finally {
					await maskrom.close();
				}

				this.setStatus('waiting-fastboot');
				usb = await waitForFastbootDevice(FASTBOOT_REAPPEAR_TIMEOUT_MS);
			} else if (!isFastbootDevice(usb)) {
				throw new Error('that device is not a Car Thing in USB mode');
			}

			this.setStatus('connecting');
			this.device = await Fastboot.open(usb);
			this.setStatus('connected');
			this.phase = 'connected';
			this.watchDisconnect();
		} catch (error) {
			this.device = null;
			this.connectStatus = null;
			await this.releaseOpenDevices();
			if (error instanceof DOMException && error.name === 'NotFoundError') {
				this.phase = 'idle';
				this.log('no device selected', 'error');
				return;
			}
			this.fail(error);
		}
	}

	/**
	 * Re-pair the device after it re-enumerates.
	 *
	 * Neither mask-ROM nor our fastboot gadget reports a serial number, so each
	 * time the device comes back the browser treats it as a brand new one and
	 * the previous permission doesn't carry over. That means a fresh
	 * `requestDevice` from a user gesture for every USB transition.
	 */
	async requestFastbootDevice(options: { silent?: boolean } = {}): Promise<void> {
		try {
			await navigator.usb.requestDevice({
				filters: [{ vendorId: FASTBOOT_VENDOR_ID, productId: FASTBOOT_PRODUCT_ID }]
			});
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
			await runFlashConfig(this.device, archive.meta, archive, {
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

	/** Run a u-boot command on the device and return its console output. */
	async runCommand(command: string): Promise<string> {
		if (!this.device) throw new Error('not connected');
		this.log(`> ${command}`, 'command');
		try {
			const response = await this.device.console(command);
			if (response.trim()) this.log(response);
			return response;
		} catch (error) {
			this.log(errorMessage(error), 'error');
			throw error;
		}
	}

	async writeEnv(env: string, save: boolean): Promise<void> {
		if (!this.device) throw new Error('not connected');
		const { saved } = await writeEnv(this.device, env, { save, onLog: (m) => this.log(m) });
		this.log(saved ? 'environment written and saved' : 'environment written');
	}

	/** Boot the firmware that's on the device now, leaving fastboot behind. */
	async rebootDevice(): Promise<void> {
		if (!this.device) throw new Error('not connected');
		await this.device.reboot();
		this.device = null;
		this.log('device rebooting');
		this.reset();
	}

	/** Drop the device back to the SoC boot ROM, e.g. to recover a bad bootloader. */
	async rebootToMaskrom(): Promise<void> {
		if (!this.device) throw new Error('not connected');
		await this.device.rebootMaskrom();
		this.device = null;
		this.log('device returning to USB mode');
		this.reset();
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

/** Prompt for either a device already in fastboot or one sitting in the boot ROM. */
async function requestSupportedDevice(): Promise<USBDevice> {
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

/**
 * Wait for the device to reappear in fastboot after the bootloader starts.
 *
 * It usually needs a fresh permission grant (no serial number, so the browser
 * sees a new device), which only a user gesture can provide; the UI offers a
 * button for that while this polls.
 */
async function waitForFastbootDevice(timeoutMs: number): Promise<USBDevice> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
		const found = devices.find(isFastbootDevice);
		if (found) return found;
		if (Date.now() >= deadline) {
			throw new Error('the device did not come back in fastboot mode');
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
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
