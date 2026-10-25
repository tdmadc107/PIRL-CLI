import type {MouseSetting} from '../core/config.js';

/**
 * Sequences the terminal sends that are not typed text. Ink passes some of them on as text with the leading ESC
 * removed, so they would land in the input box:
 * - replies to queries: the kitty keyboard protocol flags (`[?0u`, which a terminal can send after Ink stopped
 *   waiting for it) and device attributes (`[?1;2c`);
 * - mouse reports in SGR form (`[<64;10;5M`), sent while mouse reporting is on (src/bin/main.tsx).
 */
const REPLY = /\x1b?\[\?[\d;]*[uc]/g;
const MOUSE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * One mouse report, at a 0-based screen cell. In the SGR form the button code's low two bits name the button
 * (0 left, 1 middle, 2 right, 3 none), 4/8/16 are Shift/Alt/Ctrl, 32 marks movement and 64 the wheel;
 * `M` is a press or a move, `m` a release.
 */
export type MouseEvent =
	| {kind: 'press' | 'release' | 'drag'; button: 'left' | 'middle' | 'right'; x: number; y: number}
	| {kind: 'move'; x: number; y: number}
	| {kind: 'wheel'; notches: 1 | -1; x: number; y: number};

const BUTTONS = ['left', 'middle', 'right'] as const;

function mouseEvent(code: number, column: number, row: number, final: string): MouseEvent {
	const x = column - 1;
	const y = row - 1;
	const plain = code & ~(4 | 8 | 16); // without Shift, Alt and Ctrl
	if (plain & 64) return {kind: 'wheel', notches: (plain & 1) === 0 ? 1 : -1, x, y};
	const button = BUTTONS[plain & 3];
	if (!button) return {kind: 'move', x, y};
	if (plain & 32) return {kind: 'drag', button, x, y};
	return {kind: final === 'm' ? 'release' : 'press', button, x, y};
}

export type TerminalInput = {
	/** What remains of the chunk as typed text. */
	text: string;
	/** Wheel notches: positive scrolls up (toward older lines), negative down. */
	wheel: number;
	/** Every mouse report of the chunk, in order. */
	mouse: MouseEvent[];
	/** Something was taken out, so an empty `text` is not a key press. */
	filtered: boolean;
};

export function parseTerminalInput(input: string): TerminalInput {
	let wheel = 0;
	let filtered = false;
	const mouse: MouseEvent[] = [];
	const text = input
		.replace(REPLY, () => {
			filtered = true;
			return '';
		})
		.replace(MOUSE, (_match, code: string, column: string, row: string, final: string) => {
			filtered = true;
			const event = mouseEvent(Number(code), Number(column), Number(row), final);
			if (event.kind === 'wheel') wheel += event.notches;
			mouse.push(event);
			return '';
		});
	return {text, wheel, mouse, filtered};
}

/** Turns every mouse mode PIRL uses off: SGR mouse reporting with drags, and alternate scroll. */
export const MOUSE_OFF = '\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1007l';

/**
 * What to send the terminal for a mouse setting (src/core/config.ts). `select` turns on SGR reporting of presses,
 * releases, the wheel and movement while a button is held (?1002), so PIRL selects text itself
 * (src/ui/selection.ts). `terminal` turns on alternate scroll: on the alternate screen the terminal sends the wheel
 * as ↑/↓ and keeps dragging for its own selection.
 */
export function mouseSequence(mode: MouseSetting): string {
	if (mode === 'select') return `${MOUSE_OFF}\x1b[?1000h\x1b[?1002h\x1b[?1006h`;
	if (mode === 'terminal') return `${MOUSE_OFF}\x1b[?1007h`;
	return MOUSE_OFF;
}
