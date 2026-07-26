<script lang="ts">
	import HeartIcon from '@lucide/svelte/icons/heart';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		variant?: 'link' | 'button';
	}

	let { variant = 'link' }: Props = $props();
</script>

<Dialog.Root>
	<Dialog.Trigger class={variant === 'button' ? buttonVariants() : 'hover:text-foreground'}>
		{#if variant === 'button'}
			<HeartIcon class="fill-current" aria-hidden="true" />
			Donate
		{:else}
			donate
		{/if}
	</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Support Terbium</Dialog.Title>
		</Dialog.Header>
		<div class="flex flex-col gap-4 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			<p>
				Building Terbium and Thingify ends up costing me a decent bit of money, but despite that I
				will never place ads on these tools nor will I ever charge for these tools.
			</p>
			<p>
				If you'd like to support, I'd really appreciate a donation. Even $1 helps a whole bunch and
				allows me to continue providing these tools to the community.
			</p>
			<p>
				Thanks<br />
				- addi &lt;3
			</p>
		</div>
		<div class="flex items-center gap-3">
			<Dialog.Close class={buttonVariants({ variant: 'ghost' })}>Maybe later</Dialog.Close>
			<a
				href="https://addi.lol/donate"
				target="_blank"
				rel="noopener noreferrer"
				class={buttonVariants()}
			>
				<HeartIcon class="fill-current" aria-hidden="true" />
				Donate
			</a>
		</div>
	</Dialog.Content>
</Dialog.Root>
