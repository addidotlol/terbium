<script lang="ts">
	import type { LogLine } from '$lib/flasher/state.svelte';

	let { logs }: { logs: LogLine[] } = $props();

	const kindClasses = {
		info: 'text-muted-foreground',
		error: 'text-destructive',
		command: 'text-primary'
	};
</script>

<div
	class="max-h-56 overflow-y-auto rounded-xl bg-black/40 p-3 font-mono text-[0.8125rem]/5 ring-1 ring-border ring-inset"
>
	{#each logs as line, index (index)}
		<p class="{kindClasses[line.kind]} break-words">
			{line.message}
		</p>
	{/each}
</div>
