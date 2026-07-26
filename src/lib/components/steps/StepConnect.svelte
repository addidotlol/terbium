<script lang="ts">
	import { page } from '$app/state';
	import type { ConnectStatus } from 'libsuperbird';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Alert from '$lib/components/ui/alert';
	import { flasher } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';

	const STAGES: { key: ConnectStatus; label: string }[] = [
		{ key: 'connecting', label: 'Opening the USB connection' },
		{ key: 'bl2-boot', label: 'Sending the bootloader' },
		{ key: 'resetting', label: 'Restarting into burn mode' },
		{ key: 'waiting-reconnect', label: 'Reconnecting to the device' },
		{ key: 'connected', label: 'Connected' }
	];

	const stageIndex = $derived(
		flasher.connectStatus ? STAGES.findIndex((stage) => stage.key === flasher.connectStatus) : -1
	);

	const isLinux =
		typeof navigator !== 'undefined' &&
		/linux/i.test(navigator.userAgent) &&
		!/android/i.test(navigator.userAgent);

	const needsUdevRules = $derived(
		flasher.phase === 'error' &&
			isLinux &&
			/access denied|not allowed|permission/i.test(flasher.error ?? '')
	);

	const installCommand = $derived(`curl -fsSL ${page.url.origin}/install-rules | bash`);

	let copied = $state(false);

	async function copyCommands(): Promise<void> {
		await navigator.clipboard.writeText(installCommand);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

{#if flasher.phase === 'connecting' && flasher.connectStatus === 'waiting-reconnect'}
	<div class="flex flex-col gap-6">
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				Reconnect to your device
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				The device came back with a new identity, so your browser needs permission for it again. It
				may be listed under a different name, like
				<span class="whitespace-nowrap">"Unknown device by Amlogic, Inc."</span>
			</p>
		</div>
		<div>
			<Button onclick={() => flasher.requestBurnDevice()}>Select device</Button>
		</div>
	</div>
{:else}
	<div class="flex flex-col gap-6">
		<div>
			<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
				Connect to your device
			</h2>
			<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
				Your browser will ask which USB device to use. Pick the one called
				<span class="font-medium whitespace-nowrap text-foreground">GX-CHIP</span> and hit connect.
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
			{#if needsUdevRules}
				<Alert.Root variant="destructive">
					<Alert.Title>Access Denied</Alert.Title>
					<Alert.Description>
						It's possible you're missing udev rules on your system. Run the script below in your
						terminal, then try again.
					</Alert.Description>
				</Alert.Root>
				<div class="flex flex-col gap-3">
					<pre
						class="overflow-x-auto rounded-xl bg-black/40 p-3 font-mono text-[0.8125rem]/5 ring-1 ring-border ring-inset"><code
							>{installCommand}</code
						></pre>
					<div>
						<Button variant="secondary" size="sm" onclick={copyCommands}>
							{copied ? 'Copied' : 'Copy commands'}
						</Button>
					</div>
				</div>
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
			</div>
		{:else}
			<div class="flex items-center gap-3">
				<Button variant="ghost" onclick={() => wizard.back()}>Back</Button>
				<Button onclick={() => flasher.connect()}>Connect device</Button>
			</div>
		{/if}
	</div>
{/if}
