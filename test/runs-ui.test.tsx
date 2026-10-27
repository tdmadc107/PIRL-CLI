import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {readPlanPackages, readRecords} from '../src/engine/hubData.js';
import {RunController, type PersistedRun} from '../src/engine/run.js';
import {App} from '../src/ui/App.js';
import type {Services} from '../src/ui/session.js';
import {appProps, sessionInfo} from './helpers/fixtures.js';
import {cleanupTemp, fakeRunner, git, hubAndTarget, outputsBlock, PYTHON, result, writePlan, writeRecord, type FakeScript} from './helpers/hub.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

type Terminal = ReturnType<typeof renderTerminal>;
const open: Terminal[] = [];
afterEach(() => {
	for (const terminal of open.splice(0)) terminal.cleanup();
	cleanupTemp();
});

/** The TUI with a real Hub and a provider stand-in that plays `scripts`, one per provider call. */
async function startWithRuns(scripts: FakeScript[], extra: Partial<Services> = {}, size: [number, number] = [110, 40]) {
	const {hub, target} = await hubAndTarget();
	const {runner, calls} = fakeRunner(scripts);
	const saved = new Map<string, PersistedRun>();
	const base = appProps({
		info: sessionInfo({
			target: {kind: 'git', root: target, name: 'shop', branch: 'main'},
			hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'},
		}),
	});
	const services: Services = {
		...base.props.services,
		startRun: options =>
			new RunController({runner, hub, target, python: PYTHON, maxParallelRoles: 2, recentOutputs: options.recentOutputs}, options.id, options.kind, options.request, options.resume),
		saveRun: run => void saved.set(run.key, run),
		runs: () => [...saved.values()].reverse(),
		plans: () => readPlanPackages(hub, target),
		records: () => readRecords(hub, target),
		...extra,
	};
	const terminal = renderTerminal(<App {...base.props} services={services} />, size[0], size[1]);
	open.push(terminal);
	await tick(60);
	return {terminal, hub, target, calls};
}

const until = async (terminal: Terminal, text: string | RegExp, ms = 180_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const frame = terminal.frame();
		if (typeof text === 'string' ? frame.includes(text) : text.test(frame)) return frame;
		await tick(40);
	}
	throw new Error(`timed out waiting for ${text}\n${terminal.frame()}`);
};

describe('layer runs in the TUI', () => {
	test('/pirl-plan: roles, checks, the next step, and the commit question for improvements', async () => {
		let hubPath = '';
		const {terminal, hub, calls} = await startWithRuns([
			() => {
				const {planSet} = writePlan(hubPath, calls[0]!.addDirs[0]!);
				const recordId = writeRecord(hubPath, calls[0]!.addDirs[0]!, planSet);
				appendFileSync(join(hubPath, '.agents/roles/code-analyst.role.md'), '\n- Check every caller.\n');
				return [
					{type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace cancelOrder'},
					{type: 'role-end', toolUseId: 'tu-1', ok: true},
					result('## Kết quả\n- Plan có 1 task.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: recordId})),
				];
			},
		]);
		hubPath = hub;
		await terminal.type('/pirl-plan Khách nhận email khi đơn bị huỷ');
		await terminal.press(KEYS.enter);
		const frame = await until(terminal, 'Commit cải tiến này vào Hub?');
		expect(frame).toContain('Plan · chờ quyết định về cải tiến');
		expect(frame).toContain('✓ code-analyst  Trace cancelOrder');
		expect(frame).toContain('Kết quả');
		expect(frame).toContain('• Plan có 1 task.');
		expect(frame).toMatch(/✓ Validator: order-email_\d{8}-\d{6}/);
		expect(frame).toContain('✓ Record tự đánh giá: 1 record mới');
		expect(frame).toContain('.agents/roles/code-analyst.role.md');
		expect(frame).toContain('❯ 1. Commit vào Hub (khuyến nghị)');
		await terminal.press(KEYS.enter);
		const done = await until(terminal, 'Đã commit 1 file cải tiến vào Hub');
		expect(done).toMatch(/Bước tiếp theo, khi bạn muốn: \/pirl-implement T01 của order-email_\d{8}-\d{6}/);
		expect(git(hub, 'log', '-1', '--format=%B')).toContain('Pirl-Source: auditor');
		expect(done).toContain('1 lượt gọi');
	});

	test('questions from the coordinator: choose with arrows, the run resumes with the answers', async () => {
		const {terminal, calls} = await startWithRuns([
			() => [result('Thiếu quyết định.\n```pirl-questions\n[{"id":"Q1","question":"Gửi email khi admin huỷ?","options":["Có","Không"],"recommended":0},{"id":"Q2","question":"Ngôn ngữ email?","options":[]}]\n```')],
			() => [result('Đã ghi nhận.')],
		]);
		await terminal.type('/pirl-plan Email huỷ đơn');
		await terminal.press(KEYS.enter);
		const asked = await until(terminal, 'Cần quyết định (1/2)');
		expect(asked).toContain('❯ 1. Có (khuyến nghị)');
		await terminal.press(KEYS.down);
		await until(terminal, '❯ 2. Không');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Cần quyết định (2/2)');
		await terminal.type('Tiếng Việt');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã ghi nhận.');
		expect(calls[1]!.resumeSessionId).toBe('session-1');
		expect(calls[1]!.prompt).toContain('Q1 (Gửi email khi admin huỷ?): Không');
		expect(calls[1]!.prompt).toContain('Q2 (Ngôn ngữ email?): Tiếng Việt');
	});

	test('Esc stops a running run; /resume continues the same provider session with what the user types', async () => {
		const {terminal, calls} = await startWithRuns([
			(_call, emit) => {
				emit({type: 'session', sessionId: 'session-7'});
				return new Promise(() => {});
			},
			() => [result('Đã chạy tiếp.', 'session-7')],
		]);
		await terminal.type('/pirl-plan Email huỷ đơn');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Plan · đang chạy');
		expect(terminal.frame()).toContain('Esc dừng run');
		// The provider starts after the run's snapshot of the Hub and the target, which is slow on Windows.
		for (const end = Date.now() + 120_000; calls.length === 0 && Date.now() < end; ) await tick(40);
		await tick(100);
		await terminal.press(KEYS.escape);
		await until(terminal, 'Đã dừng. Gõ /resume để chạy tiếp.');
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Chọn run muốn chạy tiếp');
		expect(terminal.frame()).toMatch(/Plan đã dừng \d{2}\/\d{2} \d{2}:\d{2}/);
		expect(terminal.frame()).toContain('Email huỷ đơn');
		await terminal.press(KEYS.enter);
		// Choosing the run starts nothing: it waits for what the user types.
		await until(terminal, 'Run chưa chạy. Nhập yêu cầu để chạy tiếp');
		expect(terminal.frame()).toContain('Esc huỷ chạy tiếp');
		await tick(300);
		expect(calls).toHaveLength(1);
		await terminal.type('tiếp tục, thêm cả email cho admin');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã chạy tiếp.');
		expect(calls[1]!.prompt).toBe('tiếp tục, thêm cả email cho admin');
		expect(calls[1]!.resumeSessionId).toBe('session-7');
	});

	test('a run chosen in /resume never starts by itself; Esc cancels it and later text is a new chat', async () => {
		const {terminal, calls} = await startWithRuns([
			(_call, emit) => {
				emit({type: 'session', sessionId: 'session-8'});
				return new Promise(() => {});
			},
			() => [result('Trả lời chat.', 'chat-1')],
		]);
		await terminal.type('/pirl-plan Email huỷ đơn');
		await terminal.press(KEYS.enter);
		for (const end = Date.now() + 120_000; calls.length === 0 && Date.now() < end; ) await tick(40);
		await tick(100);
		await terminal.press(KEYS.escape);
		await until(terminal, 'Đã dừng. Gõ /resume để chạy tiếp.');
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Chọn run muốn chạy tiếp');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Run chưa chạy.');
		await terminal.press(KEYS.enter); // Enter with nothing typed does nothing
		await tick(300);
		expect(calls).toHaveLength(1);
		await terminal.press(KEYS.escape);
		await until(terminal, 'Đã huỷ chạy tiếp; run vẫn còn trong /resume.');
		await terminal.type('một câu hỏi');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Trả lời chat.');
		expect(calls[1]!.resumeSessionId).toBeUndefined();
		expect(calls[1]!.prompt).toBe('một câu hỏi');
	});

	test('Esc stops a run that waits for answers; it can be resumed later', async () => {
		const {terminal, calls} = await startWithRuns([
			() => [{type: 'session', sessionId: 'session-q'}, result('Thiếu quyết định.\n```pirl-questions\n[{"id":"Q1","question":"Gửi email khi admin huỷ?","options":["Có","Không"]}]\n```', 'session-q')],
		]);
		await terminal.type('/pirl-plan Email huỷ đơn');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Cần quyết định (1/1)');
		expect(terminal.frame()).toContain('Esc dừng run');
		await terminal.press(KEYS.escape);
		await until(terminal, 'Đã dừng. Gõ /resume để chạy tiếp.');
		expect(calls).toHaveLength(1);
		await terminal.type('/pirl-review khác');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).not.toContain('Đang có run chưa xong');
	});

	test('Esc says the run is stopping, and a second Esc forces the provider', async () => {
		const {hub, target} = await hubAndTarget();
		let started = false;
		let stops = 0;
		let end: (value: {code: number | null; stderr: string}) => void = () => {};
		const slow = {
			start: () => ((started = true), {
				done: new Promise<{code: number | null; stderr: string}>(resolve => (end = resolve)),
				stop: () => {
					stops += 1;
					if (stops === 2) end({code: null, stderr: ''});
				},
			}),
		};
		const base = appProps({info: sessionInfo({target: {kind: 'git', root: target, name: 'shop', branch: 'main'}, hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'}})});
		const services: Services = {...base.props.services, startRun: options => new RunController({runner: slow, hub, target, python: PYTHON, maxParallelRoles: 1}, options.id, options.kind, options.request)};
		const terminal = renderTerminal(<App {...base.props} services={services} />, 100, 30);
		open.push(terminal);
		await tick(60);
		await terminal.type('/pirl-plan A');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Plan · đang chạy');
		// The provider starts after the run's snapshot of the Hub and the target.
		for (const end = Date.now() + 120_000; !started && Date.now() < end; ) await tick(40);
		await terminal.press(KEYS.escape);
		await until(terminal, 'Nhấn Esc lần nữa để buộc dừng ngay.');
		expect(stops).toBe(1);
		expect(terminal.frame()).toContain('Plan · đang chạy');
		await terminal.press(KEYS.escape);
		await until(terminal, 'Plan · đã dừng');
		expect(stops).toBe(2);
	});

	test('Esc before the provider starts: nothing to resume, and the run block says so', async () => {
		const {terminal, calls} = await startWithRuns([() => new Promise(() => {})]);
		await terminal.type('/pirl-plan Email huỷ đơn');
		await terminal.press(KEYS.enter);
		await terminal.press(KEYS.escape); // at once, while the run still takes its snapshot
		await until(terminal, 'Plan · đã dừng');
		if (calls.length === 0) expect(terminal.frame()).toContain('Đã dừng trước khi provider bắt đầu. Gõ lại lệnh để chạy.');
	});

	test('one run at a time', async () => {
		const {terminal} = await startWithRuns([() => new Promise(() => {})]);
		await terminal.type('/pirl-plan A');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Plan · đang chạy');
		await terminal.type('/pirl-review B');
		await terminal.press(KEYS.enter);
		expect(await until(terminal, 'Đang có run chưa xong')).toBeTruthy();
	});

	test('Ctrl+C stops a running run instead of closing the TUI', async () => {
		const {terminal} = await startWithRuns([() => new Promise(() => {})]);
		let exited = false;
		void terminal.instance.waitUntilExit().then(() => (exited = true));
		await terminal.type('/pirl-plan A');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Plan · đang chạy');
		await terminal.press('\u0003');
		await until(terminal, 'Đã dừng');
		expect(exited).toBe(false);
		await terminal.press('\u0003');
		await tick();
		expect(exited).toBe(true);
	});

	test('a second Ctrl+C closes the TUI even when the provider is slow to stop', async () => {
		// A provider that ignores the stop request: the run stays "running" after the first Ctrl+C.
		const {hub, target} = await hubAndTarget();
		const stuck = {start: () => ({done: new Promise<{code: number | null; stderr: string}>(() => {}), stop: () => {}})};
		const base = appProps({info: sessionInfo({target: {kind: 'git', root: target, name: 'shop', branch: 'main'}, hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'}})});
		const services: Services = {...base.props.services, startRun: options => new RunController({runner: stuck, hub, target, python: PYTHON, maxParallelRoles: 1}, options.id, options.kind, options.request)};
		const terminal = renderTerminal(<App {...base.props} services={services} />, 100, 30);
		open.push(terminal);
		await tick(60);
		let exited = false;
		void terminal.instance.waitUntilExit().then(() => (exited = true));
		await terminal.type('/pirl-plan A');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Plan · đang chạy');
		await terminal.press('\u0003');
		expect(exited).toBe(false);
		await terminal.press('\u0003');
		await tick();
		expect(exited).toBe(true);
	});

	test('chat: the reply is shown, a layer request comes back as a prefilled command, the session continues', async () => {
		const {terminal, calls} = await startWithRuns([
			() => [{type: 'session', sessionId: 'chat-1'}, result('PIRL gồm ba layer.', 'chat-1')],
			() => [result('Đây là việc của layer Plan.\n```pirl-suggest\n/pirl-plan Email huỷ đơn\n```', 'chat-1')],
		]);
		await terminal.type('PIRL là gì?');
		await terminal.press(KEYS.enter);
		await until(terminal, 'PIRL gồm ba layer.');
		await terminal.type('tạo plan cho email huỷ đơn');
		await terminal.press(KEYS.enter);
		const frame = await until(terminal, '› /pirl-plan Email huỷ đơn');
		expect(frame).toContain('Lệnh đã được điền sẵn vào ô nhập');
		expect(calls[1]!.resumeSessionId).toBe('chat-1');
		expect(calls[1]!.prompt).toBe('tạo plan cho email huỷ đơn');
	});

	test('/plans and /records read the Hub for this repository', async () => {
		const {terminal, hub, target} = await startWithRuns([]);
		const {planSet} = writePlan(hub, target);
		writeRecord(hub, target, planSet);
		await terminal.type('/plans');
		await terminal.press(KEYS.enter);
		const plans = terminal.frame();
		expect(plans).toMatch(/order-email_\d{8}-\d{6}/);
		expect(plans).toContain('T01 [planned]');
		// Enter opens the chosen Plan: its frontmatter and its sections; Esc goes back to the list.
		await terminal.press(KEYS.enter);
		const detail = await until(terminal, 'task_id: T01');
		expect(detail).toContain('target_repo:');
		expect(detail).toContain('What to do');
		await terminal.press(KEYS.escape);
		await until(terminal, 'T01 [planned]');
		await terminal.press(KEYS.escape);
		await terminal.type('/records');
		await terminal.press(KEYS.enter);
		expect(terminal.frame()).toContain('plan · ready');
		expect(terminal.frame()).toContain('Plan cho email huỷ đơn');
		await terminal.press(KEYS.enter);
		const record = await until(terminal, 'Vấn đề (0)');
		expect(record).toContain('Kết quả: ready');
		expect(record).toContain('Cải tiến (0)');
		expect(record).toMatch(/code-analyst agent PASS/);
	});

	test('/resume lists the runs that can continue and resumes the one chosen', async () => {
		const stopped = (sessionId: string): FakeScript => (_call, emit) => {
			emit({type: 'session', sessionId});
			return new Promise(() => {});
		};
		const {terminal, calls} = await startWithRuns([stopped('s-a'), stopped('s-b'), () => [result('Chạy tiếp A.', 's-a')]]);
		for (const request of ['Việc A', 'Việc B']) {
			await terminal.type(`/pirl-plan ${request}`);
			await terminal.press(KEYS.enter);
			for (const end = Date.now() + 120_000; calls.length < (request === 'Việc A' ? 1 : 2) && Date.now() < end; ) await tick(40);
			await tick(100);
			await terminal.press(KEYS.escape);
			await until(terminal, request === 'Việc A' ? 'Plan · đã dừng' : /đã dừng[\s\S]*đã dừng/);
		}
		await terminal.type('/resume');
		await terminal.press(KEYS.enter);
		const picker = await until(terminal, 'Chọn run muốn chạy tiếp');
		expect(picker.indexOf('Việc B')).toBeLessThan(picker.indexOf('Việc A')); // newest first
		await terminal.press(KEYS.down);
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã chọn Plan: Việc A');
		await terminal.type('tiếp tục');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Chạy tiếp A.');
		expect(calls[2]!.resumeSessionId).toBe('s-a');
		expect(calls[2]!.prompt).toBe('tiếp tục');
	});
});

describe('spinner and log', () => {
	const busy: FakeScript = (_call, emit) => {
		emit({type: 'session', sessionId: 's-1'});
		emit({type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace cancelOrder'});
		emit({type: 'activity', agent: 'tu-1', text: 'Đọc src/orders/cancel.ts'});
		emit({type: 'activity', agent: null, text: 'Chạy python3 -B .agents/evals/layer_record.py start'});
		return new Promise(() => {});
	};
	const spinnerGlyph = (frame: string) => /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) Plan · đang chạy/.exec(frame)?.[1];

	test('the spinner turns and the clock runs while a run works', async () => {
		const {terminal} = await startWithRuns([busy], {}, [100, 30]);
		await terminal.type('/pirl-plan Email');
		await terminal.press(KEYS.enter);
		const first = spinnerGlyph(await until(terminal, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Plan · đang chạy · 00:0\d/));
		// The spinner turns every 200 ms; a busy runner can delay a frame, so wait for the turn, not a fixed time.
		await until(terminal, new RegExp(`(?!${first})[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Plan · đang chạy`), 5_000);
		expect(spinnerGlyph(terminal.frame())).not.toBe(first);
		expect(terminal.frame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Plan: đang chạy · 00:0\d/); // status bar
	});

	test('with motion off in /settings the glyph stays still', async () => {
		const {terminal} = await startWithRuns([busy], {}, [100, 30]);
		await terminal.type('/settings');
		await terminal.press(KEYS.enter);
		for (let i = 0; i < 9; i++) await terminal.press(KEYS.down);
		await terminal.press(KEYS.right);
		await until(terminal, 'Hiệu ứng chuyển động  ‹ Tắt ›');
		await terminal.press(KEYS.escape);
		await terminal.type('/pirl-plan Email');
		await terminal.press(KEYS.enter);
		await until(terminal, '▸ Plan · đang chạy');
		await tick(250);
		expect(terminal.frame()).toContain('▸ Plan · đang chạy');
	});

	test('the side panel shows the plan\'s usage windows where the log was; narrow windows put them in the status line', async () => {
		const rows = [
			{kind: 'five_hour', label: '5 giờ', percent: 42, resetsAt: null},
			{kind: 'seven_day', label: 'Tuần', percent: 91, resetsAt: null},
		];
		const wide = await startWithRuns([busy], {quota: async () => rows}, [160, 40]);
		const frame = await until(wide.terminal, 'Hạn mức');
		expect(frame).toMatch(/5 giờ\s+█+░+ 42%/);
		expect(frame).toMatch(/Tuần\s+█+░* 91%/);
		expect(frame).toContain('Model      sonnet · effort medium');
		await wide.terminal.type('/pirl-plan Email');
		await wide.terminal.press(KEYS.enter);
		const running = await until(wide.terminal, /code-analyst/);
		expect(running).not.toContain('Nhật ký');

		const narrow = await startWithRuns([busy], {quota: async () => rows}, [100, 30]);
		expect(await until(narrow.terminal, '5 giờ 42% · Tuần 91%')).not.toContain('Hạn mức');

		const none = await startWithRuns([busy], {}, [160, 40]);
		expect(await until(none.terminal, 'Hạn mức')).toContain('Chưa có số liệu.');
	});
});

describe('input keys', () => {
	const typedLines = (terminal: Terminal) => terminal.lines().filter(line => line.startsWith('│ ›') || line.startsWith('│  '));

	test('Shift+Enter (kitty), Alt+Enter, Ctrl+J and modifyOtherKeys add a line; Enter alone sends', async () => {
		const {terminal} = renderWith();
		await tick(60);
		await terminal.type('một');
		await terminal.press('\u001B[13;2u'); // Shift+Enter, kitty keyboard protocol
		await terminal.type('hai');
		await terminal.press('\u001B\r'); // Alt+Enter
		await terminal.type('ba');
		await terminal.press('\n'); // Ctrl+J
		await terminal.type('bốn');
		await terminal.press('\u001B[27;2;13~'); // Shift+Enter, xterm modifyOtherKeys
		await terminal.type('năm');
		const lines = typedLines(terminal).join('\n');
		for (const word of ['› một', 'hai', 'ba', 'bốn', 'năm']) expect(lines).toContain(word);
		expect(terminal.frame()).not.toContain('Bản này chưa nối');
	});

	test('Ctrl+V pastes from the clipboard; /copy copies the latest reply', async () => {
		const copied: string[] = [];
		const clipboard = {copy: async (text: string) => (copied.push(text), 'native' as const), paste: async () => 'dán từ clipboard'};
		const {terminal} = await startWithRuns([() => [result('Câu trả lời để copy.')]], {clipboard});
		await terminal.press('\u0016');
		expect(await until(terminal, '› dán từ clipboard')).toBeTruthy();
		await terminal.press(KEYS.escape);
		await terminal.type('hỏi gì đó');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Câu trả lời để copy.');
		await terminal.type('/copy');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã copy câu trả lời gần nhất vào clipboard.');
		expect(copied).toEqual(['Câu trả lời để copy.']);
	});

	function renderWith() {
		const terminal = renderTerminal(<App {...appProps().props} />, 100, 30);
		open.push(terminal);
		return {terminal};
	}
});
