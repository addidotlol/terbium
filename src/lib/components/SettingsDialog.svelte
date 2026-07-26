<script lang="ts">
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Dialog from '$lib/components/ui/dialog';
	import { settings } from '$lib/settings.svelte';
</script>

<Dialog.Root>
	<Dialog.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		aria-label="Settings"
	>
		<SettingsIcon />
	</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Settings</Dialog.Title>
		</Dialog.Header>
		<div class="flex flex-col gap-6">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<Label for="force-sparse">Force sparse flashing</Label>
					<p class="mt-1 text-base/6 text-pretty text-muted-foreground sm:text-sm/5">
						Skip all-zero chunks even when the archive doesn't ask for it.
					</p>
				</div>
				<span class="flex h-lh shrink-0 items-center text-sm">
					<Switch
						id="force-sparse"
						bind:checked={settings.forceSparse}
						onCheckedChange={() => settings.save()}
					/>
				</span>
			</div>

			<div class="flex flex-col gap-3">
				<div>
					<p class="text-sm font-medium">Overwrite BL2 & bootloader images</p>
					<p class="mt-1 text-base/6 text-pretty text-muted-foreground sm:text-sm/5">
						Used when connecting instead of the bundled images. Cleared on reload.
					</p>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="custom-bl2" class="text-muted-foreground">BL2</Label>
					<Input
						id="custom-bl2"
						type="file"
						name="custom-bl2"
						accept=".bin"
						onchange={(event) => (settings.customBl2 = event.currentTarget.files?.[0] ?? null)}
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="custom-bootloader" class="text-muted-foreground">Bootloader</Label>
					<Input
						id="custom-bootloader"
						type="file"
						name="custom-bootloader"
						accept=".img"
						onchange={(event) =>
							(settings.customBootloader = event.currentTarget.files?.[0] ?? null)}
					/>
				</div>
			</div>

			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<Label for="advanced-mode">Advanced mode</Label>
					<p class="mt-1 text-base/6 text-pretty text-muted-foreground sm:text-sm/5">
						Adds a device console for running raw burn-mode commands.
					</p>
				</div>
				<span class="flex h-lh shrink-0 items-center text-sm">
					<Switch
						id="advanced-mode"
						bind:checked={settings.advancedMode}
						onCheckedChange={() => settings.save()}
					/>
				</span>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
