<script lang="ts">
	import type { ConnectStatus } from '$lib/flasher/state.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Alert from '$lib/components/ui/alert';
	import * as Dialog from '$lib/components/ui/dialog';
	import DriverHelp from '$lib/components/DriverHelp.svelte';
	import { detectPlatform } from '$lib/drivers';
	import { flasher } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';

	const STAGES: { key: ConnectStatus; label: string }[] = [
		{ key: 'connecting', label: 'Opening the USB connection' },
		{ key: 'bootstrapping', label: 'Sending the bootloader' },
		{ key: 'waiting-fastboot', label: 'Reconnecting to the device' },
		{ key: 'connected', label: 'Connected' }
	];

	const stageIndex = $derived(
		flasher.connectStatus ? STAGES.findIndex((stage) => stage.key === flasher.connectStatus) : -1
	);

	const platform = detectPlatform();

	// macOS binds no driver of its own, so a permission error there is not
	// something the setup command can fix.
	const needsDrivers = $derived(
		flasher.phase === 'error' &&
			platform !== null &&
			platform !== 'macos' &&
			/access denied|not allowed|permission/i.test(flasher.error ?? '')
	);
</script>

{#snippet driverHelp()}
	<Dialog.Root>
		<Dialog.Trigger class={buttonVariants({ variant: 'ghost' })}>
			Don't see your device?
		</Dialog.Trigger>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>Don't see your device?</Dialog.Title>
			</Dialog.Header>
			<DriverHelp />
		</Dialog.Content>
	</Dialog.Root>
{/snippet}

{#if flasher.phase === 'connecting' && flasher.connectStatus === 'waiting-fastboot'}
	<div class="flex flex-col gap-6">
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				Reconnect to your device
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				The device came back with a new identity, so your browser needs permission for it again.
				This time it's listed as
				<span class="font-medium whitespace-nowrap text-foreground">Superbird</span>.
			</p>
		</div>
		<div class="flex items-center gap-3">
			<Button onclick={() => flasher.requestFastbootDevice()}>Select device</Button>
			{@render driverHelp()}
		</div>
	</div>
{:else}
	<div class="flex flex-col gap-6">
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				Connect to your device
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				Your browser will ask which USB device to use. Pick
				<span class="font-medium whitespace-nowrap text-foreground">GX-CHIP</span> (or
				<span class="font-medium whitespace-nowrap text-foreground">Superbird</span> if your device is
				already in fastboot) and hit connect.
			</p>
		</div>

		{#if flasher.phase === 'connecting' || flasher.phase === 'connected'}
			<ul role="list" class="flex flex-col gap-3">
				{#each STAGES as stage, index (stage.key)}
					<li
						class="flex items-start gap-2.5 text-base/7 sm:text-sm/6 {index > stageIndex
							? 'text-muted-foreground/60'
							: ''}"
					>
						{#if index < stageIndex || flasher.phase === 'connected'}
							<CheckIcon class="size-4 h-lh shrink-0 text-primary" aria-hidden="true" />
						{:else if index === stageIndex}
							<span class="flex h-lh items-center"><Spinner class="text-primary" /></span>
						{:else}
							<span class="flex size-4 h-lh shrink-0 items-center justify-center">
								<span class="size-1.5 rounded-full bg-secondary"></span>
							</span>
						{/if}
						<span>{stage.label}</span>
					</li>
				{/each}
			</ul>
		{:else if flasher.phase === 'error'}
			{#if needsDrivers}
				<Alert.Root variant="destructive">
					<Alert.Title>Access Denied</Alert.Title>
					<Alert.Description>
						Your system hasn't given the browser access to the device. Run the setup command below,
						then try again.
					</Alert.Description>
				</Alert.Root>
				<DriverHelp />
			{:else}
				<Alert.Root variant="destructive">
					<Alert.Title>Couldn't connect</Alert.Title>
					<Alert.Description>
						{flasher.error}. Unplug the device, redo the button hold, and try again.
					</Alert.Description>
				</Alert.Root>
			{/if}
			<div class="flex items-center gap-3">
				<Button
					variant="ghost"
					onclick={() => {
						flasher.reset();
						wizard.back();
					}}
				>
					Back
				</Button>
				<Button
					onclick={() => {
						flasher.reset();
						flasher.connect();
					}}
				>
					Try again
				</Button>
				{@render driverHelp()}
			</div>
		{:else}
			<div class="flex items-center gap-3">
				<Button variant="ghost" onclick={() => wizard.back()}>Back</Button>
				<Button onclick={() => flasher.connect()}>Connect device</Button>
				{@render driverHelp()}
			</div>
		{/if}
	</div>
{/if}
