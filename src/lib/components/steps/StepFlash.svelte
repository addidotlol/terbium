<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Alert from '$lib/components/ui/alert';
	import * as Dialog from '$lib/components/ui/dialog';
	import { flasher, type FirmwareSelection } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';
	import { formatBytes, formatEta, formatRate } from '$lib/format';
	import LogPanel from '../LogPanel.svelte';

	interface Props {
		selection: FirmwareSelection | null;
	}

	let { selection }: Props = $props();
	let showLog = $state(false);
	let confirmCancel = $state(false);

	function startOver(): void {
		flasher.reset();
		wizard.goTo('prepare');
	}

	function cancelFlash(): void {
		confirmCancel = false;
		flasher.cancelFlash();
	}

	const download = $derived(flasher.downloadProgress);
	const downloadPercent = $derived(
		download && download.totalBytes > 0 ? (download.receivedBytes / download.totalBytes) * 100 : 0
	);
</script>

<div class="flex flex-col gap-6">
	{#if flasher.phase === 'connected'}
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				Ready to flash
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				This wipes the device and installs the build below. Double-check the version, then go.
			</p>
		</div>

		{#if selection}
			<dl class="flex flex-col gap-2 rounded-xl bg-muted/50 p-4 ring-1 ring-border ring-inset">
				<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
					<dt class="text-muted-foreground">Firmware</dt>
					<dd class="min-w-0 truncate text-right font-medium">{selection.name}</dd>
				</div>
				<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
					<dt class="text-muted-foreground">Version</dt>
					<dd class="min-w-0 truncate text-right font-medium">{selection.version}</dd>
				</div>
				{#if selection.release}
					<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
						<dt class="text-muted-foreground">Download</dt>
						<dd class="text-right font-medium">{formatBytes(selection.release.download.size)}</dd>
					</div>
				{/if}
			</dl>
		{/if}

		<div class="flex items-center gap-3">
			<Button variant="ghost" onclick={() => wizard.back()}>Back</Button>
			<Button onclick={() => selection && flasher.flash(selection)}>Flash firmware</Button>
		</div>
	{:else if flasher.phase === 'error'}
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				{#if flasher.interrupted === 'disconnected'}
					The device came unplugged
				{:else if flasher.interrupted === 'cancelled'}
					Flash cancelled
				{:else}
					The flash failed
				{/if}
			</h2>
		</div>
		<Alert.Root variant="destructive">
			<Alert.Description>{flasher.error}</Alert.Description>
		</Alert.Root>
		{#if flasher.interrupted}
			<p class="max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				The partition being written was left incomplete. It's highly likely that your device will not
				successfully boot until this is fixed. Press <b>Start Over</b> below and try again.
			</p>
		{:else}
			<p class="max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				Your device is likely okay. Retry, or unplug, redo the
				button hold, and start again from the connect step.
			</p>
		{/if}
		<div class="flex items-center gap-3">
			<Button
				variant={flasher.interrupted === 'disconnected' ? 'default' : 'ghost'}
				onclick={startOver}
			>
				Start over
			</Button>
			{#if flasher.interrupted !== 'disconnected'}
				<Button onclick={() => selection && flasher.flash(selection)}>
					{flasher.interrupted === 'cancelled' ? 'Flash again' : 'Try again'}
				</Button>
			{/if}
		</div>
	{:else}
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				{#if flasher.phase === 'downloading'}
					{download?.phase === 'verifying' ? 'Verifying download' : 'Downloading firmware'}
				{:else if flasher.phase === 'preparing'}
					Unpacking archive
				{:else}
					Flashing firmware
				{/if}
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				Keep the cable in and this tab open until it's done.
			</p>
		</div>

		{#if flasher.phase === 'downloading' && download}
			<div class="flex flex-col gap-2.5">
				<Progress value={downloadPercent} />
				<p class="text-base/7 text-muted-foreground tabular-nums sm:text-sm/6">
					{formatBytes(download.receivedBytes)} of {formatBytes(download.totalBytes)}
					{#if download.phase === 'downloading'}
						· {formatRate(download.bytesPerSecond)}
					{/if}
				</p>
			</div>
		{:else if flasher.phase === 'preparing' || (flasher.phase === 'downloading' && !download)}
			<div class="flex items-center gap-2.5 text-base/7 text-muted-foreground sm:text-sm/6">
				<Spinner class="text-primary" />
				<span>Starting</span>
			</div>
		{:else if flasher.phase === 'flashing'}
			<div class="flex flex-col gap-2.5">
				<p class="text-3xl font-semibold tracking-tight tabular-nums">
					{Math.floor(flasher.overallPercent)}%
				</p>
				<Progress value={flasher.overallPercent} />
				<p class="text-base/7 text-muted-foreground sm:text-sm/6">
					Step <span class="tabular-nums">{flasher.stepIndex + 1} of {flasher.totalSteps}</span>:
					{flasher.stepLabel}
				</p>
				{#if flasher.stepProgress && flasher.stepProgress.totalBytes > 0}
					<p class="text-base/7 text-muted-foreground tabular-nums sm:text-sm/6">
						{formatRate(flasher.stepProgress.rateKiBps * 1024)} · about {formatEta(
							flasher.stepProgress.etaMs
						)} left in this step
					</p>
				{/if}
			</div>
		{/if}

		<div class="flex items-center gap-3">
			<Button variant="destructive" size="sm" onclick={() => (confirmCancel = true)}>Cancel</Button>
			<Button variant="ghost" size="sm" onclick={() => (showLog = !showLog)}>
				{showLog ? 'Hide log' : 'Show log'}
			</Button>
		</div>
	{/if}

	<Dialog.Root bind:open={confirmCancel}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Cancel the flash?</Dialog.Title>
				<Dialog.Description>
					Whatever partition is being written right now will be left half-finished, and the device
					won't boot until you flash it through to the end. Leave the cable in either way.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex items-center gap-3">
				<Button variant="ghost" onclick={() => (confirmCancel = false)}>Keep flashing</Button>
				<Button variant="destructive" onclick={cancelFlash}>Cancel flash</Button>
			</div>
		</Dialog.Content>
	</Dialog.Root>

	{#if showLog || flasher.phase === 'error'}
		<LogPanel logs={flasher.logs} />
	{/if}
</div>
