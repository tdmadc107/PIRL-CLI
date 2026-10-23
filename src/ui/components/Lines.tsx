import {Box, Text} from 'ink';
import type {Line, Span} from '../lines.js';
import type {Theme} from '../theme.js';

export function SpanText({span, theme}: {span: Span; theme: Theme}) {
	const color = span.role ? theme.role(span.role) : span.color ? theme.fg(span.color) : undefined;
	return (
		<Text color={color} bold={span.bold} dimColor={span.dim} inverse={span.inverse}>
			{span.text}
		</Text>
	);
}

/** Draws lines that were already laid out for this width; each line is exactly one terminal row. */
export function Lines({lines, theme}: {lines: Line[]; theme: Theme}) {
	return (
		<Box flexDirection="column">
			{lines.map((line, index) => (
				<Text key={index} wrap="truncate-end">
					{line.length === 0 ? ' ' : line.map((span, i) => <SpanText key={i} span={span} theme={theme} />)}
				</Text>
			))}
		</Box>
	);
}

export type ScrollWindow = {lines: Line[]; above: number; below: number};

/**
 * The rows of `lines` shown in `height` rows, starting at line `top`. A row is kept free for a
 * "more above" or "more below" marker when there is hidden content, so a marker never covers a line.
 */
export function topWindow(lines: Line[], height: number, top: number): ScrollWindow {
	if (lines.length <= height) return {lines, above: 0, below: 0};
	const rows = Math.max(1, height);
	// The last page shows the end of the content under a single "above" marker.
	const lastStart = lines.length - Math.max(1, rows - 1);
	const start = Math.min(Math.max(0, top), lastStart);
	let room = rows - (start > 0 ? 1 : 0);
	if (start + room < lines.length) room = Math.max(1, room - 1);
	const end = Math.min(lines.length, start + room);
	return {lines: lines.slice(start, end), above: start, below: lines.length - end};
}

/** The same window counted from the bottom: `scroll` lines up from the newest line (0 = newest). */
export function bottomWindow(lines: Line[], height: number, scroll: number): ScrollWindow {
	if (lines.length <= height) return {lines, above: 0, below: 0};
	const rows = Math.max(1, height);
	const offset = Math.min(Math.max(0, scroll), lines.length - Math.max(1, rows - 1));
	let room = rows - (offset > 0 ? 1 : 0);
	if (lines.length - offset - room > 0) room = Math.max(1, room - 1);
	const end = lines.length - offset;
	const start = Math.max(0, end - room);
	return {lines: lines.slice(start, end), above: start, below: lines.length - end};
}
