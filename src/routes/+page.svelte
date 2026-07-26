<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import HeartIcon from '@lucide/svelte/icons/heart';
	import Console from '$lib/components/Console.svelte';
	import DeepLinkPrompt from '$lib/components/DeepLinkPrompt.svelte';
	import DonateDialog from '$lib/components/DonateDialog.svelte';
	import SettingsDialog from '$lib/components/SettingsDialog.svelte';
	import Stage from '$lib/components/Stage.svelte';
	import StepWelcome from '$lib/components/steps/StepWelcome.svelte';
	import StepPrepare from '$lib/components/steps/StepPrepare.svelte';
	import StepConnect from '$lib/components/steps/StepConnect.svelte';
	import StepFirmware from '$lib/components/steps/StepFirmware.svelte';
	import StepFlash from '$lib/components/steps/StepFlash.svelte';
	import StepDone from '$lib/components/steps/StepDone.svelte';
	import { Button } from '$lib/components/ui/button';
	import { resolveDeepLink, type DeepLink } from '$lib/flasher/deeplink';
	import { flasher, Flasher, type FirmwareSelection } from '$lib/flasher/state.svelte';
	import { settings } from '$lib/settings.svelte';
	import { STEP_ORDER, wizard, type WizardStep } from '$lib/wizard/wizard.svelte';

	let selection = $state<FirmwareSelection | null>(null);
	let deepLink = $state<DeepLink | null>(null);
	let deepLinkError = $state<string | null>(null);
	let deepLinkOpen = $state(false);

	const skipFirmware = $derived(!wizard.steps.includes('firmware'));

	onMount(async () => {
		const params = page.url.searchParams;
		if (!params.has('zip') && !params.has('manifest')) return;
		try {
			const link = await resolveDeepLink(params);
			if (link) {
				deepLink = link;
				deepLinkOpen = true;
			}
		} catch (error) {
			deepLinkError = error instanceof Error ? error.message : String(error);
			deepLinkOpen = true;
		}
	});

	function acceptDeepLink(): void {
		if (!deepLink) return;
		selection = deepLink.selection;
		wizard.setSteps(STEP_ORDER.filter((step): step is WizardStep => step !== 'firmware'));
	}

	function declineDeepLink(): void {
		deepLink = null;
		deepLinkError = null;
		selection = null;
		wizard.setSteps(STEP_ORDER);
	}

	function chooseFirmware(chosen: FirmwareSelection): void {
		selection = chosen;
		wizard.next();
	}

	$effect(() => {
		if (flasher.phase === 'connected' && wizard.step === 'connect') {
			const target = skipFirmware ? 'flash' : 'firmware';
			const timer = setTimeout(() => wizard.goTo(target), 700);
			return () => clearTimeout(timer);
		}
	});

	$effect(() => {
		if (flasher.phase === 'done' && wizard.step === 'flash') wizard.goTo('done');
	});

	$effect(() => {
		if (flasher.phase === 'idle' && (wizard.step === 'firmware' || wizard.step === 'flash')) {
			wizard.goTo('connect');
		}
	});
</script>

<svelte:window
	onbeforeunload={(event) => {
		if (flasher.busy) event.preventDefault();
	}}
/>

<DeepLinkPrompt
	bind:open={deepLinkOpen}
	link={deepLink}
	error={deepLinkError}
	onAccept={acceptDeepLink}
	onDecline={declineDeepLink}
/>

<div class="isolate flex min-h-dvh flex-col">
	<header class="grid grid-cols-[1fr_minmax(0,42rem)_1fr] border-b border-border">
		<div></div>
		<div class="flex items-center justify-between border-x border-border p-4">
			<span class="text-base font-semibold tracking-tight">Terbium</span>
			<SettingsDialog />
		</div>
		<div></div>
	</header>

	<div class="grid grid-cols-[1fr_minmax(0,42rem)_1fr] border-b border-border">
		<div></div>
		<div class="relative h-64 border-x border-border sm:h-80">
			<div class="absolute inset-0"><Stage /></div>
			<p
				class="pointer-events-none absolute inset-x-0 bottom-2.5 text-center text-sm text-muted-foreground/50"
			>
				Drag to rotate
			</p>
		</div>
		<div></div>
	</div>

	<div class="grid grid-cols-[1fr_minmax(0,42rem)_1fr] border-b border-border">
		<div></div>
		<div class="flex items-center justify-between gap-4 border-x border-border px-4 py-2.5">
			{#if wizard.step === 'welcome'}
				<Button class="w-full" disabled={!Flasher.supported()} onclick={() => wizard.next()}>
					Begin
				</Button>
			{:else}
				<div class="flex flex-1 items-center gap-1.5">
					{#each wizard.steps as step, index (step)}
						<div
							class="h-1 flex-1 rounded-full {index <= wizard.index
								? 'bg-primary'
								: 'bg-secondary'}"
						></div>
					{/each}
				</div>
				<span class="shrink-0 text-sm text-muted-foreground tabular-nums">
					Step {wizard.index + 1} of {wizard.steps.length}
				</span>
			{/if}
		</div>
		<div></div>
	</div>

	<main class="grid flex-1 grid-cols-[1fr_minmax(0,42rem)_1fr]">
		<div></div>
		<div class="border-x border-border p-4 pb-16 sm:p-6">
			{#if wizard.step === 'welcome'}
				<StepWelcome />
			{:else if wizard.step === 'prepare'}
				<StepPrepare />
			{:else if wizard.step === 'connect'}
				<StepConnect />
			{:else if wizard.step === 'firmware'}
				<StepFirmware onContinue={chooseFirmware} />
			{:else if wizard.step === 'flash'}
				<StepFlash {selection} />
			{:else}
				<StepDone />
			{/if}
			{#if settings.advancedMode && (flasher.phase === 'connected' || flasher.phase === 'done')}
				<div class="mt-8 border-t border-border pt-6">
					<Console />
				</div>
			{/if}
		</div>
		<div></div>
	</main>

	<footer class="grid grid-cols-[1fr_minmax(0,42rem)_1fr] border-t border-border">
		<div></div>
		<div
			class="flex flex-wrap items-center gap-x-2 gap-y-1 border-x border-border p-4 text-sm text-muted-foreground"
		>
			<span class="flex items-center gap-1">
				made with
				<HeartIcon
					class="size-4 h-lh animate-pulse fill-pink-300 text-pink-300"
					aria-hidden="true"
				/>
				by addi
			</span>
			<span aria-hidden="true">·</span>
			<DonateDialog />
			<span aria-hidden="true">·</span>
			<a
				href="https://github.com/addidotlol/terbium"
				target="_blank"
				rel="noopener noreferrer"
				class="hover:text-foreground"
			>
				github
			</a>
			<span aria-hidden="true">·</span>
			<span class="tabular-nums">20260726.01</span>
		</div>
		<div></div>
	</footer>
</div>
