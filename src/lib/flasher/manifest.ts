export type DiscoverManifest = {
	$schema?: string;
	manifest_version: 1;
	updated_at: string;
	project: Project;
	channels: Record<string, Channel>;
	releases: Record<string, Release>;
};

export type Project = {
	id: string;
	name: string;
	description: string;
	publisher: string;
	publisher_url: string | null;
	license: string | null;
	website: string | null;
	source_url: string | null;
	issue_url: string | null;
	support_url: string | null;
	icon_url: string | null;
	banner_url: string | null;
	screenshots: Screenshot[];
};

export type Screenshot = {
	url: string;
	caption: string | null;
	alt: string | null;
};

export type Channel = {
	name: string;
	description: string;
	stability: 'stable' | 'beta' | 'experimental';
	default: boolean;
	latest: string;
	releases: string[];
};

export type Release = {
	version: string;
	channel: string;
	released_at: string;
	summary: string;
	changelog: string;
	changelog_url: string | null;
	yanked: string | null;
	deprecated: boolean;
	builtin_webapps?: Record<string, string>;
	download: Download;
};

export type Download = {
	url: string;
	size: number;
	sha256: string;
};

export const DEFAULT_MANIFEST_URLS = ['https://ota.bridgething.com/manifest.json'];

const CUSTOM_SOURCES_KEY = 'terbium.manifest-sources';

export function customManifestUrls(): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(CUSTOM_SOURCES_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
	} catch {
		return [];
	}
}

export function addCustomManifestUrl(url: string): void {
	const urls = customManifestUrls();
	if (!urls.includes(url)) {
		localStorage.setItem(CUSTOM_SOURCES_KEY, JSON.stringify([...urls, url]));
	}
}

export function removeCustomManifestUrl(url: string): void {
	localStorage.setItem(
		CUSTOM_SOURCES_KEY,
		JSON.stringify(customManifestUrls().filter((u) => u !== url))
	);
}

export async function loadManifest(url: string): Promise<DiscoverManifest> {
	const response = await fetch(url, { cache: 'no-cache' });
	if (!response.ok) {
		throw new Error(`failed to load manifest from ${url}: HTTP ${response.status}`);
	}
	const manifest = (await response.json()) as DiscoverManifest;
	if (manifest.manifest_version !== 1 || !manifest.project || !manifest.channels) {
		throw new Error(`${url} is not a thingify v1 manifest`);
	}
	return manifest;
}

export function sortedChannels(manifest: DiscoverManifest): [string, Channel][] {
	return Object.entries(manifest.channels).sort(([, a], [, b]) =>
		a.default === b.default ? a.name.localeCompare(b.name) : a.default ? -1 : 1
	);
}

export function channelReleases(manifest: DiscoverManifest, channel: Channel): Release[] {
	return channel.releases
		.map((version) => manifest.releases[version])
		.filter((release): release is Release => !!release && !release.yanked && !release.deprecated);
}
