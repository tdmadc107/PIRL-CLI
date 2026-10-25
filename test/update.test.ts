import {execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {ensureHub, hubStatus} from '../src/hub/hub.js';
import {
	draftDir,
	fileDiff,
	finishUpdate,
	improvementHistory,
	lastUpdate,
	localChanges,
	resolveConflict,
	restoreFile,
	startUpdate,
	undoUpdate,
} from '../src/hub/update.js';
import {bundle, newerBundle as makeNewer} from './helpers/bundle.js';
import {PYTHON, removeDir} from './helpers/hub.js';

const newerBundle = (changes: Record<string, (text: string) => string>) => makeNewer(changes, '9.9.9', () => tempDir());

const temporary: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'pirl-update-'));
	temporary.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temporary.splice(0)) removeDir(dir);
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {cwd, encoding: 'utf8'}).trim();

const ROLE = '.agents/roles/code-analyst.role.md';
const FORMAT = '.skills/pirl-plan/references/plan-format.md';

/** A Hub with one local improvement committed the way PIRL CLI commits them. */
async function hubWithImprovement(change: (text: string) => string = text => `${text}\n- Local rule.\n`) {
	const hub = join(tempDir(), 'hub');
	await ensureHub(hub, bundle);
	writeFileSync(join(hub, ROLE), change(readFileSync(join(hub, ROLE), 'utf8')));
	git(hub, 'commit', '-q', '-am', 'Framework improvement from a plan run\n\nPirl-Record: plan-1\nPirl-Source: auditor');
	return hub;
}

describe('local changes, history and restore', () => {
	test('lists what differs from the original, shows its diff and its commits, and restores a file', async () => {
		const hub = await hubWithImprovement();
		expect(await localChanges(hub)).toEqual([{path: ROLE, status: 'modified', added: 2, removed: 0}]);
		expect(await fileDiff(hub, ROLE)).toContain('+- Local rule.');
		expect(await improvementHistory(hub)).toEqual([expect.objectContaining({subject: 'Framework improvement from a plan run', record: 'plan-1', source: 'auditor'})]);
		await restoreFile(hub, ROLE);
		expect(await localChanges(hub)).toEqual([]);
		expect((await improvementHistory(hub))[0]).toMatchObject({subject: `Restore ${ROLE} to the original framework`, source: 'restore'});
	});

	test('nothing is rewritten while the Hub has uncommitted changes', async () => {
		const hub = await hubWithImprovement();
		appendFileSync(join(hub, FORMAT), 'draft\n');
		await expect(restoreFile(hub, ROLE)).rejects.toThrow(/chưa commit/);
		await expect(startUpdate(hub, newerBundle({[FORMAT]: text => `${text}x\n`}))).rejects.toThrow(/chưa commit/);
	});
});

describe('update', () => {
	test('a new version that touches other files merges on its own and keeps the local improvement', async () => {
		const hub = await hubWithImprovement();
		const before = git(hub, 'rev-parse', 'main');
		const newer = newerBundle({[FORMAT]: text => `${text}\nNew upstream line.\n`});
		expect((await hubStatus(hub, newer)).updateAvailable).toBe(true);
		const draft = await startUpdate(hub, newer);
		expect(draft.conflicts).toEqual([]);
		expect(draft.changed).toEqual([FORMAT]);
		expect(git(hub, 'rev-parse', 'main')).toBe(before); // main is untouched until the checks pass
		const result = await finishUpdate(hub, draft, PYTHON);
		expect(result).toEqual({ok: true, tag: 'fw-9.9.9', preTag: 'pre-update/fw-9.9.9'});
		expect(readFileSync(join(hub, FORMAT), 'utf8')).toContain('New upstream line.');
		expect(readFileSync(join(hub, ROLE), 'utf8')).toContain('- Local rule.');
		expect(git(hub, 'rev-parse', 'pre-update/fw-9.9.9')).toBe(before);
		expect(git(hub, 'describe', '--tags', '--exact-match', 'upstream')).toBe('fw-9.9.9');
		expect(existsSync(draftDir(hub))).toBe(false);
		expect(git(hub, 'branch', '--list', 'pirl-update')).toBe('');
		expect(await hubStatus(hub, newer)).toMatchObject({updateAvailable: false, upstreamTag: 'fw-9.9.9', uncommitted: []});
	});

	test('a conflict waits for the user: the versions and the improvement behind it are shown, the choice is applied', async () => {
		const hub = await hubWithImprovement(text => text.replace('# code-analyst', '# code-analyst (local)'));
		const newer = newerBundle({[ROLE]: text => text.replace('# code-analyst', '# code-analyst (upstream)')});
		const draft = await startUpdate(hub, newer);
		expect(draft.conflicts).toHaveLength(1);
		const [conflict] = draft.conflicts;
		expect(conflict).toMatchObject({path: ROLE});
		expect(conflict!.base).toContain('# code-analyst\n');
		expect(conflict!.mine).toContain('# code-analyst (local)');
		expect(conflict!.theirs).toContain('# code-analyst (upstream)');
		expect(conflict!.myCommits).toEqual([expect.objectContaining({record: 'plan-1'})]);
		await expect(resolveConflict(draft.dir, ROLE, {content: '<<<<<<< ours\nx\n>>>>>>> theirs\n'})).rejects.toThrow(/dấu xung đột/);
		await expect(finishUpdate(hub, draft, PYTHON)).resolves.toMatchObject({ok: false, error: expect.stringContaining('chưa giải quyết')});
		await resolveConflict(draft.dir, ROLE, 'mine');
		expect(await finishUpdate(hub, draft, PYTHON)).toMatchObject({ok: true});
		expect(readFileSync(join(hub, ROLE), 'utf8')).toContain('# code-analyst (local)');
	});

	test('a merge that breaks the framework\'s tests is dropped and main stays as it was', async () => {
		const hub = await hubWithImprovement();
		const before = git(hub, 'rev-parse', 'main');
		const draft = await startUpdate(hub, newerBundle({[FORMAT]: text => `${text}\nSee [nothing](missing-file.md).\n`}));
		const result = await finishUpdate(hub, draft, PYTHON);
		expect(result).toMatchObject({ok: false, error: expect.stringContaining('Test của framework')});
		expect(git(hub, 'rev-parse', 'main')).toBe(before);
		expect(git(hub, 'status', '--porcelain')).toBe('');
		expect(existsSync(draftDir(hub))).toBe(false);
	});

	test('the last update can be undone; the newer version stays offered', async () => {
		const hub = await hubWithImprovement();
		const before = git(hub, 'rev-parse', 'main');
		const newer = newerBundle({[FORMAT]: text => `${text}\nNew upstream line.\n`});
		await finishUpdate(hub, await startUpdate(hub, newer), PYTHON);
		const last = await lastUpdate(hub);
		expect(last).toMatchObject({tag: 'pre-update/fw-9.9.9', version: 'fw-9.9.9'});
		expect(last!.commits[0]!.subject).toBe('Update framework to fw-9.9.9');
		await undoUpdate(hub, last!.tag);
		expect(git(hub, 'rev-parse', 'main')).toBe(before);
		expect(await lastUpdate(hub)).toBeNull();
		expect((await hubStatus(hub, newer)).updateAvailable).toBe(true);
		// Updating again reuses the version already on upstream.
		expect(await finishUpdate(hub, await startUpdate(hub, newer), PYTHON)).toMatchObject({ok: true});
	}, 90_000);
});
