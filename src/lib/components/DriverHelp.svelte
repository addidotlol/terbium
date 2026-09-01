<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import { DRIVER_SETUPS, detectPlatform, driverSetup, type DriverPlatform } from '$lib/drivers';

	const detected = detectPlatform();

	// macOS has no tab of its own (it needs nothing), so park it on Windows.
	let selected = $state<DriverPlatform>(detected === 'linux' ? 'linux' : 'windows');

	const setup = $derived(driverSetup(selected) ?? DRIVER_SETUPS[0]);
	const command = $derived(setup.command(page.url.origin));

	let copied = $state(false);

	async function copyCommand(): Promise<void> {
		await navigator.clipboard.writeText(command);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="flex flex-col gap-4">
	{#if detected === 'macos'}
		<p class="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			macOS doesn't need any driver setup. If the device still isn't listed, unplug it, redo the
			button hold, and open the picker again.
		</p>
	{:else}
		<p class="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			Your browser can only see the Car Thing once the right USB driver is bound to it. Run this in
			{setup.shell}, then unplug the device, redo the button hold, and try again.
		</p>
	{/if}

	<Tabs.Root value={selected} onValueChange={(value) => (selected = value as DriverPlatform)}>
		<Tabs.List>
			{#each DRIVER_SETUPS as entry (entry.key)}
				<Tabs.Trigger value={entry.key}>{entry.label}</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>

	<div class="flex flex-col gap-3">
		<pre
			class="overflow-x-auto rounded-xl bg-black/40 p-3 font-mono text-[0.8125rem]/5 ring-1 ring-border ring-inset"><code
				>{command}</code
			></pre>
		<div>
			<Button variant="secondary" size="sm" onclick={copyCommand}>
				{copied ? 'Copied' : 'Copy command'}
			</Button>
		</div>
	</div>

	{#if selected === 'windows'}
		<p class="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			Windows will ask for admin once; it installs drivers for both USB modes the device uses.
		</p>
	{/if}
</div>
