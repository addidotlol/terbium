<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { wizard } from '$lib/wizard/wizard.svelte';

	const instructions = [
		'Unplug the Car Thing completely.',
		'Hold preset buttons 1 and 4.',
		'Plug the cable back in while still holding both.'
	];
</script>

<div class="flex flex-col gap-6">
	<div>
		<h2 class="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
			Put it in USB mode
		</h2>
		<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			The Car Thing only accepts firmware in USB burn mode. To get it there:
		</p>
	</div>

	<ol role="list" class="flex flex-col gap-4">
		{#each instructions as instruction, index (instruction)}
			<li class="flex items-start gap-3 text-base/7 sm:text-sm/6">
				<span class="flex h-lh shrink-0 items-center">
					<span
						class="flex size-6 items-center justify-center bg-secondary text-sm font-medium tabular-nums"
					>
						{index + 1}
					</span>
				</span>
				<span>{instruction}</span>
			</li>
		{/each}
	</ol>

	<p class="max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
		A black screen means it worked. If Spotify boots, unplug and try again.
	</p>

	<div class="flex items-center gap-3">
		<Button variant="ghost" onclick={() => wizard.back()}>Back</Button>
		<Button onclick={() => wizard.next()}>It's plugged in</Button>
	</div>
</div>
