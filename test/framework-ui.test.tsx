import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import type {BundledFramework} from '../src/hub/framework.js';
import {ensureHub, hubStatus} from '../src/hub/hub.js';
import {frameworkServices} from '../src/hub/services.js';
import {App} from '../src/ui/App.js';
import {bundle, newerBundle} from './helpers/bundle.js';
import {appProps, sessionInfo} from './helpers/fixtures.js';
import {fakeRunner, removeDir, result, type FakeScript} from './helpers/hub.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

const temporary: string[] = [];
const open: Array<ReturnType<typeof renderTerminal>> = [];
const tempDir = (prefix = 'pirl-fwui-') => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temporary.push(dir);
	return dir;
};
afterEach(() => {
	for (const terminal of open.splice(0)) terminal.cleanup();
	for (const dir of temporary.splice(0)) removeDir(dir);
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'}).trim();
const ROLE = '.agents/roles/code-analyst.role.md';

async function until(terminal: ReturnType<typeof renderTerminal>, text: string | RegExp, ms = 180_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const frame = terminal.frame();
		if (typeof text === 'string' ? frame.includes(text) : text.test(frame)) return frame;
		await tick(50);
	}
	throw new Error(`timed out waiting for ${text}\n${terminal.frame()}`);
}

/** A Hub made from the bundled framework with one local improvement, opened in a TUI that ships `shipped`. */
async function setup(shipped: BundledFramework, scripts: FakeScript[] = []) {
	const hub = join(tempDir(), 'hub');
	await ensureHub(hub, bundle);
	writeFileSync(join(hub, ROLE), readFileSync(join(hub, ROLE), 'utf8').replace('# code-analyst', '# code-analyst (local)'));
	git(hub, 'commit', '-q', '-am', 'Framework improvement from a plan run\n\nPirl-Record: plan-1\nPirl-Source: auditor');
	const {runner, calls} = fakeRunner(scripts);
	const {props} = appProps({
		info: sessionInfo({hub: await hubStatus(hub, shipped)}),
		services: {
			runDoctor: async () => (await import('./helpers/fixtures.js')).READY_REPORT,
			saveConfig: () => {},
			framework: frameworkServices(hub, shipped, runner, () => 'sonnet'),
		},
	});
	const terminal = renderTerminal(<App {...props} />, 110, 40);
	open.push(terminal);
	await tick(60);
	await terminal.type('/framework');
	await terminal.press(KEYS.enter);
	return {hub, terminal, calls};
}

describe('/framework', () => {
	test('update through a draft: a conflict merged by the agent, checked, applied, then undone', async () => {
		const shipped = newerBundle({[ROLE]: text => text.replace('# code-analyst', '# code-analyst (upstream)')}, '9.9.9', prefix => tempDir(prefix));
		const merged = (text: string) => text.replace('# code-analyst (local)', '# code-analyst (local + upstream)');
		const {hub, terminal, calls} = await setup(shipped, [
			call => {
				const mine = readFileSync(join(call.cwd, '.tmp', 'pirl-merge', 'mine'), 'utf8');
				writeFileSync(join(call.cwd, '.tmp', 'pirl-merge', 'merged'), merged(mine));
				return [result('Bản gốc mới đổi tiêu đề; bản của bạn cũng đổi tiêu đề. Đã giữ cả hai ý.')];
			},
		]);
		const before = git(hub, 'rev-parse', 'main');
		await until(terminal, 'Cập nhật lên fw-9.9.9');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Bản nháp: fw-9.9.9 gộp vào framework của bạn');
		expect(terminal.frame()).toContain(`${ROLE}: chưa chọn`);
		expect(git(hub, 'rev-parse', 'main')).toBe(before);

		await terminal.press(KEYS.enter);
		await until(terminal, 'Bản gốc mới đổi:');
		const conflict = terminal.frame();
		expect(conflict).toContain('+# code-analyst (upstream)');
		expect(conflict).toContain('+# code-analyst (local)');
		expect(conflict).toContain('record plan-1');
		expect(conflict).toContain('Để agent gộp hai bản (khuyến nghị)');

		await terminal.press(KEYS.enter); // the recommended option: the agent merges
		await until(terminal, 'Bản gộp của agent');
		expect(terminal.frame()).toContain('Đã giữ cả hai ý.');
		expect(calls[0]!.allow.some(rule => rule.includes('pirl-merge/merged'))).toBe(true);
		expect(calls[0]!.deny).toContain('Bash');
		expect(calls[0]!.model).toBe('sonnet');
		await terminal.press(KEYS.enter);
		await until(terminal, `${ROLE}: dùng bản gộp của agent`);

		await terminal.press(KEYS.down);
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã cập nhật lên fw-9.9.9', 240_000);
		expect(readFileSync(join(hub, ROLE), 'utf8')).toContain('# code-analyst (local + upstream)');
		expect(git(hub, 'status', '--porcelain')).toBe('');
		await until(terminal, /fw-9\.9\.9/);

		await terminal.press(KEYS.enter);
		await until(terminal, 'Hoàn tác lần cập nhật lên fw-9.9.9');
		await terminal.press('3');
		await terminal.press(KEYS.enter);
		await until(terminal, 'Hub quay về đúng như trước lần cập nhật đó.');
		await terminal.press(KEYS.up); // from "Không" to "Hoàn tác"
		await terminal.press(KEYS.enter);
		await until(terminal, 'Đã hoàn tác lần cập nhật lên fw-9.9.9.');
		expect(git(hub, 'rev-parse', 'main')).toBe(before);
	});

	test('local improvements: the diff of a file, then restoring it to the original', async () => {
		const {hub, terminal} = await setup(bundle);
		await until(terminal, 'Xem cải tiến cục bộ');
		expect(terminal.frame()).not.toContain('Cập nhật lên');
		await terminal.press(KEYS.enter);
		await until(terminal, `${ROLE}  (sửa, +1 −1)`);
		await terminal.press(KEYS.enter);
		await until(terminal, '+# code-analyst (local)');
		await terminal.press('r');
		await until(terminal, `Khôi phục ${ROLE} về bản gốc?`);
		await terminal.press(KEYS.up);
		await terminal.press(KEYS.enter);
		await until(terminal, `Đã khôi phục ${ROLE} về bản gốc.`);
		expect(readFileSync(join(hub, ROLE), 'utf8')).toContain('# code-analyst\n');
		await terminal.press(KEYS.enter);
		await terminal.press(KEYS.down);
		await terminal.press(KEYS.enter);
		await until(terminal, `Restore ${ROLE} to the original framework`);
		expect(terminal.frame()).toContain('nguồn: restore');
	});
});
