<script lang="ts">
	import CarThing from '$lib/carthing/CarThing.svelte';
	import type { ScreenRect } from '$lib/carthing/carthing-engine';
	import { flasher } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';
	import { formatBytes } from '$lib/format';

	const ACCENT = '#34d399';
	const SPOTIFY_GREEN = '#1ed760';
	const SCREEN_BG = '#080a09';
	const SCREEN_TEXT = '#e9fef6';
	const SCREEN_MUTED = 'rgba(233, 254, 246, 0.55)';
	const SCREEN_TRACK = 'rgba(255, 255, 255, 0.12)';

	let ct = $state<CarThing>();
	let ready = $state(false);
	let lastScreenDraw = 0;

	function drawBlack(): void {
		ct?.setScreenDraw((ctx, lcd) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
		});
	}

	function drawHome(): void {
		ct?.setScreenDraw((ctx, lcd) => {
			const s = lcd.w / 800;
			const font = (size: number, weight = 700) =>
				`${weight} ${Math.round(size * s)}px 'Inter Variable', sans-serif`;

			ctx.fillStyle = '#000';
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
			ctx.textAlign = 'left';
			ctx.textBaseline = 'alphabetic';

			const headerX = lcd.x + 44 * s;
			const headerBaseline = lcd.y + 60 * s;
			ctx.font = font(32);
			ctx.fillStyle = '#fff';
			ctx.fillText('Music', headerX, headerBaseline);
			const musicWidth = ctx.measureText('Music').width;
			ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
			ctx.fillText('Podcasts', headerX + musicWidth + 48 * s, headerBaseline);
			const podcastsWidth = ctx.measureText('Podcasts').width;
			ctx.fillText('Your Library', headerX + musicWidth + podcastsWidth + 96 * s, headerBaseline);
			ctx.fillStyle = SPOTIFY_GREEN;
			ctx.fillRect(headerX, headerBaseline + 8 * s, musicWidth, 4 * s);

			const tile = 240 * s;
			const gap = 32 * s;
			const tileY = lcd.y + 112 * s;
			const tiles = [
				{ label: 'Discover Weekly', fill: '#3b4d5c' },
				{ label: 'Release Radar', fill: '#4d3b58' },
				{ label: 'Daily Mix 1', fill: '#39503f' }
			];
			tiles.forEach((entry, index) => {
				const tileX = lcd.x + 50 * s + index * (tile + gap);
				const active = index === 0;
				ctx.globalAlpha = active ? 1 : 0.8;
				ctx.fillStyle = entry.fill;
				ctx.fillRect(tileX, tileY, tile, tile);
				ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
				ctx.beginPath();
				ctx.arc(tileX + tile / 2, tileY + tile / 2, tile * 0.22, 0, Math.PI * 2);
				ctx.fill();
				if (active) {
					ctx.strokeStyle = '#fff';
					ctx.lineWidth = 4 * s;
					ctx.beginPath();
					ctx.roundRect(tileX - 8 * s, tileY - 8 * s, tile + 16 * s, tile + 16 * s, 8 * s);
					ctx.stroke();
				}
				ctx.font = font(32);
				ctx.fillStyle = active ? '#fff' : 'rgba(255, 255, 255, 0.7)';
				ctx.fillText(entry.label, tileX, tileY + tile + 56 * s, tile);
				ctx.globalAlpha = 1;
			});
			ctx.font = font(28, 400);
			ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
			ctx.fillText('Playlist', lcd.x + 50 * s, tileY + tile + 92 * s);
		});
	}

	function drawStatus(title: string, subtitle: string, percent: number | null): void {
		ct?.setScreenDraw((ctx, lcd: ScreenRect) => {
			ctx.fillStyle = SCREEN_BG;
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
			ctx.textAlign = 'center';
			const centerX = lcd.x + lcd.w / 2;

			if (percent !== null) {
				ctx.fillStyle = SCREEN_TEXT;
				ctx.font = `600 ${Math.round(lcd.h * 0.3)}px 'Inter Variable', sans-serif`;
				ctx.textBaseline = 'alphabetic';
				ctx.fillText(`${Math.floor(percent)}%`, centerX, lcd.y + lcd.h * 0.44);
			} else {
				ctx.fillStyle = ACCENT;
				ctx.font = `600 ${Math.round(lcd.h * 0.16)}px 'Inter Variable', sans-serif`;
				ctx.textBaseline = 'middle';
				ctx.fillText('terbium', centerX, lcd.y + lcd.h * 0.38);
			}

			ctx.fillStyle = SCREEN_MUTED;
			ctx.font = `500 ${Math.round(lcd.h * 0.085)}px 'Inter Variable', sans-serif`;
			ctx.textBaseline = 'middle';
			ctx.fillText(title, centerX, lcd.y + lcd.h * 0.58);
			if (subtitle) {
				ctx.fillText(subtitle, centerX, lcd.y + lcd.h * 0.68);
			}

			const barWidth = lcd.w * 0.6;
			const barHeight = Math.max(4, Math.round(lcd.h * 0.02));
			const barX = lcd.x + (lcd.w - barWidth) / 2;
			const barY = lcd.y + lcd.h * 0.8;
			ctx.fillStyle = SCREEN_TRACK;
			ctx.beginPath();
			ctx.roundRect(barX, barY, barWidth, barHeight, barHeight / 2);
			ctx.fill();
			if (percent !== null && percent > 0) {
				ctx.fillStyle = ACCENT;
				ctx.beginPath();
				ctx.roundRect(barX, barY, barWidth * Math.min(1, percent / 100), barHeight, barHeight / 2);
				ctx.fill();
			}
		});
	}

	function drawThrottled(title: string, subtitle: string, percent: number | null): void {
		const now = performance.now();
		if (now - lastScreenDraw < 120) return;
		lastScreenDraw = now;
		drawStatus(title, subtitle, percent);
	}

	$effect(() => {
		const step = wizard.step;
		const model = ct;
		if (!model || !ready) return;

		if (step === 'welcome') {
			model.panTo('front');
			drawHome();
		} else if (step === 'prepare') {
			model.panTo('keys');
			model.flash('preset1', ACCENT, { infinite: true, duration: 1300 });
			model.flash('preset4', ACCENT, { infinite: true, duration: 1300 });
			drawBlack();
		} else if (step === 'connect') {
			if (flasher.connectStatus === 'waiting-reconnect') {
				model.stopFlash('usb');
				drawBlack();
			} else {
				model.panTo('usb');
				model.flash('usb', ACCENT, { infinite: true, duration: 1300 });
				drawBlack();
			}
		} else if (step === 'firmware') {
			model.panTo('front');
			drawBlack();
		} else if (step === 'flash') {
			model.panTo('front');
		} else if (step === 'done') {
			model.panTo('front');
			model.flash('dial', ACCENT, { flashes: 3 });
			drawHome();
		}

		return () => {
			if (step === 'prepare') {
				model.stopFlash('preset1');
				model.stopFlash('preset4');
			} else if (step === 'connect') {
				model.stopFlash('usb');
			}
		};
	});

	$effect(() => {
		const phase = flasher.phase;
		const model = ct;
		if (!model || !ready || wizard.step !== 'flash') return;

		if (phase === 'downloading') {
			const progress = flasher.downloadProgress;
			if (!progress) {
				drawStatus('starting download', '', 0);
			} else if (progress.phase === 'verifying') {
				drawThrottled('verifying download', '', 100);
			} else {
				const percent =
					progress.totalBytes > 0 ? (progress.receivedBytes / progress.totalBytes) * 100 : 0;
				drawThrottled(
					'downloading',
					`${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`,
					percent
				);
			}
		} else if (phase === 'preparing') {
			drawStatus('unpacking archive', '', null);
		} else if (phase === 'flashing') {
			drawThrottled(
				`step ${flasher.stepIndex + 1} of ${flasher.totalSteps}`,
				flasher.stepLabel,
				flasher.overallPercent
			);
		} else if (phase === 'error') {
			drawStatus('flash failed', 'check the log', null);
		} else if (phase === 'connected') {
			drawBlack();
		}
	});
</script>

<CarThing bind:this={ct} defaultUi={false} onready={() => (ready = true)} />
