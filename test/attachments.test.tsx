import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {
	attachmentContext,
	FILE_LIMIT,
	findMentions,
	pathIndex,
	resolveMentions,
	suggestPaths,
	type PathEntry,
} from '../src/engine/attachments.js';
import {RunController} from '../src/engine/run.js';
import {App} from '../src/ui/App.js';
import {emptyEditor, insert, mentionAt, replaceMention} from '../src/ui/inputEditor.js';
import type {Services} from '../src/ui/session.js';
import {appProps, sessionInfo} from './helpers/fixtures.js';
import {cleanupTemp, fakeRunner, git, hubAndTarget, PYTHON, result, tempDir} from './helpers/hub.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

type Terminal = ReturnType<typeof renderTerminal>;
const open: Terminal[] = [];
afterEach(() => {
	for (const terminal of open.splice(0)) terminal.cleanup();
	cleanupTemp();
});

const noGit = async () => ({code: 128, stdout: '', stderr: 'not a git repository'});

const INDEX: PathEntry[] = [
	{path: 'src', folder: true},
	{path: 'src/ui', folder: true},
	{path: 'docs', folder: true},
	{path: 'README.md', folder: false},
	{path: 'src/main.ts', folder: false},
	{path: 'src/ui/App.tsx', folder: false},
	{path: 'src/ui/appState.ts', folder: false},
	{path: 'docs/app guide.md', folder: false},
];

describe('@ mentions', () => {
	test('the mention being typed: after a space or at the start, never inside a word', () => {
		expect(mentionAt(insert(emptyEditor, '@sr'))).toEqual({start: 0, query: 'sr'});
		expect(mentionAt(insert(emptyEditor, 'sửa lỗi trong @src/ui'))).toEqual({start: 14, query: 'src/ui'});
		expect(mentionAt(insert(emptyEditor, 'gửi tới dev@shop.vn'))).toBeNull();
		expect(mentionAt(insert(emptyEditor, '@src/a.ts xong'))).toBeNull();
		expect(mentionAt(insert(emptyEditor, '@"docs/app g'))).toEqual({start: 0, query: 'docs/app g'});
		const state = insert(emptyEditor, 'xem @ap');
		expect(replaceMention(state, 4, '@src/ui/App.tsx ')).toEqual({value: 'xem @src/ui/App.tsx ', cursor: 20});
	});

	test('suggestions: the top level, a folder\'s own entries, then the best matches first', () => {
		expect(suggestPaths(INDEX, '').map(entry => entry.path)).toEqual(['src', 'docs', 'README.md']);
		expect(suggestPaths(INDEX, 'src/ui/').map(entry => entry.path)).toEqual(['src/ui', 'src/ui/App.tsx', 'src/ui/appState.ts']);
		expect(suggestPaths(INDEX, 'app').map(entry => entry.path)).toEqual(['src/ui/App.tsx', 'docs/app guide.md', 'src/ui/appState.ts']);
		expect(suggestPaths(INDEX, 'src/m').map(entry => entry.path)).toEqual(['src/main.ts']);
		expect(suggestPaths(INDEX, 'zzz')).toEqual([]);
	});

	test('mentions in a request: quoted paths, no e-mail addresses, trailing punctuation dropped, unknown ones left as text', () => {
		expect(findMentions('xem @src/a.ts, @"docs/app guide.md" và hỏi dev@shop.vn')).toEqual(['src/a.ts,', 'docs/app guide.md']);
		const base = tempDir('pirl-attach-');
		mkdirSync(join(base, 'src'));
		writeFileSync(join(base, 'src/a.ts'), 'export const a = 1;\n');
		const found = resolveMentions('xem @src/a.ts, rồi @src/ và lại @src/a.ts; còn @khong-co thì bỏ qua', base);
		expect(found.map(item => [item.display, item.kind])).toEqual([
			['src/a.ts', 'file'],
			['src/', 'folder'],
		]);
	});

	test('context: small text files go in full, big and binary ones as paths, folders as file lists', async () => {
		const base = tempDir('pirl-attach-');
		mkdirSync(join(base, 'src/node_modules/x'), {recursive: true});
		writeFileSync(join(base, 'src/a.ts'), 'const fence = "```";\n');
		writeFileSync(join(base, 'src/node_modules/x/index.js'), '');
		writeFileSync(join(base, 'big.log'), 'x'.repeat(FILE_LIMIT + 1));
		writeFileSync(join(base, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
		const outside = tempDir('pirl-outside-');
		writeFileSync(join(outside, 'notes.md'), '# Notes\n');
		const context = await attachmentContext(resolveMentions(`@src/a.ts @big.log @logo.png @src/ @${outside}`, base), [base], noGit);
		expect(context.text).toContain('# Attached by the user');
		expect(context.text).toContain('````ts\nconst fence = "```";\n````');
		expect(context.text).toContain('## File: big.log');
		expect(context.text).toContain('Too large to include here');
		expect(context.text).not.toContain('xxxxxxxx');
		expect(context.text).toContain('Not text');
		expect(context.text).toContain('## Folder: src/');
		expect(context.text).toContain('- a.ts');
		expect(context.text).not.toContain('node_modules');
		expect(context.text).toContain('- notes.md');
		expect(context.dirs).toEqual([outside]);
		expect(context.summary.map(item => item.tone ?? 'info')).toEqual(['info', 'warning', 'info', 'info', 'info']);
	});

	test('the index lists files and their folders; in a Git repository it follows .gitignore', async () => {
		const base = tempDir('pirl-attach-');
		git(base, 'init', '--quiet');
		mkdirSync(join(base, 'src/ui'), {recursive: true});
		writeFileSync(join(base, '.gitignore'), 'dist/\n');
		writeFileSync(join(base, 'src/ui/App.tsx'), '');
		mkdirSync(join(base, 'dist'));
		writeFileSync(join(base, 'dist/out.js'), '');
		const index = await pathIndex(base);
		expect(index).toEqual(expect.arrayContaining([{path: 'src', folder: true}, {path: 'src/ui', folder: true}, {path: 'src/ui/App.tsx', folder: false}]));
		expect(index.some(entry => entry.path.startsWith('dist'))).toBe(false);
	});

	test('a run sends the attachments with the request only, and reaches attached folders outside the target', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([() => [{type: 'session', sessionId: 's-1'}, result('Đã đọc.')], () => [result('Tiếp.')]]);
		const deps = {runner, hub, target, python: PYTHON, maxParallelRoles: 2, attachments: {text: '# Attached by the user\n…', dirs: ['/data/specs']}};
		await new RunController(deps, 1, 'chat', 'Giải thích @README.md').start();
		expect(calls[0]!.prompt).toBe('Giải thích @README.md\n\n# Attached by the user\n…');
		expect(calls[0]!.addDirs).toEqual([target, '/data/specs']);
		// /resume of a stopped run sends "continue", which carries no attachments.
		await new RunController(deps, 2, 'chat', 'Giải thích @README.md', {sessionId: 's-1'}).start();
		expect(calls[1]!.prompt).toBe('Tiếp tục run bị dừng từ chỗ đã dừng.');
	});
});

describe('@ in the TUI', () => {
	async function startTui() {
		const {hub, target} = await hubAndTarget();
		mkdirSync(join(target, 'src/ui'), {recursive: true});
		writeFileSync(join(target, 'src/ui/App.tsx'), 'export const App = () => null;\n');
		writeFileSync(join(target, 'src/main.ts'), 'main();\n');
		const {runner, calls} = fakeRunner([() => [{type: 'session', sessionId: 's-1'}, result('Đã xem.')]]);
		const base = appProps({
			info: sessionInfo({
				target: {kind: 'git', root: target, name: 'shop', branch: 'main'},
				hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'},
			}),
		});
		const services: Services = {
			...base.props.services,
			startRun: options =>
				new RunController({runner, hub, target, python: PYTHON, maxParallelRoles: 2, attachments: options.attachments}, options.id, options.kind, options.request, options.resume),
			paths: () => pathIndex(target),
			attach: text => attachmentContext(resolveMentions(text, target), [target, hub]),
		};
		const terminal = renderTerminal(<App {...base.props} services={services} />, 100, 30);
		open.push(terminal);
		await tick(60);
		return {terminal, calls};
	}

	const until = async (terminal: Terminal, check: (frame: string) => boolean, ms = 20_000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (check(terminal.frame())) return;
			await tick(40);
		}
		throw new Error(`timed out\n${terminal.frame()}`);
	};

	test('@ offers paths; Tab opens a folder, Enter picks a file; the run gets its content', async () => {
		const {terminal, calls} = await startTui();
		await terminal.type('xem @');
		await until(terminal, frame => frame.includes('@src/') && frame.includes('@README.md'));
		expect(terminal.frame()).toContain('Tab/Enter chọn');
		await terminal.type('ui');
		await until(terminal, frame => frame.includes('❯ @src/ui/'));
		await terminal.press(KEYS.tab);
		await until(terminal, frame => frame.includes('Enter: đính kèm cả thư mục'));
		await terminal.press(KEYS.down);
		await terminal.press(KEYS.enter);
		await until(terminal, frame => frame.includes('xem @src/ui/App.tsx') && !frame.includes('Tab/Enter chọn'));
		await terminal.type('rồi giải thích');
		await terminal.press(KEYS.enter);
		await until(terminal, frame => frame.includes('Đã xem.'));
		expect(terminal.frame()).toMatch(/Đính kèm src\/ui\/App\.tsx \([\d.]+ B: gửi kèm nội dung\)/);
		expect(calls[0]!.prompt).toContain('xem @src/ui/App.tsx rồi giải thích\n\n# Attached by the user');
		expect(calls[0]!.prompt).toContain('export const App = () => null;');
	});

	test('Esc hides the list and keeps the text', async () => {
		const {terminal} = await startTui();
		await terminal.type('@READ');
		await until(terminal, frame => frame.includes('Tab/Enter chọn'));
		await terminal.press(KEYS.escape);
		await until(terminal, frame => !frame.includes('Tab/Enter chọn'));
		expect(terminal.frame()).toContain('@READ');
	});
});
