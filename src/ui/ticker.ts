import {useSyncExternalStore} from 'react';

/**
 * One shared clock for everything that moves (spinners, elapsed time). Only the small components that show a
 * moving value subscribe, so a tick redraws those cells and never the whole TUI. The timer runs only while
 * something is subscribed: with no run working, nothing ticks.
 */

/**
 * Time per spinner frame. Each frame redraws the whole Ink frame (about 20 ms of CPU on a 160x45 window), so the
 * spinner turns at 5 frames a second with a 6-frame cycle: it still reads as motion and costs half of 10 fps.
 */
export const SPINNER_MS = 200;
let interval = SPINNER_MS;
let now = Date.now();
let timer: NodeJS.Timeout | null = null;
const listeners = new Set<() => void>();

function start() {
	timer = setInterval(() => {
		now = Date.now();
		for (const listener of listeners) listener();
	}, interval);
	timer.unref?.();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!timer) {
		now = Date.now();
		start();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = null;
		}
	};
}

/** 200 ms with motion on (the spinner turns), 1000 ms with motion off (only the clock moves). */
export function setTickInterval(ms: number) {
	if (ms === interval) return;
	interval = ms;
	if (timer) {
		clearInterval(timer);
		start();
	}
}

export const useNow = () => useSyncExternalStore(subscribe, () => now);
