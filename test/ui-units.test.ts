import {describe, expect, test} from 'vitest';
import {backspace, emptyEditor, insert, layoutEditor, move, setValue} from '../src/ui/inputEditor.js';
import {computeLayout, heightTier, widthTier} from '../src/ui/layout.js';
import {createTheme, detectMode, detectUnicode} from '../src/ui/theme.js';
import {parseQuotaLine} from '../src/engine/claudeQuota.js';
import {MOUSE_OFF, mouseSequence, parseTerminalInput} from '../src/ui/terminalInput.js';
import {emptyUsage} from '../src/engine/types.js';
import {compactTokens, quotaText, usageDetail} from '../src/ui/runView.js';
import {truncateEnd, truncateMiddle, width, wrapText} from '../src/ui/text.js';

describe('text', () => {
	test('measures display cells, not characters', () => {
		expect(width('huỷ')).toBe(3);
		expect(width('huỷ')).toBe(3); // decomposed "ỷ": a combining mark takes no cell
		expect(width('中文')).toBe(4);
	});

	test('shortens paths in the middle and text at the end', () => {
		expect(truncateMiddle('src/orders/services/cancel.ts', 16)).toBe('src/ord…ancel.ts');
		expect(width(truncateMiddle('src/orders/services/cancel.ts', 16))).toBe(16);
		expect(truncateEnd('Khách nhận email', 8)).toBe('Khách n…');
		expect(truncateEnd('ngắn', 10)).toBe('ngắn');
	});

	test('wraps at spaces and keeps blank lines', () => {
		expect(wrapText('một hai ba bốn', 7)).toEqual(['một hai', 'ba bốn']);
		expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
	});
});

describe('input editor', () => {
	test('moves and deletes by grapheme, so "ệ" and emoji are one step', () => {
		let state = insert(emptyEditor, 'Việt 👍');
		expect(state.cursor).toBe(6);
		state = backspace(state);
		expect(state.value).toBe('Việt ');
		state = move(move(state, 'left'), 'left');
		state = backspace(state);
		expect(state.value).toBe('Vit ');
		expect(move(state, 'home').cursor).toBe(0);
		expect(move(state, 'end').cursor).toBe(4);
	});

	test('pasted Windows line endings become newlines', () => {
		expect(insert(emptyEditor, 'a\r\nb\rc').value).toBe('a\nb\nc');
	});

	test('wraps at the last space and finds the cursor after wrapping', () => {
		const layout = layoutEditor(setValue('xin chào thế giới'), 10);
		expect(layout.lines).toEqual(['xin chào ', 'thế giới']);
		expect(layout).toMatchObject({cursorLine: 1, cursorColumn: 8});
		const inside = layoutEditor({value: 'xin chào thế giới', cursor: 10}, 10);
		expect(inside).toMatchObject({cursorLine: 1, cursorColumn: 1});
	});

	test('breaks a word longer than the line', () => {
		expect(layoutEditor(setValue('abcdefghij'), 4).lines).toEqual(['abcd', 'efgh', 'ij']);
	});

	test('the cursor after a full line starts the next line', () => {
		expect(layoutEditor(setValue('abcd'), 4)).toMatchObject({lines: ['abcd', ''], cursorLine: 1, cursorColumn: 0});
	});

	test('explicit newlines', () => {
		expect(layoutEditor({value: 'ab\ncd', cursor: 2}, 10)).toMatchObject({lines: ['ab', 'cd'], cursorLine: 0, cursorColumn: 2});
		expect(layoutEditor({value: 'ab\ncd', cursor: 3}, 10)).toMatchObject({cursorLine: 1, cursorColumn: 0});
	});
});

describe('layout tiers', () => {
	test('width and height tiers follow the proposal', () => {
		expect([160, 120, 119, 80, 79, 60, 59, 40].map(widthTier)).toEqual(['wide', 'wide', 'standard', 'standard', 'narrow', 'narrow', 'tiny', 'tiny']);
		expect([40, 24, 23, 16, 15].map(heightTier)).toEqual(['full', 'full', 'compact', 'compact', 'short']);
	});

	test('what each tier shows', () => {
		expect(computeLayout(39, 24)).toEqual({kind: 'too-small', columns: 39, rows: 24});
		expect(computeLayout(80, 9).kind).toBe('too-small');
		expect(computeLayout(150, 40)).toMatchObject({header: 'full', sidePanel: 50, status: 'full', paletteMax: 8, inputMaxLines: 5});
		expect(computeLayout(100, 20)).toMatchObject({header: 'full', sidePanel: 0, paletteMax: 5, inputMaxLines: 3});
		expect(computeLayout(70, 24)).toMatchObject({header: 'short', status: 'usage'});
		expect(computeLayout(50, 24)).toMatchObject({header: 'hidden', status: 'single'});
		expect(computeLayout(100, 15)).toMatchObject({header: 'hidden', paletteMax: 3, inputMaxLines: 2});
	});
});

describe('theme', () => {
	test('COLORFGBG picks a light or dark palette', () => {
		expect(detectMode({COLORFGBG: '0;15'})).toBe('light');
		expect(detectMode({COLORFGBG: '15;0'})).toBe('dark');
		expect(detectMode({})).toBe('dark');
	});

	test('legacy Windows consoles get ASCII; Windows Terminal gets Unicode', () => {
		expect(detectUnicode({}, 'win32')).toBe(false);
		expect(detectUnicode({WT_SESSION: '1'}, 'win32')).toBe(true);
		expect(detectUnicode({TERM: 'linux'}, 'linux')).toBe(false);
		expect(detectUnicode({}, 'darwin')).toBe(true);
	});

	test('NO_COLOR turns every token off but keeps glyphs', () => {
		const theme = createTheme({theme: 'dark', glyphs: 'unicode'}, {NO_COLOR: '1'}, 'linux');
		expect(theme.fg('accent')).toBeUndefined();
		expect(theme.role('code-reviewer')).toBeUndefined();
		expect(theme.glyphs.ok).toBe('✓');
	});

	test('every glyph is one cell wide: none has an emoji form a terminal could draw two cells wide', () => {
		const glyphs = createTheme({theme: 'dark', glyphs: 'unicode'}, {}, 'linux').glyphs;
		for (const value of Object.values(glyphs).flat()) {
			expect(value, value).not.toMatch(/\p{Extended_Pictographic}/u);
		}
	});

	test('settings override detection', () => {
		const theme = createTheme({theme: 'light', glyphs: 'ascii'}, {WT_SESSION: '1'}, 'win32');
		expect(theme).toMatchObject({mode: 'light', unicode: false, border: 'classic'});
		expect(theme.fg('accent')).not.toBe(createTheme({theme: 'dark', glyphs: 'ascii'}, {}, 'linux').fg('accent'));
	});
});

describe('usage and quota', () => {
	test('token counts at a glance', () => {
		expect([compactTokens(950), compactTokens(1234), compactTokens(56_789), compactTokens(1_209_213)]).toEqual(['950', '1,2k', '57k', '1,21M']);
	});

	test('the run tokens by kind, their API price and the models', () => {
		const usage = {...emptyUsage(), calls: 1, requests: 24, inputTokens: 48, cacheWriteTokens: 104_452, cacheReadTokens: 731_777, outputTokens: 11_351, costUsd: 0.61, models: ['claude-sonnet-5-5']};
		expect(usageDetail(usage, '·')).toEqual(['848k token: 732k đọc cache · 104k ghi cache · 11k ra · 48 vào mới', '≈ $0.61 theo giá API · sonnet-5-5']);
		expect(usageDetail(emptyUsage(), '·')).toEqual([]);
	});

	test('the plan meters from /usage, and what the run took of each', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {content: [{type: 'text', text: 'Usage'}]},
			usage_report: {
				session: {},
				rate_limits: {
					limits: [
						{kind: 'session', group: 'session', percent: 19.4, resets_at: '2026-10-24T08:00:00Z', severity: 'normal', is_active: true},
						{kind: 'weekly_all', group: 'weekly', percent: 31, resets_at: null, severity: 'normal', is_active: true},
						{kind: 'weekly_scoped', group: 'weekly', percent: 8, resets_at: null, scope: {model: {display_name: 'Sonnet'}}, severity: 'normal', is_active: true},
					],
				},
			},
		});
		const after = parseQuotaLine(line)!;
		expect(after.map(row => row.label)).toEqual(['5 giờ', 'Tuần', 'Tuần (Sonnet)']);
		expect(parseQuotaLine(JSON.stringify({type: 'assistant', message: {content: []}}))).toBeNull();
		const before = after.map(row => ({...row, percent: row.percent - (row.kind === 'session' ? 7 : 1)}));
		expect(quotaText({before, after}, '·', '→')).toBe('Hạn mức: 5 giờ 12% → 19% (+7) · Tuần 30% → 31% (+1) · Tuần (Sonnet) 7% → 8% (+1)');
		expect(quotaText({before: null, after}, '·', '→')).toBe('Hạn mức hiện tại: 5 giờ 19% · Tuần 31% · Tuần (Sonnet) 8%');
		expect(quotaText({before, after: null}, '·', '→')).toBeNull();
	});
});

describe('terminal input', () => {
	test('replies to the terminal\'s queries never reach the input box', () => {
		expect(parseTerminalInput('[?0u')).toEqual({text: '', wheel: 0, mouse: [], filtered: true});
		expect(parseTerminalInput('\x1b[?1u')).toEqual({text: '', wheel: 0, mouse: [], filtered: true});
		expect(parseTerminalInput('\x1b[?1;2c')).toMatchObject({text: '', filtered: true});
		expect(parseTerminalInput('xin chào')).toEqual({text: 'xin chào', wheel: 0, mouse: [], filtered: false});
		expect(parseTerminalInput('[?0uabc')).toMatchObject({text: 'abc', filtered: true});
	});

	test('mouse reports: the wheel and its notches, whatever modifier keys are held', () => {
		expect(parseTerminalInput('\x1b[<64;10;5M')).toEqual({text: '', wheel: 1, mouse: [{kind: 'wheel', notches: 1, x: 9, y: 4}], filtered: true});
		expect(parseTerminalInput('[<65;10;5M[<65;10;5M')).toMatchObject({wheel: -2});
		expect(parseTerminalInput('[<80;3;3M')).toMatchObject({wheel: 1}); // 64 with Ctrl
		expect(parseTerminalInput('[<0;3;3M[<0;3;3m')).toMatchObject({text: '', wheel: 0, filtered: true});
	});

	test('mouse reports: presses, drags and releases of each button, at 0-based cells', () => {
		expect(parseTerminalInput('\x1b[<0;10;5M\x1b[<32;12;6M\x1b[<0;14;7m').mouse).toEqual([
			{kind: 'press', button: 'left', x: 9, y: 4},
			{kind: 'drag', button: 'left', x: 11, y: 5},
			{kind: 'release', button: 'left', x: 13, y: 6},
		]);
		expect(parseTerminalInput('[<2;1;1M').mouse).toEqual([{kind: 'press', button: 'right', x: 0, y: 0}]);
		expect(parseTerminalInput('[<4;1;1M').mouse).toEqual([{kind: 'press', button: 'left', x: 0, y: 0}]); // with Shift
		expect(parseTerminalInput('[<35;8;2M').mouse).toEqual([{kind: 'move', x: 7, y: 1}]);
		expect(parseTerminalInput('a[<0;1;1Mb')).toMatchObject({text: 'ab', filtered: true});
	});

	test('mouse modes: select reports presses, drags and the wheel; terminal keeps the mouse and sends the wheel as arrows', () => {
		expect(mouseSequence('select')).toBe(`${MOUSE_OFF}\x1b[?1000h\x1b[?1002h\x1b[?1006h`);
		expect(mouseSequence('terminal')).toBe(`${MOUSE_OFF}\x1b[?1007h`);
		expect(mouseSequence('off')).toBe(MOUSE_OFF);
		for (const mode of ['?1000l', '?1002l', '?1006l', '?1007l']) expect(MOUSE_OFF).toContain(mode);
	});
});
