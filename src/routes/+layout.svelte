<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<title>Terbium</title>
	<meta
		name="description"
		content="Flash custom firmware onto your Spotify Car Thing straight from the browser."
	/>
	<link rel="icon" href={favicon} />
</svelte:head>
{@render children()}
