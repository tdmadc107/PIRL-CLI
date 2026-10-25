import type {Line, Span} from './lines.js';
import {graphemes, width} from './text.js';

/**
 * Text selection made by PIRL itself, in the chat or the open panel (mouse setting `select`, src/core/config.ts).
 * A point is a content line and a display column in it, not a screen cell: the selection stays on the same text
 * while the view scrolls, so a drag can go on across more than one screen.
 */
export type Point = {line: number; col: number};

export type Selection = {
	/** Which content the points refer to. */
	area: 'chat' | 'overlay';
	/** Where the drag started, and where the pointer is (or was released). */
	anchor: Point;
	focus: Point;
};

/**
 * Where a content area sits on the screen: the visible content lines, and how to scroll it. Rows and columns are
 * 0-based screen cells.
 */
export type SelectArea = {
	area: Selection['area'];
	lines: Line[];
	/** Index in `lines` of the first visible line, and how many are visible. */
	firstLine: number;
	count: number;
	/** Screen row of the first visible line, and screen column where text starts. */
	top: number;
	left: number;
	/** Screen columns the area spans (text and padding), so a click beside it is not a click in it. */
	right: number;
	/** Screen rows of the whole area, markers and borders included. */
	rowsFrom: number;
	rowsTo: number;
};

const before = (a: Point, b: Point) => a.line < b.line || (a.line === b.line && a.col <= b.col);

/** The selection's start and end, in reading order. */
export function ordered(selection: Selection): [Point, Point] {
	return before(selection.anchor, selection.focus) ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
}

/** A press and release on the same cell is a click, not a selection. */
export const isEmpty = (selection: Selection) => selection.anchor.line === selection.focus.line && selection.anchor.col === selection.focus.col;

/** Whether a screen cell is inside the area (its borders and markers included). */
export const contains = (area: SelectArea, x: number, y: number) => y >= area.rowsFrom && y <= area.rowsTo && x < area.right;

/**
 * The content point under a screen cell. Above or below the visible lines it is the first or last visible line,
 * and `beyond` says which way the view should scroll to follow the pointer.
 */
export function pointAt(area: SelectArea, x: number, y: number): {point: Point; beyond: -1 | 0 | 1} {
	const col = Math.max(0, x - area.left);
	if (area.count === 0) return {point: {line: area.firstLine, col: 0}, beyond: 0};
	if (y < area.top) return {point: {line: area.firstLine, col: 0}, beyond: -1};
	if (y >= area.top + area.count) return {point: {line: area.firstLine + area.count - 1, col: Number.MAX_SAFE_INTEGER}, beyond: 1};
	return {point: {line: area.firstLine + (y - area.top), col}, beyond: 0};
}

/** The selected display columns of one line, as [from, to), or null when the line is not selected. */
export function columnsOf(selection: Selection, line: number): [number, number] | null {
	const [start, end] = ordered(selection);
	if (line < start.line || line > end.line) return null;
	return [line === start.line ? start.col : 0, line === end.line ? end.col + 1 : Number.MAX_SAFE_INTEGER];
}

/** Calls `visit` for each grapheme of the line with the display column it starts at. */
function eachGrapheme(line: Line, visit: (part: string, column: number, cells: number, span: Span) => void) {
	let column = 0;
	for (const span of line) {
		for (const part of graphemes(span.text)) {
			const cells = width(part);
			visit(part, column, cells, span);
			column += cells;
		}
	}
}

/** A grapheme is selected when any of its cells is: a wide character is taken whole. */
const within = (column: number, cells: number, [from, to]: [number, number]) => column + Math.max(1, cells) > from && column < to;

/** The text of a line between two display columns. */
export function sliceText(line: Line, range: [number, number]): string {
	let text = '';
	eachGrapheme(line, (part, column, cells) => {
		if (within(column, cells, range)) text += part;
	});
	return text;
}

/** The line with its selected columns drawn in reverse video, the way a terminal shows a selection. */
export function highlight(line: Line, range: [number, number]): Line {
	const out: Line = [];
	const push = (span: Span, text: string, selected: boolean) => {
		const style: Span = {...span, text, inverse: selected ? !span.inverse : span.inverse};
		const last = out.at(-1);
		if (last && last.live === undefined && span.live === undefined && last.inverse === style.inverse && last.color === style.color && last.role === style.role && last.bold === style.bold && last.dim === style.dim) {
			last.text += text;
		} else {
			out.push(style);
		}
	};
	let column = 0;
	for (const span of line) {
		// A live cell (spinner, clock) redraws itself; it is kept whole.
		if (span.live) {
			push(span, span.text, within(column, width(span.text), range));
			column += width(span.text);
			continue;
		}
		for (const part of graphemes(span.text)) {
			const cells = width(part);
			push(span, part, within(column, cells, range));
			column += cells;
		}
	}
	return out;
}

/**
 * The selected text: each line cut to its selected columns and stripped of trailing spaces, joined with line
 * breaks. The indentation the selected lines share on screen (the chat's or the panel's own) is removed, measured
 * on the whole lines, so the text keeps its own indentation relative to its least indented line.
 */
export function selectedText(lines: Line[], selection: Selection): string {
	const [start, end] = ordered(selection);
	const leading = (text: string) => text.length - text.trimStart().length;
	const rows: Array<{part: string; from: number; whole: string}> = [];
	for (let index = start.line; index <= end.line && index < lines.length; index++) {
		const range = columnsOf(selection, index)!;
		const line = lines[index] ?? [];
		rows.push({part: sliceText(line, range).replace(/\s+$/, ''), from: range[0], whole: sliceText(line, [0, Number.MAX_SAFE_INTEGER])});
	}
	const indents = rows.filter(row => row.whole.trim() !== '').map(row => leading(row.whole));
	const shared = indents.length > 0 ? Math.min(...indents) : 0;
	return rows
		.map(row => row.part.slice(Math.min(Math.max(0, shared - row.from), leading(row.part))))
		.join('\n')
		.replace(/^\n+|\n+$/g, '');
}

/** The lines of `area` from `firstLine`, with the selected ones highlighted. */
export function highlightVisible(lines: Line[], firstLine: number, selection: Selection | null, area: Selection['area']): Line[] {
	if (!selection || selection.area !== area || isEmpty(selection)) return lines;
	return lines.map((line, index) => {
		const range = columnsOf(selection, firstLine + index);
		return range ? highlight(line, range) : line;
	});
}
