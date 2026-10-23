import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {exec} from '../src/core/exec.js';
import {packageRoot} from '../src/core/paths.js';
import {loadBundledFramework, storedPath, type BundledFramework} from '../src/hub/framework.js';
import {ensureHub, hubStatus, HubError, parsePorcelain} from '../src/hub/hub.js';

const temporary: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'pirl-hub-'));
	temporary.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const bundle = loadBundledFramework(packageRoot());
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'}).trim();

describe('bundled framework', () => {
	test('manifest hashes are Git blob hashes of the bundled files', () => {
		for (const path of ['AGENTS.md', '.agents/evals/layer_record.py']) {
			const hash = execFileSync('git', ['hash-object', join(bundle.filesDir, path)], {encoding: 'utf8'}).trim();
			expect(bundle.manifest.files[path]).toBe(hash);
		}
		expect(Object.keys(bundle.manifest.files)).toContain('.skills/pirl-plan/SKILL.md');
		expect(Object.keys(bundle.manifest.files).some(path => path.includes('__pycache__'))).toBe(false);
	});

	test('no file in the package is named .gitignore, since npm would leave it out', () => {
		expect(bundle.manifest.files['.gitignore']).toBeDefined();
		expect(existsSync(join(bundle.filesDir, '.gitignore'))).toBe(false);
		expect(existsSync(join(bundle.filesDir, storedPath('.gitignore')))).toBe(true);
	});
});

describe('ensureHub', () => {
	test('first run creates upstream and main on one tagged commit, with no remote and a clean tree', async () => {
		const path = join(tempDir(), 'hub');
		const {created, status} = await ensureHub(path, bundle);
		expect(created).toBe(true);
		expect(status).toMatchObject({
			upstreamTag: `fw-${bundle.manifest.version}`,
			localImprovements: 0,
			uncommitted: [],
			updateAvailable: false,
			branch: 'main',
		});
		expect(git(path, 'rev-parse', 'upstream')).toBe(git(path, 'rev-parse', 'main'));
		expect(git(path, 'remote')).toBe('');
		expect(git(path, 'config', 'core.autocrlf')).toBe('false');
		expect(git(path, 'log', '-1', '--format=%an', 'upstream')).toBe('PIRL CLI');
		expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe(readFileSync(join(bundle.filesDir, 'AGENTS.md'), 'utf8'));
		expect(existsSync(`${path}.creating-${process.pid}`)).toBe(false);
		// The framework's own ignore rules are in place: Plan packages and records stay out of Git.
		expect(readFileSync(join(path, '.gitignore'), 'utf8')).toContain('.agents/evals/records/');
		mkdirSync(join(path, 'order-email_20261023-101500'));
		writeFileSync(join(path, 'order-email_20261023-101500', 'T01.md'), 'plan');
		expect(git(path, 'status', '--porcelain')).toBe('');
	});

	test('the next run reuses the Hub and counts local improvements and uncommitted changes', async () => {
		const path = join(tempDir(), 'hub');
		await ensureHub(path, bundle);
		writeFileSync(join(path, 'CONTEXT.md'), readFileSync(join(path, 'CONTEXT.md'), 'utf8') + '\nLocal rule.\n');
		git(path, 'commit', '--quiet', '-am', 'Improve CONTEXT.md');
		writeFileSync(join(path, 'AGENTS.md'), 'changed\n');
		const again = await ensureHub(path, bundle);
		expect(again.created).toBe(false);
		expect(again.status.localImprovements).toBe(1);
		expect(again.status.uncommitted).toEqual(['AGENTS.md']);
		// Local work on main is not a newer bundled framework.
		expect(again.status.updateAvailable).toBe(false);
	});

	test('a bundled framework that differs from upstream is reported as an update', async () => {
		const path = join(tempDir(), 'hub');
		await ensureHub(path, bundle);
		const files = join(tempDir(), 'files');
		cpSync(bundle.filesDir, files, {recursive: true});
		const newer: BundledFramework = {
			filesDir: files,
			manifest: {...bundle.manifest, version: '1.1.0', files: {...bundle.manifest.files, 'NEW.md': 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'}},
		};
		expect((await hubStatus(path, newer)).updateAvailable).toBe(true);
		// The CLI only reports it: nothing in the Hub changed.
		expect(git(path, 'status', '--porcelain')).toBe('');
	});

	test('never touches a non-empty directory that is not a PIRL Hub', async () => {
		const path = join(tempDir(), 'hub');
		mkdirSync(path);
		writeFileSync(join(path, 'notes.txt'), 'mine');
		await expect(ensureHub(path, bundle)).rejects.toBeInstanceOf(HubError);
		expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('mine');
		expect(existsSync(join(path, '.git'))).toBe(false);
	});

	test('a git repository without the PIRL marker is refused too', async () => {
		const path = join(tempDir(), 'hub');
		mkdirSync(path);
		git(path, 'init', '--quiet');
		await expect(ensureHub(path, bundle)).rejects.toThrow(/không phải Hub/);
	});

	test('an empty directory becomes the Hub', async () => {
		const path = join(tempDir(), 'hub');
		mkdirSync(path);
		expect((await ensureHub(path, bundle)).created).toBe(true);
	});

	test('uses the injected exec for every git call', async () => {
		const calls: string[] = [];
		const path = join(tempDir(), 'hub');
		await ensureHub(path, bundle, (command, args, options) => {
			calls.push(args.filter(arg => !arg.includes('=')).filter(arg => arg !== '-c')[0] ?? '');
			return exec(command, args, options);
		});
		expect(calls).toEqual(expect.arrayContaining(['init', 'commit', 'tag', 'branch', 'checkout', 'config']));
	});
});

describe('parsePorcelain', () => {
	test('skips the original path that follows a rename', () => {
		expect(parsePorcelain(' M AGENTS.md\0R  new.md\0old.md\0?? notes.txt\0')).toEqual(['AGENTS.md', 'new.md', 'notes.txt']);
	});
});
