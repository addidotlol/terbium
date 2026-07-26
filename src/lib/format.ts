export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '-';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-';
	return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '-';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

export function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
