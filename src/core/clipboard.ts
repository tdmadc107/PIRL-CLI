import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from './exec.js';

/**
 * The system clipboard through the tools each platform ships. Text is passed as UTF-8 on every path,
 * so Vietnamese survives: on Windows through a temporary UTF-8 file and an explicit output encoding.
 */
export type Clipboard = {
	copy(text: string): Promise<'native' | 'terminal' | 'failed'>;
	paste(): Promise<string | null>;
};

type Tool = {command: string; args: string[]};

const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];

function tools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): {copy: Tool[]; paste: Tool[]; windows: boolean} {
	const windows = platform === 'win32' || Boolean(env['WSL_DISTRO_NAME']);
	if (windows) {
		const powershell = platform === 'win32' ? 'powershell' : 'powershell.exe';
		return {
			windows,
			copy: [{command: powershell, args: POWERSHELL_FLAGS}],
			paste: [{command: powershell, args: [...POWERSHELL_FLAGS, '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']}],
		};
	}
	if (platform === 'darwin') return {windows, copy: [{command: 'pbcopy', args: []}], paste: [{command: 'pbpaste', args: []}]};
	const wayland = env['WAYLAND_DISPLAY'] ? [{copy: {command: 'wl-copy', args: []}, paste: {command: 'wl-paste', args: ['--no-newline']}}] : [];
	const x11 = [
		{copy: {command: 'xclip', args: ['-selection', 'clipboard']}, paste: {command: 'xclip', args: ['-selection', 'clipboard', '-o']}},
		{copy: {command: 'xsel', args: ['--clipboard', '--input']}, paste: {command: 'xsel', args: ['--clipboard', '--output']}},
	];
	const all = [...wayland, ...x11];
	return {windows, copy: all.map(tool => tool.copy), paste: all.map(tool => tool.paste)};
}

/** OSC 52 asks the terminal itself to set the clipboard; Windows Terminal, iTerm2, kitty and others honor it. */
export const osc52 = (text: string) => `\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;

export function createClipboard(options: {
	exec?: Exec;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Writes raw bytes to the terminal, for the OSC 52 fallback. */
	writeTerminal?: (data: string) => void;
} = {}): Clipboard {
	const exec = options.exec ?? defaultExec;
	const env = options.env ?? process.env;
	const found = tools(options.platform ?? process.platform, env);
	const utf8Env = {...env, LANG: env['LANG'] || 'en_US.UTF-8', LC_CTYPE: env['LC_CTYPE'] || 'en_US.UTF-8'};
	return {
		async copy(text) {
			for (const tool of found.copy) {
				let result;
				if (found.windows) {
					const dir = mkdtempSync(join(tmpdir(), 'pirl-clip-'));
					const file = join(dir, 'clip.txt');
					try {
						writeFileSync(file, text, 'utf8');
						const quoted = file.replace(/'/g, "''");
						result = await exec(tool.command, [...tool.args, `Get-Content -Raw -Encoding UTF8 -LiteralPath '${quoted}' | Set-Clipboard`], {timeoutMs: 15_000});
					} finally {
						rmSync(dir, {recursive: true, force: true});
					}
				} else {
					result = await exec(tool.command, tool.args, {input: text, env: utf8Env, timeoutMs: 15_000});
				}
				if (succeeded(result)) return 'native';
			}
			if (options.writeTerminal) {
				options.writeTerminal(osc52(text));
				return 'terminal';
			}
			return 'failed';
		},
		async paste() {
			for (const tool of found.paste) {
				const result = await exec(tool.command, tool.args, {env: utf8Env, timeoutMs: 15_000});
				if (succeeded(result)) return found.windows ? result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '') : result.stdout;
			}
			return null;
		},
	};
}
