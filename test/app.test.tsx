import {afterEach, describe, expect, test} from 'vitest';
import {DEFAULT_CONFIG} from '../src/core/config.js';
import {App} from '../src/ui/App.js';
import {width} from '../src/ui/text.js';
import {appProps, READY_REPORT, sessionInfo} from './helpers/fixtures.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

type Terminal = ReturnType<typeof renderTerminal>;
const open: Terminal[] = [];
afterEach(() => {
	for (const terminal of open.splice(0)) terminal.cleanup();
});

async function start(columns: number, rows: number, overrides: Parameters<typeof appProps>[0] = {}, report = READY_REPORT) {
	const {props, saved} = appProps(overrides, report);
	const terminal = renderTerminal(<App {...props} />, columns, rows);
	open.push(terminal);
	await tick(60);
	return {terminal, saved, props};
}

/** Every row fits the window and the frame fills it exactly: nothing wraps, nothing is pushed off screen. */
function expectFits(terminal: Terminal, columns: number, rows: number) {
	const lines = terminal.lines();
	expect(lines.length).toBe(rows);
	for (const line of lines) expect(width(line), JSON.stringify(line)).toBeLessThanOrEqual(columns);
}

describe('responsive layout', () => {
	const widths = [40, 60, 80, 120, 160];
	const heights = [15, 24, 40];
	for (const columns of widths) {
		for (const rows of heights) {
			test(`${columns}x${rows} fits the window`, async () => {
				const {terminal} = await start(columns, rows);
				expectFits(terminal, columns, rows);
				const frame = terminal.frame();
				expect(frame).toContain('Gõ / để xem lệnh');
				const headerShown = columns >= 60 && rows >= 16;
				expect(terminal.lines()[0]!.startsWith('PIRL ·')).toBe(headerShown);
				expect(frame.includes('Phiên làm việc')).toBe(columns >= 120);
				expect(frame.includes('Enter gửi')).toBe(columns >= 80);
			});
		}
	}

	test('below 40 columns or 10 rows it asks for a bigger window instead of drawing a broken layout', async () => {
		const {terminal} = await start(39, 20);
		expect(terminal.frame()).toContain('Cửa sổ quá hẹp (39 cột)');
		expectFits(terminal, 39, 20);
		terminal.stdout.resize(80, 8);
		await tick();
		expect(terminal.frame()).toContain('Cửa sổ quá thấp (8 dòng)');
	});

	test('resizing while typing keeps the text, the messages and the layout rules', async () => {
		const {terminal} = await start(160, 40);
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		await terminal.type('Khách nhận email khi đơn bị huỷ');
		for (const [columns, rows] of [[60, 18], [100, 24], [45, 12], [160, 40]] as const) {
			terminal.stdout.resize(columns, rows);
			await tick();
			expectFits(terminal, columns, rows);
			const frame = terminal.frame();
			expect(frame).toContain('Không có run nào đang dở.');
			expect(frame.replace(/[│|\s]+/g, ' ')).toContain('Khách nhận email khi đơn bị huỷ');
		}
	});

	test('the header keeps the update notice only when it fits', async () => {
		const info = sessionInfo();
		info.hub = {...info.hub!, updateAvailable: true};
		const wide = await start(160, 30, {info});
		expect(wide.terminal.lines()[0]).toMatch(/fw-1\.0\.0 \(\+2 cải tiến\)\s+▲ Có framework mới$/);
		const narrow = await start(80, 30, {info});
		expect(narrow.terminal.lines()[0]!.length).toBeLessThanOrEqual(80);
	});

	test('a long repository name is shortened in the middle', async () => {
		const info = sessionInfo({target: {kind: 'git', root: '/w/x', name: 'a-very-long-repository-name-for-the-shop-frontend', branch: 'main'}});
		const {terminal} = await start(62, 24, {info});
		expect(terminal.lines()[0]).toMatch(/^PIRL · a-very.*…/);
		expectFits(terminal, 62, 24);
	});
});

describe('input and command palette', () => {
	test('typing "/" lists commands; Tab completes a layer command with a space for the request', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('/pirl');
		expect(terminal.frame()).toContain('❯ /pirl-plan <request>');
		await terminal.press(KEYS.down);
		expect(terminal.frame()).toContain('❯ /pirl-implement <request>');
		await terminal.press(KEYS.tab);
		expect(terminal.frame()).toContain('› /pirl-implement ');
		expect(terminal.frame()).not.toContain('❯');
	});

	test('Enter on a command without a request runs it', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('/hel');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('Trợ giúp');
		await terminal.press(KEYS.escape);
		expect(terminal.frame()).not.toContain('Trợ giúp');
	});

	test('free text, unknown commands and the locked layers', async () => {
		const {terminal} = await start(100, 30, {info: sessionInfo({target: {kind: 'none', cwd: '/tmp', reason: 'Thư mục hiện tại không nằm trong git repo'}})});
		await terminal.type('T02 phụ thuộc gì?');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('Bản này chưa nối với provider.');
		await terminal.type('/deploy');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('Không có lệnh /deploy.');
		await terminal.type('/pirl-plan x');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('Layer Plan bị khoá');
	});

	test('a Vietnamese input method that sends backspaces and the accented letters in one burst', async () => {
		// Unikey/EVKey type "chao", then replace "ao" with "ào": two backspaces and the new letters arrive together.
		const {terminal} = await start(100, 30);
		await terminal.type('Xin chao');
		await terminal.press('\u007F\u007Fào');
		await terminal.press(' c\u0008\u0008 các bạn');
		expect(terminal.frame()).toContain('› Xin chào các bạn');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('› Xin chào các bạn');
	});

	test('Enter that arrives in the same chunk as the text still sends it', async () => {
		const {terminal} = await start(100, 30);
		await terminal.press('/resume\r');
		expect(terminal.frame()).toContain('› /resume');
		expect(terminal.frame()).toContain('Không có run nào đang dở.');
		await terminal.press('xin chào\rthêm');
		expect(terminal.frame()).toContain('› xin chào');
		expect(terminal.frame()).toContain('› thêm');
	});

	const sent = (frame: string) => frame.split('› /resume').length - 1;

	test('Ctrl+P recalls what was sent; Esc clears the input', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		expect(sent(terminal.frame())).toBe(1);
		await terminal.press('\x10');
		expect(sent(terminal.frame())).toBe(2);
		await terminal.press('\x0e');
		expect(sent(terminal.frame())).toBe(1);
		await terminal.press('\x10');
		await terminal.press(KEYS.escape);
		expect(terminal.frame()).toContain('Gõ / để xem lệnh, hoặc nhập yêu cầu');
	});

	test('with the mouse left to the terminal, ↑/↓ (and so its wheel) scroll the chat', async () => {
		const {terminal} = await start(80, 16);
		for (let i = 0; i < 6; i++) {
			await terminal.type('/khong-co');
			await terminal.press(KEYS.enter);
		}
		for (let i = 0; i < 40; i++) await terminal.press(KEYS.up);
		expect(terminal.frame()).toContain('PIRL · Plan · Implement · Review');
		expect(terminal.frame()).toContain('Gõ / để xem lệnh');
		for (let i = 0; i < 40; i++) await terminal.press(KEYS.down);
		expect(terminal.frame()).not.toContain('dòng mới hơn');
	});

	test('with the wheel taken by PIRL, ↑ recalls what was sent', async () => {
		const {terminal} = await start(100, 30, {initialConfig: {...DEFAULT_CONFIG, mouse: 'wheel'}});
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		await terminal.press(KEYS.up);
		expect(sent(terminal.frame())).toBe(2);
	});

	test('a trailing backslash and Enter add a line instead of sending', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('dòng một\\');
		await terminal.press(KEYS.enter);
		await terminal.type('dòng hai');
		const lines = terminal.lines();
		const first = lines.findIndex(line => line.includes('› dòng một'));
		expect(first).toBeGreaterThan(0);
		expect(lines[first + 1]).toContain('dòng hai');
	});

	test('/clear keeps only the welcome message', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		await terminal.type('/clear');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).not.toContain('Không có run nào đang dở.');
		expect(terminal.frame()).toContain('PIRL · Plan · Implement · Review');
	});

	test('PgUp shows older lines and marks the newer ones below', async () => {
		const {terminal} = await start(80, 16);
		for (let i = 0; i < 6; i++) {
			await terminal.type('/khong-co');
			await terminal.press(KEYS.enter);
		}
		expect(terminal.frame()).not.toContain('PIRL · Plan · Implement · Review');
		for (let i = 0; i < 5; i++) await terminal.press(KEYS.pageUp);
		expect(terminal.frame()).toContain('PIRL · Plan · Implement · Review');
		expect(terminal.frame()).toMatch(/↓ \d+ dòng mới hơn \(PgDn\)/);
		for (let i = 0; i < 5; i++) await terminal.press(KEYS.pageDown);
		expect(terminal.frame()).not.toContain('dòng mới hơn');
	});

	test('the mouse wheel scrolls the chat; terminal replies never reach the input', async () => {
		const {terminal} = await start(80, 16, {initialConfig: {...DEFAULT_CONFIG, mouse: 'wheel'}});
		for (let i = 0; i < 6; i++) {
			await terminal.type('/khong-co');
			await terminal.press(KEYS.enter);
		}
		for (let i = 0; i < 14; i++) await terminal.press('\x1b[<64;5;5M');
		expect(terminal.frame()).toContain('PIRL · Plan · Implement · Review');
		for (let i = 0; i < 14; i++) await terminal.press('\x1b[<65;5;5M');
		expect(terminal.frame()).not.toContain('dòng mới hơn');
		await terminal.press('\x1b[?0u');
		expect(terminal.frame()).not.toContain('[?0u');
		expect(terminal.frame()).toContain('Gõ / để xem lệnh');
	});
});

describe('startup check and panels', () => {
	test('a clean start posts one "ready" line', async () => {
		const {terminal} = await start(100, 30);
		expect(terminal.frame()).toContain('Sẵn sàng: Claude Code đã đăng nhập · Python 3.12.4 · Git 2.43.0.');
	});

	test('a signed-out provider is reported with the way to /doctor', async () => {
		const report = {
			...READY_REPORT,
			checks: READY_REPORT.checks.map(check =>
				check.id === 'provider' ? {...check, state: 'fail' as const, detail: '2.1.309 · chưa đăng nhập', fix: 'Chạy `claude auth login`.'} : check,
			),
		};
		const {terminal} = await start(130, 30, {}, report);
		expect(terminal.frame()).toContain('Cần chú ý: Claude Code (2.1.309 · chưa đăng nhập).');
		expect(terminal.lines()[0]).toContain('✖ Claude Code');
		expect(terminal.frame()).toContain('Claude Code · chưa sẵn sàng');
		await terminal.type('/doctor');
		await terminal.press(KEYS.enter);
		await tick();
		expect(terminal.frame()).toContain('Kiểm tra môi trường');
		expect(terminal.frame()).toContain('Chạy `claude auth login`.');
		expect(terminal.frame()).toContain('1 mục cần xử lý trước khi chạy layer.');
	});

	test('outside a git repo the start-up summary does not repeat the target warning', async () => {
		const report = {...READY_REPORT, checks: READY_REPORT.checks.map(check => (check.id === 'target' ? {...check, state: 'warn' as const} : check))};
		const {terminal} = await start(100, 30, {}, report);
		expect(terminal.frame()).toContain('Sẵn sàng');
		expect(terminal.frame()).not.toContain('Cần chú ý');
	});

	test('/doctor runs the checks again', async () => {
		let calls = 0;
		const {props} = appProps();
		const terminal = renderTerminal(<App {...props} services={{...props.services, runDoctor: async () => (calls++, READY_REPORT)}} />, 100, 30);
		open.push(terminal);
		await tick(60);
		await terminal.type('/doctor');
		await terminal.press(KEYS.enter);
		await tick();
		expect(calls).toBe(2);
	});

	test('/settings changes a value, saves it and applies it at once', async () => {
		const {terminal, saved} = await start(100, 30);
		await terminal.type('/settings');
		await terminal.press(KEYS.enter);
		for (let i = 0; i < 6; i++) await terminal.press(KEYS.down);
		await terminal.press(KEYS.right);
		await terminal.press(KEYS.right);
		expect(saved.at(-1)).toMatchObject({glyphs: 'ascii'});
		expect(terminal.frame()).toContain('< ASCII >');
		await terminal.press(KEYS.escape);
		expect(terminal.frame()).toContain('+---');
		expect(terminal.frame()).not.toMatch(/[╭│✔]/);
	});

	test('the provider cannot be switched to one without an adapter', async () => {
		const {terminal, saved} = await start(100, 30);
		await terminal.type('/settings');
		await terminal.press(KEYS.enter);
		await terminal.press(KEYS.right);
		expect(saved.at(-1)).toMatchObject({provider: 'claude'});
		expect(terminal.frame()).toContain('Giai đoạn sau: Codex CLI, Gemini CLI, Copilot CLI');
	});

	test('/framework shows the Hub without changing it', async () => {
		const {terminal} = await start(100, 30);
		await terminal.type('/framework');
		await terminal.press(KEYS.enter);
		const frame = terminal.frame();
		expect(frame).toContain('Bản gốc đang dùng');
		expect(frame).toContain('2 commit');
		expect(frame).toContain('Xem cải tiến cục bộ (khác bản gốc)');
		expect(frame).not.toContain('Cập nhật lên');
	});

	test('a long panel scrolls and says how much is hidden', async () => {
		const {terminal} = await start(80, 18);
		await terminal.type('/help');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toMatch(/↓ còn \d+ dòng \(PgDn\)/);
		for (let i = 0; i < 6; i++) await terminal.press(KEYS.pageDown);
		// The last page: the closing notes are shown under a marker for what is above; no marker hides a line.
		expect(terminal.frame()).toContain('settings.json');
		expect(terminal.frame()).toMatch(/↑ còn \d+ dòng \(PgUp\)/);
		expect(terminal.frame()).not.toContain('(PgDn)');
		expectFits(terminal, 80, 18);
		await terminal.press(KEYS.pageUp);
		expect(terminal.frame()).toMatch(/↓ còn \d+ dòng \(PgDn\)/);
	});

	test('NO_COLOR draws no color codes', async () => {
		const {terminal} = await start(100, 30, {env: {NO_COLOR: '1'}});
		const raw = terminal.stdout.frames.at(-1)!;
		expect(raw).not.toMatch(/\u001B\[(3|4)[0-9;]*m/);
		expect(terminal.frame()).toContain('✔ Sẵn sàng');
	});

	test('/exit closes the TUI', async () => {
		const {terminal} = await start(100, 30);
		let exited = false;
		void terminal.instance.waitUntilExit().then(() => (exited = true));
		await terminal.type('/exit');
		await terminal.press(KEYS.enter);
		await tick();
		expect(exited).toBe(true);
	});
});

describe('snapshots', () => {
	for (const [columns, rows] of [[60, 16], [100, 24], [140, 30]] as const) {
		test(`welcome screen at ${columns}x${rows}`, async () => {
			const {terminal} = await start(columns, rows);
			expect(terminal.frame()).toMatchSnapshot();
		});
	}

	test('palette open at 100x24', async () => {
		const {terminal} = await start(100, 24);
		await terminal.type('/');
		expect(terminal.frame()).toMatchSnapshot();
	});
});
