import {EventEmitter} from 'node:events';
import {render} from 'ink';
import type {ReactElement} from 'react';

/** A terminal of a chosen size that records every frame Ink draws; `resize` behaves like dragging the window. */
export class FakeStdout extends EventEmitter {
	readonly isTTY = true;
	frames: string[] = [];
	constructor(
		public columns: number,
		public rows: number,
	) {
		super();
	}
	write = (frame: string) => {
		this.frames.push(frame);
		return true;
	};
	resize(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.emit('resize');
	}
}

export class FakeStdin extends EventEmitter {
	readonly isTTY = true;
	private data: string | null = null;
	write(data: string) {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
	}
	read = () => {
		const data = this.data;
		this.data = null;
		return data;
	};
	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
}

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

export const KEYS = {
	enter: '\r',
	escape: '\u001B',
	tab: '\t',
	backspace: '\u007F',
	up: '\u001B[A',
	down: '\u001B[B',
	right: '\u001B[C',
	left: '\u001B[D',
	pageUp: '\u001B[5~',
	pageDown: '\u001B[6~',
} as const;

export const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

export function renderTerminal(element: ReactElement, columns: number, rows: number, options: {onRender?: (metrics: {renderTime: number}) => void} = {}) {
	const stdout = new FakeStdout(columns, rows);
	const stdin = new FakeStdin();
	const instance = render(element, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		interactive: true,
		exitOnCtrlC: false,
		patchConsole: false,
		onRender: options.onRender,
	});
	return {
		stdout,
		instance,
		/** The latest frame without colors, one string per terminal row. */
		lines: () => stripAnsi(stdout.frames.at(-1) ?? '').split('\n'),
		frame: () => stripAnsi(stdout.frames.at(-1) ?? ''),
		async type(text: string) {
			for (const char of text) {
				stdin.write(char);
				await tick(5);
			}
			await tick();
		},
		async press(key: string) {
			stdin.write(key);
			await tick();
		},
		cleanup: () => instance.unmount(),
	};
}
