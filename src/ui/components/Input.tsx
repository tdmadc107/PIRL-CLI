import {Box} from 'ink';
import {commandUsage, type CommandSpec} from '../../commands/registry.js';
import {layoutEditor, type EditorState} from '../inputEditor.js';
import type {Line} from '../lines.js';
import {graphemes, padEnd, truncateEnd, width} from '../text.js';
import type {Theme} from '../theme.js';
import {Lines} from './Lines.js';

export const PLACEHOLDER = 'Gõ / để xem lệnh, hoặc nhập yêu cầu';

/** Lines inside the input box: the prompt, the wrapped text and the cursor as an inverse cell. */
export function inputLines(editor: EditorState, columns: number, maxLines: number, theme: Theme, focused: boolean, placeholder = PLACEHOLDER): Line[] {
	const prompt = `${theme.glyphs.prompt} `;
	const room = Math.max(1, columns - width(prompt));
	if (editor.value === '') {
		return [
			[
				{text: prompt, color: 'accent', bold: true},
				...(focused ? [{text: ' ', inverse: true}] : []),
				{text: truncateEnd(placeholder, room - 1, theme.glyphs.ellipsis), dim: true},
			],
		];
	}
	const layout = layoutEditor(editor, room);
	// Keep the cursor's line in view when the text is taller than the box.
	const first = Math.max(0, Math.min(layout.cursorLine - maxLines + 1, layout.lines.length - maxLines));
	const shown = layout.lines.slice(first, first + maxLines);
	return shown.map((text, index) => {
		const lineIndex = first + index;
		const lead = {text: lineIndex === 0 ? prompt : ' '.repeat(width(prompt)), color: 'accent' as const, bold: true};
		if (!focused || lineIndex !== layout.cursorLine) return [lead, {text}];
		const parts = graphemes(text);
		let column = 0;
		let split = parts.length;
		for (let i = 0; i < parts.length; i++) {
			if (column >= layout.cursorColumn) {
				split = i;
				break;
			}
			column += width(parts[i]!);
		}
		const before = parts.slice(0, split).join('');
		const at = parts[split] ?? ' ';
		const after = parts.slice(split + 1).join('');
		return [lead, {text: before}, {text: at, inverse: true}, {text: after}];
	});
}

export function inputHeight(editor: EditorState, columns: number, maxLines: number, theme: Theme): number {
	if (editor.value === '') return 1;
	const room = Math.max(1, columns - width(`${theme.glyphs.prompt} `));
	return Math.min(maxLines, layoutEditor(editor, room).lines.length);
}

export function InputBox(props: {editor: EditorState; columns: number; maxLines: number; theme: Theme; focused: boolean; placeholder?: string}) {
	const inner = props.columns - 4;
	return (
		<Box
			borderStyle={props.theme.border}
			borderColor={props.theme.fg(props.focused ? 'accent' : 'border')}
			paddingX={1}
			width={props.columns}
			flexDirection="column"
		>
			<Lines lines={inputLines(props.editor, inner, props.maxLines, props.theme, props.focused, props.placeholder)} theme={props.theme} />
		</Box>
	);
}

/** Suggested commands under the input box while a command name is being typed. */
export function paletteLines(suggestions: CommandSpec[], selected: number, max: number, columns: number, theme: Theme): Line[] {
	const start = Math.min(Math.max(0, selected - max + 1), Math.max(0, suggestions.length - max));
	const shown = suggestions.slice(start, start + max);
	const nameWidth = Math.max(...suggestions.map(spec => width(commandUsage(spec)))) + 2;
	const showSummary = columns - 4 - nameWidth >= 16;
	return shown.map((spec, index) => {
		const active = start + index === selected;
		const pointer = {text: active ? `${theme.glyphs.pointer} ` : '  ', color: 'accent' as const};
		const usage = commandUsage(spec);
		if (!showSummary) return [{text: ' '}, pointer, {text: truncateEnd(usage, columns - 4, theme.glyphs.ellipsis), color: active ? 'accent' : undefined, bold: active}];
		return [
			{text: ' '},
			pointer,
			{text: padEnd(usage, nameWidth), color: active ? 'accent' : undefined, bold: active},
			{text: truncateEnd(spec.summary, columns - 3 - nameWidth - 1, theme.glyphs.ellipsis), dim: !active},
		];
	});
}
