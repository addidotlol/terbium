<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Alert from '$lib/components/ui/alert';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Select from '$lib/components/ui/select';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		DEFAULT_MANIFEST_URLS,
		addCustomManifestUrl,
		channelReleases,
		customManifestUrls,
		loadManifest,
		removeCustomManifestUrl,
		sortedChannels,
		type Channel,
		type DiscoverManifest,
		type Release
	} from '$lib/flasher/manifest';
	import type { FirmwareSelection } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';
	import { formatBytes, formatDate } from '$lib/format';

	interface Props {
		onContinue: (selection: FirmwareSelection) => void;
	}

	let { onContinue }: Props = $props();

	interface Source {
		url: string;
		custom: boolean;
		manifest?: DiscoverManifest;
		error?: string;
	}

	let sources = $state<Source[]>([]);
	let loading = $state(true);
	let pick = $state<string>('');
	let channelPicks = $state<Record<string, string>>({});
	let versionPicks = $state<Record<string, string>>({});
	let file = $state<File | null>(null);
	let customUrl = $state('');
	let customError = $state('');
	let showSources = $state(false);

	async function loadAll(): Promise<void> {
		loading = true;
		const urls = [
			...DEFAULT_MANIFEST_URLS.map((url) => ({ url, custom: false })),
			...customManifestUrls().map((url) => ({ url, custom: true }))
		];
		sources = await Promise.all(
			urls.map(async ({ url, custom }): Promise<Source> => {
				try {
					return { url, custom, manifest: await loadManifest(url) };
				} catch (error) {
					return { url, custom, error: error instanceof Error ? error.message : String(error) };
				}
			})
		);
		const first = sources.find((source) => source.manifest);
		if (first && !pick) pick = first.url;
		loading = false;
	}

	onMount(() => {
		loadAll();
	});

	function defaultChannelKey(manifest: DiscoverManifest): string {
		const channels = sortedChannels(manifest);
		return channels[0]?.[0] ?? '';
	}

	function channelKeyOf(source: Source): string {
		return channelPicks[source.url] ?? (source.manifest ? defaultChannelKey(source.manifest) : '');
	}

	function channelOf(source: Source): Channel | undefined {
		return source.manifest?.channels[channelKeyOf(source)];
	}

	function releaseOf(source: Source): Release | undefined {
		const channel = channelOf(source);
		if (!source.manifest || !channel) return undefined;
		const releases = channelReleases(source.manifest, channel);
		const picked = versionPicks[`${source.url}:${channelKeyOf(source)}`];
		return releases.find((release) => release.version === picked) ?? releases[0];
	}

	const ready = $derived(
		pick === 'file'
			? !!file
			: !!sources.find((source) => source.url === pick && !!releaseOf(source))
	);

	function submit(): void {
		if (pick === 'file' && file) {
			onContinue({
				name: file.name.replace(/\.zip$/i, ''),
				version: 'local archive',
				source: 'file',
				file
			});
			return;
		}
		const source = sources.find((entry) => entry.url === pick);
		const release = source ? releaseOf(source) : undefined;
		if (!source?.manifest || !release) return;
		onContinue({
			name: source.manifest.project.name,
			version: release.version,
			summary: release.summary,
			source: 'manifest',
			manifest: source.manifest,
			release
		});
	}

	function addSource(): void {
		customError = '';
		let url = customUrl.trim();
		if (!url) return;
		try {
			url = new URL(url).toString();
		} catch {
			customError = "That isn't a valid URL.";
			return;
		}
		addCustomManifestUrl(url);
		customUrl = '';
		loadAll();
	}

	function removeSource(url: string): void {
		removeCustomManifestUrl(url);
		if (pick === url) pick = '';
		loadAll();
	}

	function radioId(url: string): string {
		return `firmware-${url.replace(/[^a-z0-9]/gi, '-')}`;
	}
</script>

<div class="flex flex-col gap-6">
	<div>
		<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
			Choose your firmware
		</h2>
		<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			Pick a build below, or flash a zip you already have.
		</p>
	</div>

	{#if loading}
		<div class="flex items-center gap-2.5 text-base/7 text-muted-foreground sm:text-sm/6">
			<Spinner class="text-primary" />
			<span>Loading firmware sources</span>
		</div>
	{:else}
		<RadioGroup.Root bind:value={pick} class="gap-3">
			{#each sources as source (source.url)}
				{#if source.manifest}
					{@const manifest = source.manifest}
					{@const channels = sortedChannels(manifest)}
					{@const channelKey = channelKeyOf(source)}
					{@const channel = channelOf(source)}
					{@const releases = channel ? channelReleases(manifest, channel) : []}
					{@const release = releaseOf(source)}
					{@const active = pick === source.url}
					<label
						for={radioId(source.url)}
						class="flex cursor-pointer flex-col gap-4 rounded-xl p-4 ring-1 ring-inset {active
							? 'bg-primary/4 ring-primary/50'
							: 'ring-border'}"
					>
						<div class="flex items-start gap-3">
							<span class="flex h-lh items-center text-base/7 sm:text-sm/6">
								<RadioGroup.Item value={source.url} id={radioId(source.url)} />
							</span>
							{#if manifest.project.icon_url}
								<img
									src={manifest.project.icon_url}
									alt=""
									class="size-9 h-lh shrink-0 rounded-lg bg-secondary object-contain p-1"
								/>
							{/if}
							<div class="min-w-0 flex-1">
								<p class="text-base/7 font-medium sm:text-sm/6">
									{manifest.project.name}
									<span class="font-normal text-muted-foreground">
										by {manifest.project.publisher}</span
									>
								</p>
								<p class="mt-0.5 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
									{manifest.project.description}
								</p>
							</div>
						</div>

						{#if active && channel && release}
							<div class="flex flex-col gap-4 border-t border-border pt-4">
								{#if channels.length > 1}
									<div class="flex flex-col gap-2">
										<Tabs.Root
											value={channelKey}
											onValueChange={(value) => (channelPicks[source.url] = value)}
										>
											<Tabs.List>
												{#each channels as [key, entry] (key)}
													<Tabs.Trigger value={key}>{entry.name}</Tabs.Trigger>
												{/each}
											</Tabs.List>
										</Tabs.Root>
										{#if channel.description}
											<p class="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
												{channel.description}
											</p>
										{/if}
									</div>
								{/if}

								<Select.Root
									type="single"
									value={release.version}
									onValueChange={(value) => {
										versionPicks[`${source.url}:${channelKey}`] = value;
									}}
								>
									<Select.Trigger class="self-start" aria-label="Version">
										{release.version}
									</Select.Trigger>
									<Select.Content>
										{#each releases as entry (entry.version)}
											<Select.Item value={entry.version} label={entry.version}>
												{entry.version}
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>

								<div class="text-base/7 text-muted-foreground sm:text-sm/6">
									{#if release.summary}
										<p class="max-w-[56ch] text-pretty text-foreground">{release.summary}</p>
									{/if}
									<p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
										<span>
											Released {formatDate(release.released_at)} · {formatBytes(
												release.download.size
											)} download
										</span>
										{#if release.version === channel.latest}
											<Badge variant="secondary">latest</Badge>
										{/if}
										{#if channel.stability === 'experimental'}
											<Badge variant="destructive">experimental</Badge>
										{/if}
									</p>
								</div>
							</div>
						{/if}
					</label>
				{:else}
					<Alert.Root variant="destructive">
						<Alert.Title>Source failed to load</Alert.Title>
						<Alert.Description class="break-all">
							{source.url}: {source.error}
						</Alert.Description>
					</Alert.Root>
				{/if}
			{/each}

			<label
				for={radioId('file')}
				class="flex cursor-pointer flex-col gap-4 rounded-xl p-4 ring-1 ring-inset {pick === 'file'
					? 'bg-primary/4 ring-primary/50'
					: 'ring-border'}"
			>
				<div class="flex items-start gap-3">
					<span class="flex h-lh items-center text-base/7 sm:text-sm/6">
						<RadioGroup.Item value="file" id={radioId('file')} />
					</span>
					<div class="min-w-0 flex-1">
						<p class="text-base/7 font-medium sm:text-sm/6">Local archive</p>
						<p class="mt-0.5 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
							A Terbium-compatible .zip from your own machine.
						</p>
					</div>
				</div>
				{#if pick === 'file'}
					<div class="border-t border-border pt-4">
						<Input
							type="file"
							name="archive"
							accept=".zip"
							aria-label="Firmware archive"
							onchange={(event) => (file = event.currentTarget.files?.[0] ?? null)}
						/>
					</div>
				{/if}
			</label>
		</RadioGroup.Root>

		<div class="flex flex-col gap-3">
			<button
				type="button"
				onclick={() => (showSources = !showSources)}
				class="self-start text-sm text-muted-foreground hover:text-foreground"
			>
				{showSources ? 'Hide firmware sources' : 'Manage firmware sources'}
			</button>
			{#if showSources}
				<div class="flex flex-col gap-3 rounded-xl bg-muted/50 p-4 ring-1 ring-border ring-inset">
					<ul role="list" class="flex flex-col gap-2">
						{#each sources as source (source.url)}
							<li class="flex items-center gap-3 text-base/7 sm:text-sm/6">
								<span class="min-w-0 flex-1 truncate text-muted-foreground">{source.url}</span>
								{#if source.custom}
									<Button variant="secondary" size="sm" onclick={() => removeSource(source.url)}>
										Remove
									</Button>
								{:else}
									<span class="text-sm text-muted-foreground/60">built in</span>
								{/if}
							</li>
						{/each}
					</ul>
					<div class="flex items-center gap-2">
						<Input
							type="url"
							name="manifest-url"
							bind:value={customUrl}
							placeholder="https://example.com/manifest.json"
							aria-label="Manifest URL"
							class="min-w-0 flex-1"
						/>
						<Button variant="secondary" size="sm" onclick={addSource}>Add</Button>
					</div>
					{#if customError}
						<p class="text-base/7 text-destructive sm:text-sm/6">{customError}</p>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<div class="flex items-center gap-3">
		<Button variant="ghost" onclick={() => wizard.back()}>Back</Button>
		<Button disabled={!ready} onclick={submit}>Continue</Button>
	</div>
</div>
