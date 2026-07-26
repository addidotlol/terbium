<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '$lib/components/ui/button';
	import { flasher } from '$lib/flasher/state.svelte';
	import { STEP_ORDER, wizard } from '$lib/wizard/wizard.svelte';
	import DonateDialog from '../DonateDialog.svelte';

	function flashAnother(): void {
		flasher.readyForNextFlash();
		wizard.setSteps(STEP_ORDER);
		wizard.goTo('firmware');
	}
</script>

<div class="flex flex-col gap-6">
	<div>
		<p class="flex items-center gap-2 text-base/7 font-medium text-primary sm:text-sm/6">
			<CheckIcon class="size-4 h-lh shrink-0" aria-hidden="true" />
			<span>Flash complete</span>
		</p>
		<h2 class="mt-2 max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">That's it</h2>
		<p class="mt-3 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
			{flasher.flashedName} is on the device. Unplug it and plug it back in without holding any buttons,
			and it'll start into the new firmware.
		</p>
	</div>

	<div class="flex items-center gap-3">
		<Button variant="ghost" onclick={flashAnother}>Flash something else</Button>
		<DonateDialog variant="button" />
	</div>
</div>
