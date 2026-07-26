<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { flasher } from '$lib/flasher/state.svelte';
	import LogPanel from './LogPanel.svelte';

	let command = $state('');
	let running = $state(false);

	async function run(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const trimmed = command.trim();
		if (!trimmed || running) return;
		running = true;
		try {
			await flasher.runCommand(trimmed);
			command = '';
		} catch {
			command = trimmed;
		} finally {
			running = false;
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div>
		<p class="text-base/7 font-medium sm:text-sm/6">Device console</p>
		<p class="mt-1 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			Runs raw U-Boot commands over the burn protocol. A wrong command here can leave the device
			needing a replug.
		</p>
	</div>
	<form onsubmit={run} class="flex items-center gap-2">
		<Input
			name="command"
			bind:value={command}
			placeholder="printenv"
			aria-label="Command"
			autocomplete="off"
			spellcheck={false}
			class="min-w-0 flex-1 font-mono"
		/>
		<Button type="submit" variant="secondary" size="sm" disabled={running}>Run</Button>
	</form>
	<LogPanel logs={flasher.logs} />
</div>
