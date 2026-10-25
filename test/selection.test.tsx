import {afterEach, describe, expect, test} from 'vitest';
import type {Clipboard} from '../src/core/clipboard.js';
import {DEFAULT_CONFIG} from '../src/core/config.js';
import {App} from '../src/ui/App.js';
import type {Line} from '../src/ui/lines.js';
import {markdownLines} from '../src/ui/runView.js';
import {columnsOf, highlight, pointAt, selectedText, sliceText, type SelectArea, type Selection} from '../src/ui/selection.js';
import {expandTabs} from '../src/ui/text.js';
import {appProps} from './helpers/fixtures.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

type Terminal = ReturnType<typeof renderTerminal>;
const open: Terminal[] = [];
afterEach(() => {
	for (const terminal of open.splice(0)) terminal.cleanup();
});

const plain = (text: string): Line => [{text}];

describe('selection: points, columns and text', () => {
	const area: SelectArea = {area: 'chat', lines: [], firstLine: 10, count: 5, top: 3, left: 1, right: 60, rowsFrom: 1, rowsTo: 9};

	test('a screen cell maps to a content line and column; beyond the visible lines it says which way to scroll', () => {
		expect(pointAt(area, 6, 4)).toEqual({point: {line: 11, col: 5}, beyond: 0});
		expect(pointAt(area, 0, 3)).toEqual({point: {line: 10, col: 0}, beyond: 0});
		expect(pointAt(area, 6, 1)).toEqual({point: {line: 10, col: 0}, beyond: -1});
		expect(pointAt(area, 6, 8)).toMatchObject({point: {line: 14}, beyond: 1});
	});

	test('the selected columns of each line, whichever way the drag went', () => {
		const down: Selection = {area: 'chat', anchor: {line: 2, col: 4}, focus: {line: 4, col: 1}};
		const up: Selection = {...down, anchor: down.focus, focus: down.anchor};
		for (const selection of [down, up]) {
			expect(columnsOf(selection, 1)).toBeNull();
			expect(columnsOf(selection, 2)).toEqual([4, Number.MAX_SAFE_INTEGER]);
			expect(columnsOf(selection, 3)).toEqual([0, Number.MAX_SAFE_INTEGER]);
			expect(columnsOf(selection, 4)).toEqual([0, 2]);
		}
	});

	test('Vietnamese letters, combining marks and wide characters are cut by display column, never in half', () => {
		const line: Line = [{text: 'Tiếng '}, {text: '日本', bold: true}, {text: ' ok'}];
		expect(sliceText(line, [0, 5])).toBe('Tiếng');
		expect(sliceText(line, [6, 8])).toBe('日');
		expect(sliceText(line, [7, 8])).toBe('日'); // the second cell of a wide character takes it whole
		expect(sliceText([{text: 'Tiếng Việt'}], [6, 10])).toBe('Việt');
	});

	test('the highlight reverses only the selected columns and keeps each span\'s style', () => {
		const line: Line = [{text: 'abc', color: 'accent'}, {text: 'def', bold: true}];
		expect(highlight(line, [1, 4])).toEqual([
			{text: 'a', color: 'accent', inverse: undefined},
			{text: 'bc', color: 'accent', inverse: true},
			{text: 'd', bold: true, inverse: true},
			{text: 'ef', bold: true, inverse: undefined},
		]);
	});

	test('the copied text: lines cut to the selection, trailing spaces and the shared indentation removed', () => {
		const lines = [plain('  › /pirl-plan Thêm email   '), plain('    Kết quả'), plain(''), plain('    • Plan có 1 task.')];
		// From the middle of the first line: the lines below keep their indentation relative to it.
		expect(selectedText(lines, {area: 'chat', anchor: {line: 0, col: 4}, focus: {line: 3, col: 99}})).toBe('/pirl-plan Thêm email\n  Kết quả\n\n  • Plan có 1 task.');
		// The indented lines alone lose the indentation they share.
		expect(selectedText(lines, {area: 'chat', anchor: {line: 1, col: 0}, focus: {line: 3, col: 99}})).toBe('Kết quả\n\n• Plan có 1 task.');
		// Code keeps its own indentation.
		const code = [plain('    function a() {'), plain('      return 1;'), plain('    }')];
		expect(selectedText(code, {area: 'chat', anchor: {line: 0, col: 0}, focus: {line: 2, col: 99}})).toBe('function a() {\n  return 1;\n}');
	});
});

describe('code in replies keeps its indentation, so a copy of it does too', () => {
	test('tabs become spaces to the next multiple of four, measured in display columns', () => {
		expect(expandTabs('a\tb')).toBe('a   b');
		expect(expandTabs('\t\tx')).toBe('        x');
		expect(expandTabs('日\tx')).toBe('日  x');
		expect(expandTabs('no tab')).toBe('no tab');
	});

	test('a code block is drawn with its own indentation, tabs included; very deep indentation is capped', () => {
		const lines = markdownLines('```go\nfunc a() {\n\tif x {\n\t\treturn 1\n\t}\n}\n```', 40);
		const text = lines.map(line => line.map(span => span.text).join(''));
		expect(text).toEqual(['  func a() {', '      if x {', '          return 1', '      }', '  }']);
		const all: Selection = {area: 'chat', anchor: {line: 0, col: 0}, focus: {line: lines.length - 1, col: 99}};
		expect(selectedText(lines, all)).toBe('func a() {\n    if x {\n        return 1\n    }\n}');
		const deep = markdownLines(`\`\`\`\n${' '.repeat(60)}x\n\`\`\``, 40)[0]!.map(span => span.text).join('');
		expect(deep.trimEnd()).toBe(`${' '.repeat(20)}x`);
	});
});

describe('selecting with the mouse in the TUI', () => {
	/** The TUI with a clipboard stand-in, after `count` messages that each add a few lines to the chat. */
	async function start(columns: number, rows: number, count: number) {
		const copied: string[] = [];
		const clipboard: Clipboard = {copy: async text => (copied.push(text), 'native'), paste: async () => 'dán từ clipboard'};
		const base = appProps({initialConfig: {...DEFAULT_CONFIG}});
		const terminal = renderTerminal(<App {...base.props} services={{...base.props.services, clipboard}} />, columns, rows);
		open.push(terminal);
		await tick(60);
		for (let i = 1; i <= count; i++) {
			await terminal.type(`/m${i}`);
			await terminal.press(KEYS.enter);
		}
		return {terminal, copied};
	}
	/** The 0-based screen cell where `text` starts. */
	const cell = (terminal: Terminal, text: string) => {
		const y = terminal.lines().findIndex(line => line.includes(text));
		expect(y, `"${text}" on screen`).toBeGreaterThanOrEqual(0);
		return {x: terminal.lines()[y]!.indexOf(text), y};
	};
	const sgr = (code: number, x: number, y: number, final: 'M' | 'm' = 'M') => `\x1b[<${code};${x + 1};${y + 1}${final}`;
	const until = async (check: () => boolean, ms = 30_000) => {
		const end = Date.now() + ms;
		while (!check() && Date.now() < end) await tick(30);
	};

	test('drag across lines, release: the text is copied without Shift and the status line says so', async () => {
		const {terminal, copied} = await start(100, 30, 2);
		const from = cell(terminal, '/m1');
		const to = cell(terminal, '› /m2');
		await terminal.press(sgr(0, from.x, from.y));
		await terminal.press(sgr(32, to.x + 4, to.y));
		await terminal.press(sgr(0, to.x + 4, to.y, 'm'));
		await until(() => copied.length > 0);
		expect(copied).toHaveLength(1);
		expect(copied[0]).toMatch(/^\/m1\n[\s\S]*Không có lệnh \/m1\.[\s\S]*\n› \/m2$/);
		await until(() => terminal.frame().includes('Đã copy'));
		expect(terminal.frame()).toMatch(/Đã copy \d+ dòng/);
	});

	test('holding the button past the top edge scrolls on, so the selection reaches lines that were not on screen', async () => {
		const {terminal, copied} = await start(80, 16, 8);
		expect(terminal.frame()).not.toContain('› /m1');
		const from = cell(terminal, '› /m8');
		await terminal.press(sgr(0, from.x + 4, from.y));
		await terminal.press(sgr(32, 5, 0));
		await until(() => terminal.frame().includes('PIRL · Plan'), 20_000);
		await terminal.press(sgr(0, 5, 0, 'm'));
		await until(() => copied.length > 0);
		expect(copied[0]).toContain('› /m1');
		expect(copied[0]).toContain('/m7');
		expect(copied[0]!.endsWith('› /m8')).toBe(true);
	});

	test('turning the wheel while the button is held extends the selection to the lines scrolled in', async () => {
		const {terminal, copied} = await start(80, 16, 8);
		const from = cell(terminal, '› /m8');
		await terminal.press(sgr(0, from.x + 4, from.y));
		for (let i = 0; i < 4; i++) await terminal.press(sgr(64, from.x + 4, from.y));
		await terminal.press(sgr(0, from.x, from.y, 'm'));
		await until(() => copied.length > 0);
		expect(copied[0]).toContain('/m6');
		expect(copied[0]).toContain('/m8');
	});

	test('a key ends a drag whose release never came, so the view stops scrolling', async () => {
		const {terminal, copied} = await start(80, 16, 8);
		const from = cell(terminal, '› /m8');
		await terminal.press(sgr(0, from.x, from.y));
		await terminal.press(sgr(32, 5, 0));
		await tick(150);
		await terminal.press('x');
		const after = terminal.frame();
		await tick(400);
		expect(terminal.frame()).toBe(after);
		expect(copied).toEqual([]);
	});

	test('a click is not a selection; the right button pastes into the input', async () => {
		const {terminal, copied} = await start(100, 30, 1);
		const at = cell(terminal, '/m1');
		await terminal.press(sgr(0, at.x, at.y));
		await terminal.press(sgr(0, at.x, at.y, 'm'));
		await tick(100);
		expect(copied).toEqual([]);
		await terminal.press(sgr(2, at.x, at.y));
		await until(() => terminal.frame().includes('› dán từ clipboard'));
		expect(terminal.frame()).toContain('› dán từ clipboard');
	});

	test('text in an open panel is selected and copied the same way', async () => {
		const {terminal, copied} = await start(100, 30, 0);
		await terminal.type('/help');
		await terminal.press(KEYS.enter);
		await until(() => terminal.frame().includes('/pirl-implement'));
		const from = cell(terminal, '/pirl-plan');
		const to = cell(terminal, '/pirl-implement');
		await terminal.press(sgr(0, from.x, from.y));
		await terminal.press(sgr(32, to.x + 14, to.y));
		await terminal.press(sgr(0, to.x + 14, to.y, 'm'));
		await until(() => copied.length > 0);
		expect(copied[0]).toMatch(/^\/pirl-plan[\s\S]*\n\/pirl-implement$/);
	});

	test('with the mouse left to the terminal, PIRL ignores mouse reports', async () => {
		const copied: string[] = [];
		const clipboard: Clipboard = {copy: async text => (copied.push(text), 'native'), paste: async () => null};
		const base = appProps({initialConfig: {...DEFAULT_CONFIG, mouse: 'terminal'}});
		const terminal = renderTerminal(<App {...base.props} services={{...base.props.services, clipboard}} />, 100, 30);
		open.push(terminal);
		await tick(60);
		const at = cell(terminal, 'PIRL · Plan');
		await terminal.press(sgr(0, at.x, at.y));
		await terminal.press(sgr(32, at.x + 10, at.y + 2));
		await terminal.press(sgr(0, at.x + 10, at.y + 2, 'm'));
		await tick(100);
		expect(copied).toEqual([]);
	});
});
