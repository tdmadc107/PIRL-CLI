import type {ColorToken, RoleId} from './theme.js';
import {width, wrapText} from './text.js';

/**
 * Chat content is laid out as styled lines for the current width before it is drawn. Knowing every line
 * lets the chat view show exactly what fits the window, scroll by line, and lay itself out again on resize.
 */
export type Span = {
	text: string;
	color?: ColorToken;
	role?: RoleId;
	bold?: boolean;
	dim?: boolean;
	inverse?: boolean;
	/**
	 * A cell that moves on its own: the spinner, or the time since `since`. `text` holds a placeholder of the
	 * same width for layout; the component that draws it subscribes to the shared ticker (src/ui/ticker.ts).
	 */
	live?: {kind: 'spinner'; frames: readonly string[]} | {kind: 'clock'; since: number};
};
export type Line = Span[];

export const lineWidth = (line: Line) => line.reduce((sum, span) => sum + width(span.text), 0);

/**
 * Wraps `text` after a prefix (an icon or prompt). Continuation lines are indented by the prefix width,
 * so the text keeps one left edge.
 */
export function hanging(prefix: Span[], text: string, columns: number, style: Omit<Span, 'text'> = {}): Line[] {
	const indent = prefix.reduce((sum, span) => sum + width(span.text), 0);
	const body = wrapText(text, Math.max(1, columns - indent));
	return body.map((part, index) => [
		...(index === 0 ? prefix : [{text: ' '.repeat(indent)}]),
		{text: part, ...style},
	]);
}

export const blank: Line = [];
