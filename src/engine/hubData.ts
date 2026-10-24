import {existsSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';
import {parsePorcelain} from '../hub/hub.js';
import type {LayerKind} from './types.js';

/**
 * What the layers leave in the Hub, read for /plans, /records and the checks after a run.
 * Plan packages sit at the Hub root by default and records under .agents/evals/records/; both are ignored by
 * Git and never leave the user's machine. Each is matched to the current target repository by its target_repo.
 */
export const PLAN_SET = /^[a-z0-9]+(?:-[a-z0-9]+)*_\d{8}-\d{6}$/;
export const RECORDS_DIR = '.agents/evals/records';

const GIT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];

export function readFrontmatter(text: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const fields: Record<string, string> = {};
	for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
		const field = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (field) fields[field[1]!] = unquote(field[2]!.trim());
	}
	return fields;
}

/** A quoted value as the framework's validator reads it: backslashes kept, so Windows paths stay intact. */
function unquote(value: string): string {
	if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
	return value;
}

/** A target_repo value names the same repository as `target`: absolute, or relative to the Hub root. */
export function sameRepo(value: string | undefined, hub: string, target: string): boolean {
	if (!value) return false;
	const path = isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) ? value : join(hub, value);
	const a = resolve(path).replace(/[\\/]+$/, '');
	const b = resolve(target).replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export type PlanTask = {taskId: string; title: string; status: string; file: string};
export type ReviewReport = {taskId: string; round: number; verdict: string; file: string};
export type PlanPackage = {planSet: string; dir: string; createdAt: string; tasks: PlanTask[]; reports: ReviewReport[]};

const markdownFiles = (dir: string): string[] =>
	readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
		entry.isDirectory() ? markdownFiles(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : [],
	);

export function listPlanSets(hub: string): string[] {
	if (!existsSync(hub)) return [];
	return readdirSync(hub, {withFileTypes: true})
		.filter(entry => entry.isDirectory() && PLAN_SET.test(entry.name))
		.map(entry => entry.name);
}

/** Plan packages at the Hub root whose tasks target `target`, newest first. */
export function readPlanPackages(hub: string, target: string): PlanPackage[] {
	const packages: PlanPackage[] = [];
	for (const planSet of listPlanSets(hub)) {
		const dir = join(hub, planSet);
		const tasks: PlanTask[] = [];
		const reports: ReviewReport[] = [];
		let createdAt = '';
		let matches = false;
		for (const file of markdownFiles(dir)) {
			const fields = readFrontmatter(readFileSync(file, 'utf8'));
			if (fields['schema'] === 'pirl-plan/v1') {
				matches ||= sameRepo(fields['target_repo'], hub, target);
				createdAt ||= fields['created_at'] ?? '';
				tasks.push({taskId: fields['task_id'] ?? '?', title: fields['title'] ?? '', status: fields['status'] ?? '?', file});
			} else if (fields['schema'] === 'pirl-review/v1') {
				reports.push({taskId: fields['task_id'] ?? '?', round: Number(fields['review_round'] ?? 0), verdict: fields['verdict'] ?? '?', file});
			}
		}
		if (matches) {
			tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
			reports.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.round - b.round);
			packages.push({planSet, dir, createdAt, tasks, reports});
		}
	}
	return packages.sort((a, b) => b.planSet.slice(-15).localeCompare(a.planSet.slice(-15)));
}

export type RecordSummary = {recordId: string; layer: string; recordedAt: string; status: string; summary: string; planSet: string | null; fixes: number; pending: number};

/** Self-evaluation records whose target_repo is `target`, newest first. Unreadable lines are skipped. */
export function readRecords(hub: string, target: string | null): RecordSummary[] {
	const root = join(hub, RECORDS_DIR);
	if (!existsSync(root)) return [];
	const records: RecordSummary[] = [];
	for (const layer of readdirSync(root)) {
		const dir = join(root, layer);
		if (!statSync(dir).isDirectory()) continue;
		for (const file of readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
			for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
				if (!line.trim()) continue;
				try {
					const data = JSON.parse(line) as Record<string, any>;
					if (target && !sameRepo(data['target_repo'], hub, target)) continue;
					const fixes = Array.isArray(data['fixes']) ? data['fixes'] : [];
					records.push({
						recordId: String(data['record_id'] ?? ''),
						layer: String(data['layer'] ?? layer),
						recordedAt: String(data['recorded_at'] ?? ''),
						status: String(data['outcome']?.['status'] ?? ''),
						summary: String(data['outcome']?.['summary'] ?? ''),
						planSet: data['task']?.['plan_set'] ?? null,
						fixes: fixes.filter((fix: any) => fix?.status === 'applied').length,
						pending: fixes.filter((fix: any) => fix?.status === 'pending').length,
					});
				} catch {}
			}
		}
	}
	return records.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
}

export function countRecords(hub: string, layer: LayerKind): number {
	const dir = join(hub, RECORDS_DIR, layer);
	if (!existsSync(dir)) return 0;
	return readdirSync(dir)
		.filter(name => name.endsWith('.jsonl'))
		.reduce((sum, name) => sum + readFileSync(join(dir, name), 'utf8').split('\n').filter(line => line.trim()).length, 0);
}

/** Paths with uncommitted changes in a repository (the Hub, or the target after Implement). */
export async function changedPaths(repo: string, exec: Exec = defaultExec): Promise<string[]> {
	const result = await exec('git', [...GIT_FLAGS, 'status', '--porcelain', '-z', '--untracked-files=all'], {cwd: repo, timeoutMs: 30_000});
	return succeeded(result) ? parsePorcelain(result.stdout) : [];
}

/**
 * Commits framework improvements the user approved, with trailers that let /framework explain each change later.
 * Uses the user's Git identity, or a neutral one when none is configured.
 */
export async function commitImprovements(
	hub: string,
	files: string[],
	info: {kind: LayerKind | 'chat'; recordId: string | null; summary: string},
	exec: Exec = defaultExec,
): Promise<{ok: boolean; error?: string}> {
	const add = await exec('git', [...GIT_FLAGS, 'add', '--', ...files], {cwd: hub, timeoutMs: 30_000});
	if (!succeeded(add)) return {ok: false, error: add.stderr || add.error};
	const name = await exec('git', ['config', 'user.name'], {cwd: hub});
	const identity = succeeded(name) && name.stdout.trim() ? [] : ['-c', 'user.name=PIRL CLI user', '-c', 'user.email=pirl-cli@localhost'];
	const message = [
		`Framework improvement from a ${info.kind} run`,
		'',
		info.summary,
		'',
		...(info.recordId ? [`Pirl-Record: ${info.recordId}`] : []),
		'Pirl-Source: auditor',
	].join('\n');
	const commit = await exec('git', [...GIT_FLAGS, ...identity, 'commit', '--quiet', '-m', message, '--', ...files], {cwd: hub, timeoutMs: 30_000});
	return succeeded(commit) ? {ok: true} : {ok: false, error: commit.stderr || commit.error};
}

/** Throws away improvements the user rejected: tracked files go back to the last commit, new files are removed. */
export async function discardImprovements(hub: string, files: string[], exec: Exec = defaultExec): Promise<{ok: boolean; error?: string}> {
	const tracked: string[] = [];
	for (const file of files) {
		const known = await exec('git', ['ls-files', '--error-unmatch', '--', file], {cwd: hub});
		if (succeeded(known)) tracked.push(file);
		else rmSync(join(hub, file), {force: true});
	}
	if (tracked.length === 0) return {ok: true};
	const restore = await exec('git', [...GIT_FLAGS, 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], {cwd: hub, timeoutMs: 30_000});
	return succeeded(restore) ? {ok: true} : {ok: false, error: restore.stderr || restore.error};
}

/** Paths from the Plan's "Allowed paths" line, in backticks. A trailing slash or /** covers a whole directory. */
export function allowedPaths(planText: string): string[] {
	const line = planText.split('\n').find(text => /allowed paths:/i.test(text));
	return line ? [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]!.trim()).filter(Boolean) : [];
}

export function outsideAllowed(changed: string[], allowed: string[]): string[] {
	if (allowed.length === 0) return [];
	const normalized = allowed.map(path => path.replace(/\\/g, '/').replace(/\/\*\*$/, '/').replace(/^\.\//, ''));
	return changed.filter(file => {
		const path = file.replace(/\\/g, '/');
		return !normalized.some(allow => (allow.endsWith('/') ? path.startsWith(allow) : path === allow || path.startsWith(`${allow}/`)));
	});
}

export const relativeTo = (base: string, path: string) => relative(base, path) || '.';
