import { channelReleases, loadManifest, sortedChannels } from './manifest';
import type { FirmwareSelection } from './state.svelte';

export interface DeepLink {
	selection: FirmwareSelection;
	source: string;
	host: string;
	verified: boolean;
}

function secureUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`the ${label} link isn't a valid URL`);
	}
	if (url.protocol !== 'https:') {
		throw new Error(`the ${label} link must be https, but points at ${url.protocol}//`);
	}
	return url;
}

function fileNameFromUrl(url: URL): string {
	const base = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
	return base.replace(/\.zip$/i, '') || 'firmware';
}

function expectedDigest(params: ReadonlyParams): string | undefined {
	const sha256 = params.get('sha256')?.toLowerCase();
	if (!sha256) return undefined;
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('the sha256 in this link is malformed');
	return sha256;
}

type ReadonlyParams = Pick<URLSearchParams, 'get' | 'has'>;

export async function resolveDeepLink(params: ReadonlyParams): Promise<DeepLink | null> {
	const zip = params.get('zip');
	if (zip) {
		const url = secureUrl(zip, 'firmware');
		const sha256 = expectedDigest(params);
		return {
			source: zip,
			host: url.host,
			verified: sha256 !== undefined,
			selection: {
				name: params.get('name') ?? fileNameFromUrl(url),
				version: params.get('version') ?? 'linked archive',
				source: 'url',
				url: zip,
				sha256
			}
		};
	}

	const manifestUrl = params.get('manifest');
	if (manifestUrl) {
		const url = secureUrl(manifestUrl, 'manifest');
		const manifest = await loadManifest(manifestUrl);
		const requestedVersion = params.get('version');
		const requestedChannel = params.get('channel');

		const channelEntries = sortedChannels(manifest);
		const channelKey =
			requestedChannel && manifest.channels[requestedChannel]
				? requestedChannel
				: (channelEntries[0]?.[0] ?? '');
		const channel = manifest.channels[channelKey];
		if (!channel) throw new Error('manifest has no channels');

		const releases = channelReleases(manifest, channel);
		const release = requestedVersion
			? releases.find((entry) => entry.version === requestedVersion)
			: (releases.find((entry) => entry.version === channel.latest) ?? releases[0]);
		if (!release) {
			throw new Error(
				requestedVersion
					? `version ${requestedVersion} not found in this manifest`
					: 'manifest has no releases'
			);
		}

		return {
			source: manifestUrl,
			host: url.host,
			verified: true,
			selection: {
				name: manifest.project.name,
				version: release.version,
				summary: release.summary,
				source: 'manifest',
				manifest,
				release
			}
		};
	}

	return null;
}
