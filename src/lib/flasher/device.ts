import type { Superbird } from 'libsuperbird';
import type { FlashConfig } from 'libsuperbird/meta';
import type { Fastboot } from '$lib/fastboot/client';
import type { FlashArchive } from './archive';
import { runBurnModeFlash } from './burn-mode-runner';
import { runFastbootFlash, writeFastbootEnv } from './fastboot-runner';
import type { RunnerCallbacks } from './runner';

export type FlashMethod = 'fastboot' | 'burn-mode';

export interface FlashDevice {
	readonly method: FlashMethod;
	readonly usbDevice: USBDevice;
	flash(config: FlashConfig, archive: FlashArchive, callbacks: RunnerCallbacks): Promise<void>;
	runCommand(command: string): Promise<string>;
	writeEnv(
		env: string,
		save: boolean,
		onLog: (message: string) => void
	): Promise<{ saved: boolean }>;
	close(): Promise<void>;
}

export class FastbootFlashDevice implements FlashDevice {
	readonly method = 'fastboot';
	private readonly fastboot: Fastboot;

	constructor(fastboot: Fastboot) {
		this.fastboot = fastboot;
	}

	get usbDevice(): USBDevice {
		return this.fastboot.usbDevice;
	}

	flash(config: FlashConfig, archive: FlashArchive, callbacks: RunnerCallbacks): Promise<void> {
		return runFastbootFlash(this.fastboot, config, archive, callbacks);
	}

	runCommand(command: string): Promise<string> {
		return this.fastboot.console(command);
	}

	writeEnv(
		env: string,
		save: boolean,
		onLog: (message: string) => void
	): Promise<{ saved: boolean }> {
		return writeFastbootEnv(this.fastboot, env, { save, onLog });
	}

	close(): Promise<void> {
		return this.fastboot.close();
	}
}

export class BurnModeFlashDevice implements FlashDevice {
	readonly method = 'burn-mode';
	private readonly bird: Superbird;

	constructor(bird: Superbird) {
		this.bird = bird;
	}

	get usbDevice(): USBDevice {
		return this.bird.usbDevice;
	}

	flash(config: FlashConfig, archive: FlashArchive, callbacks: RunnerCallbacks): Promise<void> {
		return runBurnModeFlash(this.bird, config, archive, callbacks);
	}

	runCommand(command: string): Promise<string> {
		return this.bird.bulkcmd(command);
	}

	async writeEnv(env: string, save: boolean): Promise<{ saved: boolean }> {
		await this.bird.writeEnv(env, { save });
		return { saved: save };
	}

	close(): Promise<void> {
		return this.bird.close();
	}
}
