import {chmodSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, test} from 'vitest';
import {createClaudeRunner} from '../src/engine/claudeRunner.js';
import type {AgentRunRequest, RunEvent} from '../src/engine/types.js';
import {cleanupTemp, tempDir} from './helpers/hub.js';

const windows = process.platform === 'win32';
const leftovers: number[] = [];
afterEach(() => {
	for (const pid of leftovers.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
	cleanupTemp();
});

/**
 * A provider that ignores every polite stop: it reports a session, then keeps working. It stands where `claude` is,
 * behind a launcher like the real one: a `.cmd` shim on Windows (the child is cmd.exe, the provider runs under it),
 * a shell script elsewhere. `direct: false` keeps the shell in between on POSIX too.
 */
function fakeProvider(direct = true) {
	const dir = tempDir('pirl-fake-provider-');
	const pidFile = join(dir, 'pid');
	writeFileSync(
		join(dir, 'provider.mjs'),
		[
			"import {writeFileSync} from 'node:fs';",
			"process.on('SIGINT', () => {});",
			"process.on('SIGTERM', () => {});",
			`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			"process.stdout.write(JSON.stringify({type: 'system', subtype: 'init', session_id: 'fake-1'}) + '\\n');",
			'setInterval(() => {}, 1000);',
		].join('\n'),
	);
	let command: string;
	if (windows) {
		command = join(dir, 'claude.cmd');
		writeFileSync(command, `@"${process.execPath}" "${join(dir, 'provider.mjs')}" %*\r\n`);
	} else {
		command = join(dir, 'claude');
		writeFileSync(command, `#!/bin/sh\n${direct ? 'exec ' : ''}"${process.execPath}" "${join(dir, 'provider.mjs')}"\n`);
		chmodSync(command, 0o755);
	}
	return {command, pidFile, dir};
}

const request = (cwd: string): AgentRunRequest => ({cwd, addDirs: [], prompt: 'x', systemPrompt: 'y', agents: {}, permissions: {allow: [], deny: []}});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor<T>(read: () => T | null | undefined | false, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > end) throw new Error('timed out');
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

/** Starts the fake provider and waits until it has reported its session, so it is surely running. */
async function started(command: string, cwd: string, timings: {graceMs: number; settleMs: number}) {
	const events: RunEvent[] = [];
	const handle = createClaudeRunner(command, {timings}).start(request(cwd), event => events.push(event));
	await waitFor(() => events.some(event => event.type === 'session'));
	return handle;
}

const within = <T>(promise: Promise<T>, ms: number) =>
	Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms))]);

describe('stopping the provider process', () => {
	test('a provider that ignores the polite stop is ended, with everything it runs under the launcher', async () => {
		const fake = fakeProvider();
		const handle = await started(fake.command, fake.dir, {graceMs: 200, settleMs: 300});
		const pid = Number(await waitFor(() => existsSync(fake.pidFile) && readFileSync(fake.pidFile, 'utf8')));
		leftovers.push(pid);
		handle.stop();
		await within(handle.done, 15_000);
		await waitFor(() => !alive(pid), 10_000);
	}, 40_000);

	test('a second stop forces it at once, without waiting out the grace period', async () => {
		const fake = fakeProvider();
		const handle = await started(fake.command, fake.dir, {graceMs: 60_000, settleMs: 300});
		const pid = Number(await waitFor(() => existsSync(fake.pidFile) && readFileSync(fake.pidFile, 'utf8')));
		leftovers.push(pid);
		handle.stop();
		handle.stop();
		await within(handle.done, 10_000);
		await waitFor(() => !alive(pid), 10_000);
	}, 40_000);

	test.skipIf(windows)('the run ends even when a process left behind keeps the output open', async () => {
		// The shell stays between PIRL and the provider: killing the shell leaves the provider holding the pipes.
		const fake = fakeProvider(false);
		const handle = await started(fake.command, fake.dir, {graceMs: 100, settleMs: 200});
		leftovers.push(Number(await waitFor(() => existsSync(fake.pidFile) && readFileSync(fake.pidFile, 'utf8'))));
		handle.stop();
		await within(handle.done, 10_000);
	}, 40_000);
});
