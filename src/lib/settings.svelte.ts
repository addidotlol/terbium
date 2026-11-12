const STORAGE_KEY = 'terbium.settings';

interface StoredSettings {
	forceSparse?: boolean;
	advancedMode?: boolean;
	useBurnMode?: boolean;
}

function stored(): StoredSettings {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as StoredSettings;
	} catch {
		return {};
	}
}

class Settings {
	forceSparse = $state(stored().forceSparse ?? false);
	advancedMode = $state(stored().advancedMode ?? false);
	useBurnMode = $state(stored().useBurnMode ?? false);
	customBl2 = $state<File | null>(null);
	customBootloader = $state<File | null>(null);

	save(): void {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				forceSparse: this.forceSparse,
				advancedMode: this.advancedMode,
				useBurnMode: this.useBurnMode
			})
		);
	}
}

export const settings = new Settings();
