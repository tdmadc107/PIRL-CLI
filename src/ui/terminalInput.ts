/**
 * Sequences the terminal sends that are not typed text. Ink passes some of them on as text with the leading ESC
 * removed, so they would land in the input box:
 * - replies to queries: the kitty keyboard protocol flags (`[?0u`, which a terminal can send after Ink stopped
 *   waiting for it) and device attributes (`[?1;2c`);
 * - mouse reports in SGR form (`[<64;10;5M`), sent while mouse reporting is on (src/bin/main.tsx).
 */
const REPLY = /\x1b?\[\?[\d;]*[uc]/g;
const MOUSE = /\x1b?\[<(\d+);\d+;\d+[Mm]/g;

/** Wheel buttons in an SGR mouse report; the low bits say up (64) or down (65), the rest are modifier keys. */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export type TerminalInput = {
	/** What remains of the chunk as typed text. */
	text: string;
	/** Wheel notches: positive scrolls up (toward older lines), negative down. */
	wheel: number;
	/** Something was taken out, so an empty `text` is not a key press. */
	filtered: boolean;
};

export function parseTerminalInput(input: string): TerminalInput {
	let wheel = 0;
	let filtered = false;
	const text = input
		.replace(REPLY, () => {
			filtered = true;
			return '';
		})
		.replace(MOUSE, (_match, button: string) => {
			filtered = true;
			const code = Number(button) & ~(4 | 8 | 16); // without Shift, Alt and Ctrl
			if (code === WHEEL_UP) wheel += 1;
			else if (code === WHEEL_DOWN) wheel -= 1;
			return '';
		});
	return {text, wheel, filtered};
}

/** Turns SGR mouse reporting on or off: button presses and the wheel are reported, plain movement is not. */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
