import {describe, expect, test} from 'vitest';
import {createClipboard, osc52} from '../src/core/clipboard.js';
import type {Exec, ExecResult} from '../src/core/exec.js';

const ok = (stdout = ''): ExecResult => ({code: 0, stdout, stderr: ''});
const missing: ExecResult = {code: null, stdout: '', stderr: '', error: 'ENOENT'};

function recorder(answers: Record<string, ExecResult>) {
	const calls: Array<{command: string; args: string[]; input?: string}> = [];
	const exec: Exec = async (command, args, options) => {
		calls.push({command, args, input: options?.input});
		return answers[command] ?? missing;
	};
	return {exec, calls};
}

describe('clipboard', () => {
	test('Windows goes through PowerShell with a UTF-8 file, so Vietnamese survives', async () => {
		const {exec, calls} = recorder({powershell: ok('dòng một\r\ndòng hai\r\n')});
		const clipboard = createClipboard({exec, platform: 'win32', env: {}});
		expect(await clipboard.copy('Xin chào')).toBe('native');
		expect(calls[0]!.args.at(-1)).toMatch(/^Get-Content -Raw -Encoding UTF8 -LiteralPath '.+clip\.txt' \| Set-Clipboard$/);
		expect(await clipboard.paste()).toBe('dòng một\ndòng hai');
		expect(calls[1]!.args.at(-1)).toContain('[Console]::OutputEncoding=[Text.Encoding]::UTF8');
	});

	test('macOS uses pbcopy/pbpaste through stdin and stdout', async () => {
		const {exec, calls} = recorder({pbcopy: ok(), pbpaste: ok('dán')});
		const clipboard = createClipboard({exec, platform: 'darwin', env: {}});
		expect(await clipboard.copy('Xin chào')).toBe('native');
		expect(calls[0]).toMatchObject({command: 'pbcopy', input: 'Xin chào'});
		expect(await clipboard.paste()).toBe('dán');
	});

	test('Linux tries Wayland, then xclip, then xsel; without any, copy falls back to OSC 52', async () => {
		const {exec, calls} = recorder({xsel: ok()});
		expect(await createClipboard({exec, platform: 'linux', env: {WAYLAND_DISPLAY: 'wayland-0'}}).copy('x')).toBe('native');
		expect(calls.map(call => call.command)).toEqual(['wl-copy', 'xclip', 'xsel']);

		const written: string[] = [];
		const none = createClipboard({exec: recorder({}).exec, platform: 'linux', env: {}, writeTerminal: data => written.push(data)});
		expect(await none.copy('Xin chào')).toBe('terminal');
		expect(written).toEqual([osc52('Xin chào')]);
		expect(await none.paste()).toBeNull();
		expect(await createClipboard({exec: recorder({}).exec, platform: 'linux', env: {}}).copy('x')).toBe('failed');
	});

	test('OSC 52 carries UTF-8 as base64', () => {
		expect(osc52('Xin chào')).toBe(`\u001B]52;c;${Buffer.from('Xin chào').toString('base64')}\u0007`);
	});
});
