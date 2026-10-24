import {costUsd} from '../../src/engine/pricing.js';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageRoot} from '../../src/core/paths.js';
import type {AgentRunner, RunEvent} from '../../src/engine/types.js';
import {loadBundledFramework} from '../../src/hub/framework.js';
import {ensureHub} from '../../src/hub/hub.js';

export const PYTHON = {command: process.platform === 'win32' ? 'python' : 'python3', args: [] as string[]};

const temporary: string[] = [];
export function tempDir(prefix = 'pirl-engine-') {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temporary.push(dir);
	return dir;
}
export function cleanupTemp() {
	for (const dir of temporary.splice(0)) rmSync(dir, {recursive: true, force: true});
}

export const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'}).trim();

/** A real Hub built from the bundled framework, and a target repository with one commit. */
export async function hubAndTarget() {
	const home = tempDir();
	const hub = join(home, 'hub');
	await ensureHub(hub, loadBundledFramework(packageRoot()));
	const target = tempDir('pirl-target-');
	git(target, 'init', '--quiet');
	writeFileSync(join(target, 'README.md'), '# Shop\n');
	git(target, 'add', '.');
	git(target, 'commit', '--quiet', '-m', 'init');
	return {home, hub, target};
}

export const py = (hub: string, ...args: string[]) =>
	JSON.parse(execFileSync(PYTHON.command, ['-B', ...args], {cwd: hub, encoding: 'utf8'})) as Record<string, any>;

/** Creates a valid one-task Plan package with the framework's own script, as the coordinator would. */
export function writePlan(hub: string, target: string): {planSet: string; planFile: string} {
	const created = py(hub, '.skills/pirl-plan/scripts/new_plan.py', '--request-slug', 'order-email', '--todo-slug', 'send-email');
	const planFile = join(hub, created['path']);
	let text = readFileSync(planFile, 'utf8');
	for (const [placeholder, value] of [
		['[<planning-role>]', '[code-analyst]'],
		['[<implementation-role>]', '[backend-developer]'],
		['[<verification-role>]', '[code-reviewer]'],
	] as const) {
		text = text.replace(placeholder, value);
	}
	text = text.replace(/^target_repo: ".*"$/m, `target_repo: "${target.replace(/\\/g, '/')}"`);
	text = text.replace(/^- Allowed paths: .*$/m, '- Allowed paths: `src/`, `README.md`.');
	writeFileSync(planFile, text);
	return {planSet: join(hub, created['plan_set']), planFile};
}

/** Appends a clean Plan record through layer_record.py, as process-auditor would. */
export function writeRecord(hub: string, target: string, planSet: string, layer: 'plan' | 'implement' = 'plan'): string {
	const start = py(hub, '.agents/evals/layer_record.py', 'start');
	const payload = {
		layer,
		framework_ref: start['framework_ref'],
		task: {plan_set: planSet.split(/[\\/]/).pop(), task_ids: ['T01']},
		target_repo: target,
		outcome: {status: layer === 'plan' ? 'ready' : 'implemented', summary: 'Plan cho email huỷ đơn'},
		roles: [{role: layer === 'plan' ? 'code-analyst' : 'backend-developer', mode: 'agent', assignment: 'Trace cancelOrder', result: 'PASS'}],
		audit: {role: 'process-auditor', mode: 'agent', result: 'clean'},
		issues: [],
		fixes: [],
		evaluates: null,
		supersedes: null,
	};
	const file = join(tempDir(), 'record.json');
	writeFileSync(file, JSON.stringify(payload));
	return py(hub, '.agents/evals/layer_record.py', 'append', '--input', file)['record_id'];
}

export type FakeCall = {prompt: string; cwd: string; model?: string; resumeSessionId?: string; allow: string[]; deny: string[]; addDirs: string[]};

/**
 * A provider stand-in: each call runs the next script, which may change files like the real coordinator would,
 * and returns the events to emit. Records every call so tests can check prompts, resumes and permissions.
 */
export type FakeScript = (call: FakeCall, emit: (event: RunEvent) => void) => RunEvent[] | Promise<RunEvent[]>;

export function fakeRunner(scripts: FakeScript[]) {
	const calls: FakeCall[] = [];
	const runner: AgentRunner = {
		start(request, onEvent) {
			const call: FakeCall = {
				prompt: request.prompt,
				cwd: request.cwd,
				model: request.model,
				resumeSessionId: request.resumeSessionId,
				allow: request.permissions.allow,
				deny: request.permissions.deny,
				addDirs: request.addDirs,
			};
			calls.push(call);
			const script = scripts[calls.length - 1];
			let stop: () => void = () => {};
			const done = new Promise<{code: number | null; stderr: string}>(resolve => {
				stop = () => resolve({code: 130, stderr: ''});
				void Promise.resolve(script ? script(call, onEvent) : [])
					.then(events => {
						for (const event of events) onEvent(event);
						resolve({code: 0, stderr: ''});
					})
					.catch(error => resolve({code: 1, stderr: String(error)}));
			});
			return {done, stop: () => stop()};
		},
	};
	return {runner, calls};
}

export const result = (text: string, sessionId = 'session-1'): RunEvent => ({
	type: 'result',
	text,
	isError: false,
	sessionId,
});

/** One model request: 10k of context, 9k of it from the cache, and 200 tokens out. */
export const usage = (model = 'claude-sonnet-5-5'): RunEvent => {
	const tokens = {inputTokens: 0, cacheWriteTokens: 1000, cacheReadTokens: 9000, outputTokens: 200};
	return {type: 'usage', model, request: true, costUsd: costUsd(model, tokens), ...tokens};
};

export const outputsBlock = (outputs: Record<string, string | null>) => '\n```pirl-result\n' + JSON.stringify(outputs) + '\n```';
