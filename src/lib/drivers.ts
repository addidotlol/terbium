/**
 * Per-OS USB setup the browser needs before it can see the Car Thing.
 *
 * Windows binds a driver per VID:PID and WebUSB only works through WinUSB, so
 * both of the device's identities (boot ROM and fastboot) have to be claimed.
 * Linux needs udev rules for the same two IDs. macOS needs neither.
 */

export type DriverPlatform = 'windows' | 'linux' | 'macos';

export interface DriverSetup {
	key: DriverPlatform;
	label: string;
	/** Where the user is expected to paste the command. */
	shell: string;
	command: (origin: string) => string;
}

export const DRIVER_SETUPS: DriverSetup[] = [
	{
		key: 'windows',
		label: 'Windows',
		shell: 'PowerShell',
		command: (origin) => `irm ${origin}/driver/get | iex`
	},
	{
		key: 'linux',
		label: 'Linux',
		shell: 'a terminal',
		command: (origin) => `curl -fsSL ${origin}/install-rules | bash`
	}
];

export function detectPlatform(): DriverPlatform | null {
	if (typeof navigator === 'undefined') return null;
	const ua = navigator.userAgent;
	if (/windows|win32|win64/i.test(ua)) return 'windows';
	// Both claim Linux in the UA but neither takes udev rules from us.
	if (/android|cros/i.test(ua)) return null;
	if (/linux|x11/i.test(ua)) return 'linux';
	if (/mac os x|macintosh|iphone|ipad/i.test(ua)) return 'macos';
	return null;
}

export function driverSetup(platform: DriverPlatform | null): DriverSetup | null {
	return DRIVER_SETUPS.find((setup) => setup.key === platform) ?? null;
}
