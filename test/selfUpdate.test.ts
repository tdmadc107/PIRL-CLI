import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import type {Exec, ExecResult} from '../src/core/exec.js';
import {checkForUpdate, compareVersions, latestVersion, runUpdate, updateCheckDisabled, updateCheckFile} from '../src/core/selfUpdate.js';
import {cleanupTemp, tempDir} from './helpers/hub.js';

afterEach(() => cleanupTemp());

const NAME = 'pirl-framework-cli';
const ok = (stdout: string): ExecResult => ({code: 0, stdout, stderr: ''});
const failed: ExecResult = {code: 1, stdout: '', stderr: 'npm error network'};

/** A stand-in for npm: answers `npm view` and `npm root -g`, and records every call. */
function fakeNpm(answers: {latest?: ExecResult; root?: ExecResult}) {
	const calls: string[] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, ...args].join(' '));
		if (args[0] === 'view') return answers.latest ?? failed;
		if (args[0] === 'root') return answers.root ?? failed;
		return failed;
	};
	return {exec, calls};
}

describe('versions', () => {
	test('release versions compare by number; anything else is not comparable', () => {
		expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
		expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
		expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
		expect(compareVersions('0.0.0-stage', '1.0.0')).toBe(0);
	});

	test('npm\'s latest tag counts only when it names a release, never the staging placeholder', async () => {
		expect(await latestVersion(NAME, fakeNpm({latest: ok('1.1.0\n')}).exec)).toBe('1.1.0');
		expect(await latestVersion(NAME, fakeNpm({latest: ok('0.0.0-stage\n')}).exec)).toBeNull();
		expect(await latestVersion(NAME, fakeNpm({latest: failed}).exec)).toBeNull();
		// npm configured with json=true prints the version quoted.
		expect(await latestVersion(NAME, fakeNpm({latest: ok('"1.1.0"\n')}).exec)).toBe('1.1.0');
	});
});

describe('the update check of the TUI', () => {
	test('asks npm at every start, so a version out three hours later shows at the next start', async () => {
		const file = updateCheckFile(tempDir('pirl-update-'));
		let latest = '1.0.1';
		const calls: string[] = [];
		const exec: Exec = async (_command, args) => (calls.push(args.join(' ')), ok(latest));
		let now = Date.parse('2026-11-01T08:00:00Z');
		const check = () => checkForUpdate({file, name: NAME, current: '1.0.1', exec, now: () => now, env: {}});
		expect(await check()).toBeNull();
		now += 3 * 60 * 60 * 1000;
		latest = '1.1.0';
		expect(await check()).toBe('1.1.0');
		expect(calls).toHaveLength(2);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({checkedAt: '2026-11-01T11:00:00.000Z', latest: '1.1.0'});
	});

	test('offline, the last answer npm gave is used; never having reached npm, it stays silent', async () => {
		const file = updateCheckFile(tempDir('pirl-update-'));
		const offline = fakeNpm({latest: failed});
		expect(await checkForUpdate({file, name: NAME, current: '1.0.1', exec: offline.exec, env: {}})).toBeNull();
		expect(existsSync(file)).toBe(false);
		expect(await checkForUpdate({file, name: NAME, current: '1.0.1', exec: fakeNpm({latest: ok('1.1.0')}).exec, env: {}})).toBe('1.1.0');
		expect(await checkForUpdate({file, name: NAME, current: '1.0.1', exec: offline.exec, env: {}})).toBe('1.1.0');
		expect(await checkForUpdate({file, name: NAME, current: '1.1.0', exec: offline.exec, env: {}})).toBeNull();
	});

	test('stays silent in CI, or when turned off; CI=false is not CI', async () => {
		const npm = fakeNpm({latest: ok('9.9.9')});
		for (const env of [{CI: 'true'}, {PIRL_NO_UPDATE_CHECK: '1'}, {NO_UPDATE_NOTIFIER: '1'}]) {
			expect(updateCheckDisabled(env)).toBe(true);
			expect(await checkForUpdate({file: updateCheckFile(tempDir('pirl-update-')), name: NAME, current: '1.0.1', exec: npm.exec, env})).toBeNull();
		}
		expect(npm.calls).toEqual([]);
		for (const env of [{CI: 'false'}, {CI: '0'}, {PIRL_NO_UPDATE_CHECK: ''}]) expect(updateCheckDisabled(env)).toBe(false);
	});
});

describe('pirl update', () => {
	/** A global npm folder holding an installed PIRL. */
	function globalInstall(version: string, framework: string) {
		const globalRoot = join(tempDir('pirl-global-'), 'node_modules');
		const root = join(globalRoot, NAME);
		mkdirSync(root, {recursive: true});
		const write = (v: string, fw: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({name: NAME, version: v, pirl: {frameworkVersion: fw}}));
		write(version, framework);
		return {globalRoot, root, write};
	}

	test('already the latest: says so and installs nothing', async () => {
		const {globalRoot, root} = globalInstall('1.0.1', '1.1.0');
		const lines: string[] = [];
		const ran: string[] = [];
		const code = await runUpdate({name: NAME, current: '1.0.1', root, log: line => lines.push(line), exec: fakeNpm({latest: ok('1.0.1'), root: ok(globalRoot)}).exec, run: async (c, a) => (ran.push([c, ...a].join(' ')), 0)});
		expect(code).toBe(0);
		expect(lines.at(-1)).toBe('Đang dùng bản mới nhất (1.0.1).');
		expect(ran).toEqual([]);
	});

	test('a newer release: installs that exact version, then reports it and its new framework', async () => {
		const {globalRoot, root, write} = globalInstall('1.0.1', '1.1.0');
		const lines: string[] = [];
		const ran: string[] = [];
		const checkFile = updateCheckFile(tempDir('pirl-update-'));
		const code = await runUpdate({
			name: NAME,
			current: '1.0.1',
			root,
			checkFile,
			log: line => lines.push(line),
			exec: fakeNpm({latest: ok('1.1.0'), root: ok(`${globalRoot}\n`)}).exec,
			run: async (command, args) => {
				ran.push([command, ...args].join(' '));
				write('1.1.0', '1.2.0');
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(ran).toEqual([`npm install -g ${NAME}@1.1.0`]);
		expect(JSON.parse(readFileSync(checkFile, 'utf8')).latest).toBe('1.1.0');
		expect(lines).toContain('Cập nhật 1.0.1 → 1.1.0…');
		expect(lines).toContain('Đã cập nhật lên 1.1.0.');
		expect(lines.at(-1)).toMatch(/framework mới \(fw-1\.2\.0\).*\/framework/);
	});

	test('the same framework: no word about /framework', async () => {
		const {globalRoot, root, write} = globalInstall('1.0.1', '1.1.0');
		const lines: string[] = [];
		await runUpdate({name: NAME, current: '1.0.1', root, log: line => lines.push(line), exec: fakeNpm({latest: ok('1.0.2'), root: ok(globalRoot)}).exec, run: async () => (write('1.0.2', '1.1.0'), 0)});
		expect(lines.at(-1)).toBe('Đã cập nhật lên 1.0.2.');
	});

	test('a copy run from its source is left alone, with the way to update it', async () => {
		const {globalRoot} = globalInstall('1.0.1', '1.1.0');
		const source = tempDir('pirl-source-');
		const lines: string[] = [];
		const ran: string[] = [];
		const code = await runUpdate({name: NAME, current: '1.0.1', root: source, log: line => lines.push(line), exec: fakeNpm({latest: ok('1.1.0'), root: ok(globalRoot)}).exec, run: async (c, a) => (ran.push([c, ...a].join(' ')), 0)});
		expect(code).toBe(1);
		expect(ran).toEqual([]);
		expect(lines.join('\n')).toMatch(/không phải bản cài bằng npm install -g[\s\S]*pnpm add -g[\s\S]*git pull rồi npm run setup/);
	});

	test('npm unreachable or the install failing: exit 1 with the command to run by hand', async () => {
		const {globalRoot, root} = globalInstall('1.0.1', '1.1.0');
		const lines: string[] = [];
		expect(await runUpdate({name: NAME, current: '1.0.1', root, log: line => lines.push(line), exec: fakeNpm({latest: failed}).exec})).toBe(1);
		expect(lines.at(-1)).toContain(`npm install -g ${NAME}`);
		lines.length = 0;
		const npm = fakeNpm({latest: ok('1.1.0'), root: ok(globalRoot)});
		expect(await runUpdate({name: NAME, current: '1.0.1', root, log: line => lines.push(line), exec: npm.exec, run: async () => 243, platform: 'linux'})).toBe(1);
		expect(lines.join('\n')).toContain(`sudo npm install -g ${NAME}@1.1.0`);
		lines.length = 0;
		expect(await runUpdate({name: NAME, current: '1.0.1', root, log: line => lines.push(line), exec: npm.exec, run: async () => 1, platform: 'win32'})).toBe(1);
		expect(lines.join('\n')).toMatch(/EPERM hoặc EBUSY: đóng các cửa sổ đang chạy pirl/);
		expect(lines.join('\n')).not.toContain('sudo');
	});
});
