export type DriverPlatform = 'windows' | 'linux' | 'macos';

export interface DriverSetup {
	key: DriverPlatform;
	label: string;
	shellName: string;
	command: (origin: string) => string;
}

export const DRIVER_SETUPS: DriverSetup[] = [
	{
		key: 'windows',
		label: 'Windows',
		shellName: 'PowerShell',
		command: (origin) => `irm ${origin}/driver/get | iex`
	},
	{
		key: 'linux',
		label: 'Linux',
		shellName: 'a terminal',
		command: (origin) => `curl -fsSL ${origin}/install-rules | bash`
	}
];

const LINUX_UA_WITHOUT_UDEV = /android|cros/i;

export function detectPlatform(): DriverPlatform | null {
	if (typeof navigator === 'undefined') return null;
	const ua = navigator.userAgent;
	if (/windows|win32|win64/i.test(ua)) return 'windows';
	if (LINUX_UA_WITHOUT_UDEV.test(ua)) return null;
	if (/linux|x11/i.test(ua)) return 'linux';
	if (/mac os x|macintosh|iphone|ipad/i.test(ua)) return 'macos';
	return null;
}

export function driverSetup(platform: DriverPlatform | null): DriverSetup | null {
	return DRIVER_SETUPS.find((setup) => setup.key === platform) ?? null;
}
