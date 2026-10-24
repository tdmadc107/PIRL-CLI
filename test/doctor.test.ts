import {describe, expect, test} from 'vitest';
import type {Exec, ExecResult} from '../src/core/exec.js';
import {findPython, hubCheck, nodeCheck, providerCheck, pythonCandidates, targetCheck} from '../src/doctor/doctor.js';
import {claudeProvider, parseAuthStatus} from '../src/providers/claude.js';
import {PROVIDERS} from '../src/providers/index.js';

const ok = (stdout: string): ExecResult => ({code: 0, stdout, stderr: ''});
const missing: ExecResult = {code: null, stdout: '', stderr: '', error: 'spawn ENOENT'};

/** Answers by "command args"; anything not listed behaves like a missing program. */
const fakeExec =
	(answers: Record<string, ExecResult>): Exec =>
	async (command, args) =>
		answers[[command, ...args].join(' ')] ?? missing;

describe('python', () => {
	test('Windows tries the py launcher first', () => {
		expect(pythonCandidates('win32')[0]).toEqual({command: 'py', args: ['-3']});
		expect(pythonCandidates('linux')[0]).toEqual({command: 'python3', args: []});
	});

	test('skips a version that is too old and a stub that prints no version', async () => {
		const exec = fakeExec({
			'py -3 --version': {code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store'},
			'python --version': ok('Python 3.8.10'),
			'python3 --version': ok('Python 3.11.9'),
		});
		const {python, check} = await findPython(exec, 'win32');
		expect(python).toEqual({command: 'python3', args: [], version: '3.11.9'});
		expect(check.state).toBe('ok');
	});

	test('only an old Python is a failure that names the version found', async () => {
		const {python, check} = await findPython(fakeExec({'python3 --version': ok('Python 3.8.1')}), 'linux');
		expect(python).toBeNull();
		expect(check).toMatchObject({state: 'fail', detail: '3.8.1 quá cũ'});
	});
});

describe('claude provider', () => {
	test('reads sign-in state from `claude auth status --json`', () => {
		expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')).toEqual({
			loggedIn: true,
			authMethod: 'tài khoản Claude (subscription)',
		});
		expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"bedrock"}').authMethod).toBe('bedrock');
		expect(parseAuthStatus('{"loggedIn":false}')).toEqual({loggedIn: false, authMethod: undefined});
		expect(parseAuthStatus('not json')).toEqual({loggedIn: null});
	});

	test('signed in, signed out and not installed', async () => {
		const signedIn = fakeExec({'claude --version': ok('2.1.309 (Claude Code)\n'), 'claude auth status --json': ok('{"loggedIn":true,"authMethod":"oauth_token"}')});
		expect(await providerCheck(claudeProvider, signedIn)).toMatchObject({state: 'ok', detail: '2.1.309 · đã đăng nhập bằng tài khoản Claude (subscription)'});

		const signedOut = fakeExec({'claude --version': ok('2.1.309 (Claude Code)'), 'claude auth status --json': {code: 1, stdout: '{"loggedIn":false}', stderr: ''}});
		const out = await providerCheck(claudeProvider, signedOut);
		expect(out).toMatchObject({state: 'fail', detail: '2.1.309 · chưa đăng nhập'});
		expect(out.fix).toContain('claude auth login');

		expect(await providerCheck(claudeProvider, fakeExec({}))).toMatchObject({state: 'fail', detail: 'Chưa cài'});
	});

	test('providers without an adapter cannot pass the check', async () => {
		const codex = PROVIDERS.find(provider => provider.id === 'codex')!;
		expect(codex.available).toBe(false);
		expect(await providerCheck(codex, fakeExec({}))).toMatchObject({state: 'fail', detail: 'Chưa được hỗ trợ'});
	});
});

describe('other checks', () => {
	test('Node.js 22 or newer', () => {
		expect(nodeCheck('22.1.0').state).toBe('ok');
		expect(nodeCheck('20.18.0')).toMatchObject({state: 'fail', fix: 'Cài Node.js 22 trở lên.'});
	});

	test('Hub: errors, a branch other than main, and uncommitted changes', () => {
		const status = {path: '/h', upstreamTag: 'fw-1.0.0', localImprovements: 1, uncommitted: [], updateAvailable: true, bundledVersion: '1.1.0', branch: 'main'};
		expect(hubCheck(status, null)).toMatchObject({state: 'ok', detail: 'fw-1.0.0 · 1 cải tiến cục bộ · có framework 1.1.0 mới'});
		expect(hubCheck({...status, uncommitted: ['AGENTS.md']}, null).state).toBe('warn');
		expect(hubCheck({...status, branch: 'upstream'}, null)).toMatchObject({state: 'warn', detail: 'Đang ở nhánh upstream'});
		expect(hubCheck(null, 'boom')).toMatchObject({state: 'fail', detail: 'boom'});
	});

	test('target repo', () => {
		expect(targetCheck({kind: 'git', root: '/w/a', name: 'a', branch: 'main'})).toMatchObject({state: 'ok', detail: '/w/a (main)'});
		expect(targetCheck({kind: 'none', cwd: '/tmp', reason: 'x'}).state).toBe('warn');
	});
});
