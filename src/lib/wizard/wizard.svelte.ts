export type WizardStep = 'welcome' | 'prepare' | 'connect' | 'firmware' | 'flash' | 'done';

export const STEP_ORDER: WizardStep[] = [
	'welcome',
	'prepare',
	'connect',
	'firmware',
	'flash',
	'done'
];

export const STEP_TITLES: Record<WizardStep, string> = {
	welcome: 'Welcome',
	prepare: 'USB mode',
	connect: 'Connect',
	firmware: 'Firmware',
	flash: 'Flash',
	done: 'Done'
};

export class Wizard {
	step = $state<WizardStep>('welcome');
	steps = $state<WizardStep[]>(STEP_ORDER);

	get index(): number {
		return this.steps.indexOf(this.step);
	}

	setSteps(steps: WizardStep[]): void {
		this.steps = steps;
	}

	goTo(step: WizardStep): void {
		this.step = step;
	}

	next(): void {
		const target = this.steps[this.index + 1];
		if (target) this.step = target;
	}

	back(): void {
		const target = this.steps[this.index - 1];
		if (target) this.step = target;
	}
}

export const wizard = new Wizard();
