import {graphemes, width} from './text.js';

/** Text of the input box and the cursor, as an offset in grapheme clusters (so "ệ" or an emoji is one step). */
export type EditorState = {value: string; cursor: number};

export const emptyEditor: EditorState = {value: '', cursor: 0};

const split = (value: string) => graphemes(value);

export function insert(state: EditorState, text: string): EditorState {
	const parts = split(state.value);
	const added = split(text.replace(/\r\n?/g, '\n'));
	parts.splice(state.cursor, 0, ...added);
	return {value: parts.join(''), cursor: state.cursor + added.length};
}

export function backspace(state: EditorState): EditorState {
	if (state.cursor === 0) return state;
	const parts = split(state.value);
	parts.splice(state.cursor - 1, 1);
	return {value: parts.join(''), cursor: state.cursor - 1};
}

export function move(state: EditorState, to: 'left' | 'right' | 'home' | 'end'): EditorState {
	const length = split(state.value).length;
	const cursor =
		to === 'left' ? Math.max(0, state.cursor - 1) : to === 'right' ? Math.min(length, state.cursor + 1) : to === 'home' ? 0 : length;
	return {...state, cursor};
}

export const setValue = (value: string): EditorState => ({value, cursor: split(value).length});

/** Where the cursor sits after the text is wrapped to the box: visual lines plus the cursor's line and column. */
export type EditorLayout = {lines: string[]; cursorLine: number; cursorColumn: number};

/**
 * Wraps at the last space of a line, like the chat text, and inside a word only when the word is longer
 * than the line. Every grapheme keeps its index, so the cursor is found after wrapping.
 */
export function layoutEditor(state: EditorState, columns: number): EditorLayout {
	const room = Math.max(1, columns);
	const parts = split(state.value);
	const rows: number[][] = [[]];
	const rowWidth = (row: number[]) => row.reduce((sum, index) => sum + width(parts[index]!), 0);
	/** Where each "\n" sits: at the end of the row it closes. */
	const breaks = new Map<number, number>();
	parts.forEach((part, index) => {
		let row = rows[rows.length - 1]!;
		if (part === '\n') {
			breaks.set(index, rows.length - 1);
			rows.push([]);
			return;
		}
		if (rowWidth(row) + width(part) > room) {
			const space = part === ' ' ? -1 : row.findLastIndex(i => parts[i] === ' ');
			const carried = space >= 0 ? row.splice(space + 1) : [];
			row = [...carried];
			rows.push(row);
		}
		row.push(index);
	});
	let cursorLine = rows.length - 1;
	let cursorColumn = rowWidth(rows[cursorLine]!);
	if (state.cursor < parts.length) {
		const line = breaks.get(state.cursor) ?? rows.findIndex(row => row.includes(state.cursor));
		const row = rows[line]!;
		cursorLine = line;
		cursorColumn = rowWidth(breaks.has(state.cursor) ? row : row.slice(0, row.indexOf(state.cursor)));
	}
	const lines = rows.map(row => row.map(index => parts[index]).join(''));
	// The cursor needs a cell of its own: after the last character of a full row it starts the next row;
	// before a line break that ends a full row it stays on the row's last cell.
	if (cursorColumn >= room) {
		if (state.cursor >= parts.length) {
			lines.push('');
			cursorLine += 1;
			cursorColumn = 0;
		} else {
			cursorColumn = room - 1;
		}
	}
	return {lines, cursorLine, cursorColumn};
}
