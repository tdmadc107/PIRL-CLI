import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig} from '../src/core/config.js';
import {exec} from '../src/core/exec.js';
import {displayPath, pirlHome} from '../src/core/paths.js';
import {detectTargetRepo} from '../src/core/targetRepo.js';
import {removeDir} from './helpers/hub.js';

const temporary: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'pirl-test-'));
	temporary.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temporary.splice(0)) removeDir(dir);
});

const git = async (cwd: string, ...args: string[]) => {
	const result = await exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {cwd});
	expect(result.code, result.stderr).toBe(0);
	return result.stdout;
};

describe('config', () => {
	test('a missing file gives the defaults without a warning', () => {
		expect(loadConfig(join(tempDir(), 'none.json'))).toEqual({config: DEFAULT_CONFIG});
	});

	test('a broken file gives the defaults and a warning', () => {
		const file = join(tempDir(), 'config.json');
		writeFileSync(file, '{not json');
		const loaded = loadConfig(file);
		expect(loaded.config).toEqual(DEFAULT_CONFIG);
		expect(loaded.warning).toContain(file);
	});

	test('invalid fields fall back one by one; valid ones are kept', () => {
		expect(normalizeConfig({provider: 'codex', theme: 'neon', colors: 'forest', glyphs: 'ascii', motion: 'yes', maxParallelRoles: 9, model: 'gpt-5', roleModel: 'haiku', effort: 'max'})).toEqual({
			provider: 'codex',
			theme: 'auto',
			colors: 'forest',
			glyphs: 'ascii',
			motion: true,
			mouse: 'select',
			maxParallelRoles: DEFAULT_CONFIG.maxParallelRoles,
			model: 'sonnet',
			roleModel: 'haiku',
			effort: 'max',
		});
	});

	test('the earlier on/off mouse setting becomes a mode', () => {
		expect(normalizeConfig({mouse: true}).mouse).toBe('select');
		expect(normalizeConfig({mouse: false}).mouse).toBe('off');
		expect(normalizeConfig({mouse: 'wheel'}).mouse).toBe('wheel');
	});

	test('save then load round-trips and leaves no temporary file', () => {
		const dir = tempDir();
		const file = join(dir, 'nested', 'config.json');
		const config = {...DEFAULT_CONFIG, theme: 'light' as const, maxParallelRoles: 3};
		saveConfig(file, config);
		expect(loadConfig(file).config).toEqual(config);
		expect(() => readFileSync(`${file}.tmp`)).toThrow();
	});
});

describe('paths', () => {
	test('PIRL_HOME moves the PIRL home directory', () => {
		expect(pirlHome({PIRL_HOME: '/x/y'})).toBe('/x/y');
		expect(pirlHome({})).toMatch(/\.pirl$/);
	});

	test('paths under home are shown with ~', () => {
		expect(displayPath('/home/dev/.pirl/hub', '/home/dev')).toBe('~/.pirl/hub');
		expect(displayPath('/home/dev', '/home/dev')).toBe('~');
		expect(displayPath('/home/devops/x', '/home/dev')).toBe('/home/devops/x');
	});
});

describe('detectTargetRepo', () => {
	test('a subdirectory resolves to its repository root and branch', async () => {
		const repo = tempDir();
		await git(repo, 'init', '--quiet', '-b', 'feature-x');
		await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
		mkdirSync(join(repo, 'src', 'deep'), {recursive: true});
		const found = await detectTargetRepo(join(repo, 'src', 'deep'));
		expect(found).toMatchObject({kind: 'git', branch: 'feature-x'});
		expect(found.kind === 'git' && found.root).toBe((await git(repo, 'rev-parse', '--show-toplevel')).trim());
	});

	test('a detached HEAD shows the short commit', async () => {
		const repo = tempDir();
		await git(repo, 'init', '--quiet');
		await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
		await git(repo, 'checkout', '--quiet', '--detach');
		const found = await detectTargetRepo(repo);
		expect(found.kind === 'git' && found.branch).toMatch(/^@[0-9a-f]{7,}$/);
	});

	test('outside a repository the layers are locked with a reason', async () => {
		const found = await detectTargetRepo(tempDir());
		expect(found).toMatchObject({kind: 'none', reason: 'Thư mục hiện tại không nằm trong git repo'});
	});
});

describe('exec', () => {
	test('reports a missing program instead of throwing', async () => {
		const result = await exec('pirl-no-such-program-xyz', []);
		expect(result.code).toBeNull();
		expect(result.error).toBeTruthy();
	});
});
