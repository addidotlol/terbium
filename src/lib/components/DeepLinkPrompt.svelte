<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { DeepLink } from '$lib/flasher/deeplink';

	interface Props {
		open: boolean;
		link: DeepLink | null;
		error: string | null;
		onAccept: () => void;
		onDecline: () => void;
	}

	let { open = $bindable(), link, error, onAccept, onDecline }: Props = $props();

	let settled = false;

	function accept(): void {
		settled = true;
		onAccept();
		open = false;
	}

	function decline(): void {
		if (settled) return;
		settled = true;
		onDecline();
		open = false;
	}
</script>

<Dialog.Root bind:open onOpenChange={(value) => !value && decline()}>
	<Dialog.Content class="sm:max-w-md">
		{#if error}
			<Dialog.Header>
				<Dialog.Title>Couldn't open that link</Dialog.Title>
				<Dialog.Description>{error}</Dialog.Description>
			</Dialog.Header>
			<div>
				<Button onclick={decline}>Continue anyway</Button>
			</div>
		{:else if link}
			<Dialog.Header>
				<Dialog.Title>Flash this firmware?</Dialog.Title>
				<Dialog.Description>
					You were linked straight to a firmware image. Accept and Terbium will skip the picker,
					flashing it once your device is connected.
				</Dialog.Description>
			</Dialog.Header>
			<dl class="flex flex-col gap-2 rounded-xl bg-muted/50 p-4 ring-1 ring-border ring-inset">
				<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
					<dt class="text-muted-foreground">Firmware</dt>
					<dd class="min-w-0 truncate text-right font-medium">{link.selection.name}</dd>
				</div>
				<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
					<dt class="text-muted-foreground">Version</dt>
					<dd class="min-w-0 truncate text-right font-medium">{link.selection.version}</dd>
				</div>
				<div class="flex items-baseline justify-between gap-4 text-base/7 sm:text-sm/6">
					<dt class="text-muted-foreground">Downloaded from</dt>
					<dd class="min-w-0 truncate text-right font-medium">{link.host}</dd>
				</div>
			</dl>
			{#if link.selection.summary}
				<p class="max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
					{link.selection.summary}
				</p>
			{/if}
			{#if !link.verified}
				<Alert.Root variant="destructive">
					<Alert.Title>Unverified archive</Alert.Title>
					<Alert.Description>
						This link carries no checksum, so Terbium can't tell whether {link.host} is serving what the
						person who sent you the link intended. The name and version above came from the link itself
						and can say anything. Only continue if you trust that host.
					</Alert.Description>
				</Alert.Root>
			{/if}
			<div class="flex items-center gap-3">
				<Button variant="ghost" onclick={decline}>Choose manually</Button>
				<Button onclick={accept}>Use this firmware</Button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
