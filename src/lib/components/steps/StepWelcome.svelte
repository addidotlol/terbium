<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert';
	import { Flasher } from '$lib/flasher/state.svelte';

	const supported = Flasher.supported();

	const requirements = [
		'A Car Thing and a USB-A to USB-C cable',
		'A Chromium-based browser like Chrome or Edge',
		'About five minutes'
	];
</script>

<div class="flex flex-col gap-6">
	<div>
		<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
			Revive your Car Thing
		</h2>
		<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			Terbium installs custom firmware on the Spotify Car Thing from your browser. You'll need:
		</p>
	</div>

	<ul role="list" class="flex flex-col gap-2.5">
		{#each requirements as requirement (requirement)}
			<li class="flex items-start gap-2.5 text-base/7 sm:text-sm/6">
				<CheckIcon class="size-4 h-lh shrink-0 text-primary" aria-hidden="true" />
				<span>{requirement}</span>
			</li>
		{/each}
	</ul>

	{#if supported}
		<p class="flex items-start gap-2.5 text-base/7 text-amber-200/90 sm:text-sm/6">
			<TriangleAlertIcon class="size-4 h-lh shrink-0 text-amber-300" aria-hidden="true" />
			<span>Flashing wipes the device, stock Spotify software included.</span>
		</p>
	{:else}
		<Alert.Root class="border-amber-400/25 bg-amber-400/10 text-amber-200">
			<TriangleAlertIcon class="text-amber-300" aria-hidden="true" />
			<Alert.Title>This browser can't flash</Alert.Title>
			<Alert.Description class="text-amber-200/80">
				Terbium talks to the device over WebUSB, which this browser doesn't have. Chrome and Edge
				both work.
			</Alert.Description>
		</Alert.Root>
	{/if}
</div>
