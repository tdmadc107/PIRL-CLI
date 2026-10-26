import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn as spawnPlain, spawnSync, type ChildProcess} from 'node:child_process';
import spawn from 'cross-spawn';
import {createStreamParser} from './claudeStream.js';
import type {AgentRunner, AgentRunRequest, RunEvent, RunHandle} from './types.js';

/**
 * The built-in tools a run gets: everything the coordinator and the roles use. Every tool's definition is sent
 * with every model request, and Claude Code's full set (with the user's MCP servers) is about 25k tokens of
 * context, while these come to about 7k. MCP tools would be refused by the run's permission rules anyway.
 */
export const RUN_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent'];

/**
 * Runs the coordinator with the user's own, unmodified Claude Code. The prompt goes through stdin and
 * the long arguments through files, so Vietnamese text and quotes survive Windows command lines.
 * Claude Code 2.1.281 or later reads `--agents` from a file.
 */
export function claudeArgs(request: AgentRunRequest, files: {systemPrompt: string; agents: string}): string[] {
	return [
		'-p',
		'--output-format',
		'stream-json',
		'--verbose',
		'--append-system-prompt-file',
		files.systemPrompt,
		'--agents',
		files.agents,
		'--tools',
		RUN_TOOLS.join(','),
		'--strict-mcp-config',
		// The framework's skills are plain files the coordinator reads; the user's own skills and commands are not loaded.
		'--disable-slash-commands',
		'--permission-mode',
		'dontAsk',
		'--permission-prompts',
		'none',
		'--allowedTools',
		request.permissions.allow.join(','),
		'--disallowedTools',
		request.permissions.deny.join(','),
		...request.addDirs.flatMap(dir => ['--add-dir', dir]),
		...(request.model ? ['--model', request.model] : []),
		...(request.effort ? ['--effort', request.effort] : []),
		...(request.resumeSessionId ? ['--resume', request.resumeSessionId] : []),
	];
}

/**
 * How long a stopping provider gets before the next, harder step: SIGINT ends the turn cleanly so the session can be
 * resumed, SIGTERM follows, then SIGKILL. Once the last step is sent the run ends after `settleMs` even if the
 * process never reports that it closed, so Esc always gives the TUI back.
 */
export type StopTimings = {graceMs: number; settleMs: number};
const STOP_TIMINGS: StopTimings = {graceMs: 3_000, settleMs: 2_000};

/**
 * Ends `child` and every process it started. On Windows there are no signals, and Claude Code installed by npm is a
 * `claude.cmd` shim: the child is cmd.exe and Claude Code runs under it. Killing the child alone leaves Claude Code
 * working with the output pipes still open, so the run would never end; `taskkill /T` ends the whole tree.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform, sync = false): void {
	if (child.pid === undefined) return;
	if (platform === 'win32') {
		const args = ['/pid', String(child.pid), '/T', '/F'];
		try {
			if (sync) spawnSync('taskkill', args, {stdio: 'ignore', windowsHide: true});
			else spawnPlain('taskkill', args, {stdio: 'ignore', windowsHide: true}).on('error', () => child.kill());
		} catch {
			child.kill();
		}
		return;
	}
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill(signal);
	} catch {}
}

/** Provider processes still running; ended when PIRL CLI exits so none keeps working unseen. */
const running = new Set<ChildProcess>();
process.once('exit', () => {
	for (const child of running) killTree(child, 'SIGTERM', process.platform, true);
});

export function createClaudeRunner(command = 'claude', options: {platform?: NodeJS.Platform; timings?: StopTimings} = {}): AgentRunner {
	const platform = options.platform ?? process.platform;
	const timings = options.timings ?? STOP_TIMINGS;
	return {
		start(request, onEvent): RunHandle {
			const dir = mkdtempSync(join(tmpdir(), 'pirl-run-'));
			const files = {systemPrompt: join(dir, 'host.md'), agents: join(dir, 'agents.json')};
			writeFileSync(files.systemPrompt, request.systemPrompt, 'utf8');
			writeFileSync(files.agents, JSON.stringify(request.agents), 'utf8');
			const child = spawn(command, claudeArgs(request, files), {
				cwd: request.cwd,
				// Background commands and subagents would keep the headless run open after its last turn.
				env: {...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'},
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
			const parseStreamLine = createStreamParser();
			running.add(child);
			let buffer = '';
			let stderr = '';
			const emit = (event: RunEvent) => {
				try {
					onEvent(event);
				} catch {}
			};
			child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf('\n');
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) for (const event of parseStreamLine(line)) emit(event);
					newline = buffer.indexOf('\n');
				}
			});
			child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
			child.stdin?.on('error', () => {});
			child.stdin?.end(request.prompt);
			let settle: (() => void) | null = null;
			const done = new Promise<{code: number | null; stderr: string}>(resolve => {
				let finished = false;
				const finish = (code: number | null, error?: string) => {
					if (finished) return;
					finished = true;
					running.delete(child);
					if (buffer.trim()) for (const event of parseStreamLine(buffer.trim())) emit(event);
					buffer = '';
					rmSync(dir, {recursive: true, force: true});
					resolve({code, stderr: error ?? stderr});
				};
				child.on('error', error => finish(null, error.message));
				child.on('close', code => finish(code));
				// A process that holds the pipes after it was killed (a grandchild, a hung shim) must not keep the run open.
				settle = () => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					finish(child.exitCode);
				};
			});
			const timers: NodeJS.Timeout[] = [];
			void done.then(() => timers.forEach(clearTimeout));
			const later = (ms: number, step: () => void) => timers.push(setTimeout(step, ms).unref());
			let stage = 0;
			/** The next step of stopping: the first call asks the provider to stop, each later one (a second Esc) forces it. */
			const escalate = (force: boolean) => {
				stage = force || platform === 'win32' ? 3 : stage + 1;
				if (stage === 3) {
					killTree(child, 'SIGKILL', platform);
					later(timings.settleMs, () => settle?.());
					return;
				}
				killTree(child, stage === 1 ? 'SIGINT' : 'SIGTERM', platform);
				later(timings.graceMs, () => stage < 3 && escalate(false));
			};
			return {
				done,
				stop() {
					if (stage < 3) escalate(stage > 0);
				},
			};
		},
	};
}
