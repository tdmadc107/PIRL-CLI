import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

/** Display width in terminal cells: Vietnamese combining marks take 0, CJK and emoji take 2. */
export const width = (text: string) => stringWidth(text);

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
export const graphemes = (text: string) => Array.from(segmenter.segment(text), part => part.segment);

/** Cuts text to at most `max` cells, ending with the ellipsis when anything was cut. */
export function truncateEnd(text: string, max: number, ellipsis = '…'): string {
	if (width(text) <= max) return text;
	if (max <= width(ellipsis)) return graphemesWithin(text, max);
	return graphemesWithin(text, max - width(ellipsis)) + ellipsis;
}

/** Keeps both ends of a long path: `src/orders/cancel.ts` → `src/…/cancel.ts`. */
export function truncateMiddle(text: string, max: number, ellipsis = '…'): string {
	if (width(text) <= max) return text;
	const room = max - width(ellipsis);
	if (room <= 1) return truncateEnd(text, max, ellipsis);
	const tailRoom = Math.ceil(room / 2);
	const tail = graphemesFromEnd(text, tailRoom);
	const head = graphemesWithin(text, room - width(tail));
	return head + ellipsis + tail;
}

function graphemesWithin(text: string, max: number): string {
	let out = '';
	let used = 0;
	for (const g of graphemes(text)) {
		const w = width(g);
		if (used + w > max) break;
		out += g;
		used += w;
	}
	return out;
}

function graphemesFromEnd(text: string, max: number): string {
	const parts = graphemes(text);
	let out = '';
	let used = 0;
	for (let i = parts.length - 1; i >= 0; i--) {
		const w = width(parts[i]!);
		if (used + w > max) break;
		out = parts[i]! + out;
		used += w;
	}
	return out;
}

/** Wraps plain text to `columns` cells: at spaces when possible, inside a word only when it is longer than a line. */
/**
 * Tabs as spaces, to the next multiple of four. A terminal draws a tab as a jump to its next tab stop, but its
 * measured width is 0, so a tab left in a line would push the rest of it out of place.
 */
export function expandTabs(text: string): string {
	if (!text.includes('\t')) return text;
	return text
		.split('\n')
		.map(line => {
			let out = '';
			for (const part of line.split('\t').slice(0, -1)) {
				out += part;
				out += ' '.repeat(4 - (width(out) % 4));
			}
			return out + line.slice(line.lastIndexOf('\t') + 1);
		})
		.join('\n');
}

export function wrapText(text: string, columns: number): string[] {
	if (columns <= 0) return [];
	return expandTabs(text).split('\n').flatMap(paragraph =>
		paragraph === '' ? [''] : wrapAnsi(paragraph, columns, {hard: true, trim: true, wordWrap: true}).split('\n'),
	);
}

export const padEnd = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - width(text)));
