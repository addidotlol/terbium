<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{page.status} · Terbium</title>
</svelte:head>

<div class="isolate flex min-h-dvh flex-col">
	<header class="grid grid-cols-[1fr_minmax(0,42rem)_1fr] border-b border-border">
		<div></div>
		<div class="flex items-center justify-between border-x border-border p-4">
			<span class="text-base font-semibold tracking-tight">Terbium</span>
		</div>
		<div></div>
	</header>

	<main class="grid flex-1 grid-cols-[1fr_minmax(0,42rem)_1fr]">
		<div></div>
		<div class="flex flex-col gap-6 border-x border-border p-4 pb-16 sm:p-6">
			<div>
				<p class="text-base/7 font-medium text-primary tabular-nums sm:text-sm/6">{page.status}</p>
				<h1 class="mt-2 max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
					{notFound ? "There's nothing at this address" : 'Something went wrong'}
				</h1>
				<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
					{#if notFound}
						Terbium is a single page app! There's nothing for you out here...
					{:else}
						{page.error?.message ?? 'An unexpected error stopped the page from loading.'}
					{/if}
				</p>
			</div>

			<div>
				<a href={resolve('/')} class={buttonVariants()}>Back to Terbium</a>
			</div>
		</div>
		<div></div>
	</main>
</div>
