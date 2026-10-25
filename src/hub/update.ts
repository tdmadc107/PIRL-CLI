import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';
import {frameworkTag, storedPath, type BundledFramework} from './framework.js';
import {GIT_FLAGS, git, HubError, MAIN, parseLsTree, parsePorcelain, sameFiles, TOOL_AUTHOR, UPSTREAM} from './hub.js';

/**
 * What `/framework` does to the Hub (proposal section 9). `main` is never left half-updated: an update is merged in a
 * draft worktree on its own branch, checked with the framework's tests there, and only then fast-forwarded onto
 * `main`, with a `pre-update/<version>` tag on the old position so it can be undone.
 */
export const DRAFT_BRANCH = 'pirl-update';
const PRE_UPDATE = 'pre-update/';
/** Where the draft worktree lives: next to the Hub, never inside it. */
export const draftDir = (hub: string) => `${hub}-update`;

const run = (exec: Exec, cwd: string, args: string[], extra: string[] = []) => exec('git', [...GIT_FLAGS, ...extra, ...args], {cwd, timeoutMs: 60_000});

/** The Hub must be on `main` with nothing uncommitted before anything here rewrites its files. */
export async function assertClean(hub: string, exec: Exec = defaultExec): Promise<void> {
	const branch = (await git(exec, hub, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
	if (branch !== MAIN) throw new HubError(`Hub đang ở nhánh ${branch}, không phải ${MAIN}.`);
	const dirty = parsePorcelain(await git(exec, hub, ['status', '--porcelain', '-z']));
	if (dirty.length > 0) throw new HubError(`Hub có ${dirty.length} file chưa commit: ${dirty.slice(0, 5).join(', ')}. Commit hoặc bỏ chúng trước.`);
}

// ---------- local changes, history, restore ----------

export type LocalChange = {path: string; status: 'modified' | 'added' | 'deleted'; added: number; removed: number};

/** Framework files on `main` that differ from the original on `upstream`: the user's local improvements. */
export async function localChanges(hub: string, exec: Exec = defaultExec): Promise<LocalChange[]> {
	const names = (await git(exec, hub, ['diff', '--name-status', '-z', '--no-renames', UPSTREAM, MAIN])).split('\0');
	const stats = (await git(exec, hub, ['diff', '--numstat', '-z', '--no-renames', UPSTREAM, MAIN])).split('\0');
	const counts = new Map<string, {added: number; removed: number}>();
	for (const entry of stats) {
		const [added, removed, path] = entry.split('\t');
		if (path) counts.set(path, {added: Number(added) || 0, removed: Number(removed) || 0});
	}
	const changes: LocalChange[] = [];
	for (let i = 0; i + 1 < names.length; i += 2) {
		const code = names[i]!;
		const path = names[i + 1]!;
		if (!code || !path) continue;
		changes.push({path, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', ...(counts.get(path) ?? {added: 0, removed: 0})});
	}
	return changes;
}

/** The unified diff of one file, from the original framework to the Hub's version. */
export async function fileDiff(hub: string, path: string, exec: Exec = defaultExec): Promise<string> {
	return git(exec, hub, ['diff', '--no-color', '--no-renames', UPSTREAM, MAIN, '--', path]);
}

export type HistoryEntry = {hash: string; date: string; subject: string; record: string | null; source: string | null};

/**
 * Commits on `main` that are not on `upstream`, newest first: improvements, restores and update merges.
 * With `path`, only the commits that changed that file.
 */
export async function improvementHistory(hub: string, exec: Exec = defaultExec, range = `${UPSTREAM}..${MAIN}`, path?: string): Promise<HistoryEntry[]> {
	const format = '%H%x1f%cI%x1f%s%x1f%(trailers:key=Pirl-Record,valueonly,separator=%x2c)%x1f%(trailers:key=Pirl-Source,valueonly,separator=%x2c)%x1e';
	const output = await git(exec, hub, ['log', ...(path ? [] : ['--first-parent']), `--format=${format}`, range, ...(path ? ['--', path] : [])]);
	return output
		.split('\x1e')
		.map(entry => entry.trim())
		.filter(Boolean)
		.map(entry => {
			const [hash = '', date = '', subject = '', record = '', source = ''] = entry.split('\x1f');
			return {hash, date, subject, record: record.trim() || null, source: source.trim() || null};
		});
}

/** One commit on `main` that puts a file back as the original framework has it (or removes a file the original lacks). */
export async function restoreFile(hub: string, path: string, exec: Exec = defaultExec): Promise<void> {
	await assertClean(hub, exec);
	const inUpstream = succeeded(await run(exec, hub, ['cat-file', '-e', `${UPSTREAM}:${path}`]));
	if (inUpstream) await git(exec, hub, ['checkout', UPSTREAM, '--', path]);
	else await git(exec, hub, ['rm', '--quiet', '--', path]);
	const message = [`Restore ${path} to the original framework`, '', 'Pirl-Source: restore'].join('\n');
	await git(exec, hub, ['commit', '--quiet', '-m', message, '--', path], await identity(hub, exec));
}

/** The user's Git identity when it is set; otherwise a local one, so a commit never stops on a missing name. */
async function identity(hub: string, exec: Exec): Promise<string[]> {
	const name = await exec('git', ['config', 'user.name'], {cwd: hub, timeoutMs: 10_000});
	const email = await exec('git', ['config', 'user.email'], {cwd: hub, timeoutMs: 10_000});
	return succeeded(name) && name.stdout.trim() && succeeded(email) && email.stdout.trim() ? [] : ['-c', 'user.name=PIRL CLI user', '-c', 'user.email=pirl-cli@localhost'];
}

// ---------- undo ----------

export type LastUpdate = {tag: string; version: string; /** Commits on `main` since that update, its merge included. */ commits: HistoryEntry[]};

/** The latest update that can be undone: a `pre-update/*` tag whose commit is still part of `main`. */
export async function lastUpdate(hub: string, exec: Exec = defaultExec): Promise<LastUpdate | null> {
	const tags = (await git(exec, hub, ['tag', '--list', `${PRE_UPDATE}*`, '--sort=-creatordate'])).split('\n').map(tag => tag.trim()).filter(Boolean);
	for (const tag of tags) {
		if (!succeeded(await run(exec, hub, ['merge-base', '--is-ancestor', tag, MAIN]))) continue;
		const commits = await improvementHistory(hub, exec, `${tag}..${MAIN}`);
		if (commits.length === 0) continue;
		return {tag, version: tag.slice(PRE_UPDATE.length).replace(/-\d+$/, ''), commits};
	}
	return null;
}

/** Puts `main` back where it was before the update; every commit made since then goes too, as the user confirmed. */
export async function undoUpdate(hub: string, tag: string, exec: Exec = defaultExec): Promise<void> {
	await assertClean(hub, exec);
	await git(exec, hub, ['reset', '--hard', '--quiet', tag]);
	await git(exec, hub, ['tag', '--delete', tag]);
}

// ---------- update ----------

/** Puts the bundled framework on `upstream` as a new commit and tag; nothing changes when it is already there. */
export async function stageBundle(hub: string, bundle: BundledFramework, exec: Exec = defaultExec): Promise<string> {
	const tag = frameworkTag(bundle.manifest.version);
	const upstreamTree = await git(exec, hub, ['ls-tree', '-r', '-z', UPSTREAM]);
	if (sameFiles(parseLsTree(upstreamTree), bundle.manifest.files)) return tag;
	const modes = new Map<string, string>();
	for (const entry of upstreamTree.split('\0')) {
		const tab = entry.indexOf('\t');
		if (tab > 0) modes.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[0]!);
	}
	// A private index builds the new tree without touching the Hub's index or working tree.
	const scratch = mkdtempSync(join(tmpdir(), 'pirl-index-'));
	const env = {...process.env, GIT_INDEX_FILE: join(scratch, 'index')};
	try {
		const lines: string[] = [];
		for (const [path, expected] of Object.entries(bundle.manifest.files)) {
			const stored = await exec('git', ['hash-object', '-w', '--no-filters', join(bundle.filesDir, storedPath(path))], {cwd: hub, timeoutMs: 30_000});
			const hash = stored.stdout.trim();
			if (!succeeded(stored) || hash !== expected) throw new HubError(`Framework đi kèm CLI bị hỏng ở ${path}: mã băm không khớp manifest.`);
			lines.push(`${modes.get(path) ?? '100644'} ${hash}\t${path}`);
		}
		const index = await exec('git', ['update-index', '--add', '--index-info'], {cwd: hub, env, input: `${lines.join('\n')}\n`, timeoutMs: 60_000});
		if (!succeeded(index)) throw new HubError(`git update-index: ${index.stderr.trim()}`);
		const tree = await exec('git', ['write-tree'], {cwd: hub, env, timeoutMs: 30_000});
		if (!succeeded(tree)) throw new HubError(`git write-tree: ${tree.stderr.trim()}`);
		const parent = (await git(exec, hub, ['rev-parse', UPSTREAM])).trim();
		const commit = (await git(exec, hub, ['commit-tree', tree.stdout.trim(), '-p', parent, '-m', `Framework ${tag}`], TOOL_AUTHOR)).trim();
		await git(exec, hub, ['update-ref', `refs/heads/${UPSTREAM}`, commit, parent]);
		await git(exec, hub, ['tag', '--force', tag, commit]);
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
	return tag;
}

export type Conflict = {
	path: string;
	/** The file in the original version both sides started from, the user's version and the new original; null when absent. */
	base: string | null;
	mine: string | null;
	theirs: string | null;
	/** The user's commits that changed this file, with the record each came from. */
	myCommits: HistoryEntry[];
};

export type Draft = {dir: string; tag: string; changed: string[]; conflicts: Conflict[]};

/** Removes a draft left by an update that did not finish. */
export async function removeDraft(hub: string, exec: Exec = defaultExec): Promise<void> {
	const dir = draftDir(hub);
	await run(exec, hub, ['worktree', 'remove', '--force', dir]);
	rmSync(dir, {recursive: true, force: true});
	await run(exec, hub, ['worktree', 'prune']);
	await run(exec, hub, ['branch', '-D', DRAFT_BRANCH]);
}

const show = async (exec: Exec, cwd: string, spec: string) => {
	const result = await run(exec, cwd, ['show', spec]);
	return succeeded(result) ? result.stdout : null;
};

/** Merges the bundled framework into a draft of `main`; conflicts wait in the draft for the user's choices. */
export async function startUpdate(hub: string, bundle: BundledFramework, exec: Exec = defaultExec): Promise<Draft> {
	await assertClean(hub, exec);
	const tag = await stageBundle(hub, bundle, exec);
	await removeDraft(hub, exec);
	const dir = draftDir(hub);
	await git(exec, hub, ['worktree', 'add', '--quiet', '-b', DRAFT_BRANCH, dir, MAIN]);
	const changed = (await git(exec, hub, ['diff', '--name-only', '--no-renames', `${MAIN}...${UPSTREAM}`])).split('\n').filter(Boolean);
	const merge = await run(exec, dir, ['merge', '--no-ff', '--no-commit', UPSTREAM], [...TOOL_AUTHOR, '-c', 'merge.conflictStyle=diff3']);
	const unmerged = (await git(exec, dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
	if (!succeeded(merge) && unmerged.length === 0) {
		await removeDraft(hub, exec);
		throw new HubError(`git merge: ${(merge.stderr || merge.stdout).trim()}`);
	}
	const conflicts: Conflict[] = [];
	for (const path of unmerged) {
		conflicts.push({
			path,
			base: await show(exec, dir, `:1:${path}`),
			mine: await show(exec, dir, `:2:${path}`),
			theirs: await show(exec, dir, `:3:${path}`),
			myCommits: await improvementHistory(hub, exec, `${UPSTREAM}..${MAIN}`, path),
		});
	}
	return {dir, tag, changed, conflicts};
}

export const hasConflictMarkers = (text: string) => /^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)( |$)/m.test(text);

/** Settles one conflict in the draft: the user's version, the new original, or given content (null removes the file). */
export async function resolveConflict(dir: string, path: string, choice: 'mine' | 'theirs' | {content: string | null}, exec: Exec = defaultExec): Promise<void> {
	if (choice === 'mine' || choice === 'theirs') {
		const present = succeeded(await run(exec, dir, ['cat-file', '-e', `:${choice === 'mine' ? 2 : 3}:${path}`]));
		if (present) {
			await git(exec, dir, ['checkout', `--${choice === 'mine' ? 'ours' : 'theirs'}`, '--', path]);
			await git(exec, dir, ['add', '--', path]);
		} else {
			await git(exec, dir, ['rm', '--quiet', '--', path]);
		}
		return;
	}
	if (choice.content === null) {
		await git(exec, dir, ['rm', '--quiet', '--force', '--', path]);
		return;
	}
	if (hasConflictMarkers(choice.content)) throw new HubError(`${path} vẫn còn dấu xung đột (<<<<<<<, >>>>>>>).`);
	writeFileSync(join(dir, path), choice.content, 'utf8');
	await git(exec, dir, ['add', '--', path]);
}

/** Paths still unmerged in the draft. */
export async function unresolved(dir: string, exec: Exec = defaultExec): Promise<string[]> {
	return (await git(exec, dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

export type FinishResult = {ok: true; tag: string; preTag: string} | {ok: false; error: string; output?: string};

/**
 * Checks the merged draft with the framework's own tests, then moves `main` onto it and tags the old position.
 * On any failure the draft is dropped and `main` is left exactly as it was.
 */
export async function finishUpdate(
	hub: string,
	draft: Pick<Draft, 'dir' | 'tag'>,
	python: {command: string; args: string[]} | null,
	exec: Exec = defaultExec,
): Promise<FinishResult> {
	const fail = async (error: string, output?: string): Promise<FinishResult> => {
		await removeDraft(hub, exec);
		return {ok: false, error, output};
	};
	try {
		const left = await unresolved(draft.dir, exec);
		if (left.length > 0) return {ok: false, error: `Còn ${left.length} xung đột chưa giải quyết: ${left.join(', ')}.`};
		if (!python) return {ok: false, error: 'Không tìm thấy Python để chạy test của framework; cập nhật chưa được áp dụng.'};
		const tests = await exec(python.command, [...python.args, '-B', '-m', 'unittest', 'discover', '-s', '.agents/evals/tests', '-p', 'test_*.py'], {cwd: draft.dir, timeoutMs: 300_000});
		if (!succeeded(tests)) return fail('Test của framework không qua trên bản nháp; Hub giữ nguyên.', `${tests.stderr}\n${tests.stdout}`.trim());
		const message = [`Update framework to ${draft.tag}`, '', 'Pirl-Source: update'].join('\n');
		await git(exec, draft.dir, ['commit', '--quiet', '--no-verify', '-m', message], TOOL_AUTHOR);
		await assertClean(hub, exec);
		let preTag = `${PRE_UPDATE}${draft.tag}`;
		for (let n = 2; succeeded(await run(exec, hub, ['rev-parse', '--verify', '--quiet', `refs/tags/${preTag}`])); n++) preTag = `${PRE_UPDATE}${draft.tag}-${n}`;
		await git(exec, hub, ['tag', preTag, MAIN]);
		await git(exec, hub, ['merge', '--ff-only', '--quiet', DRAFT_BRANCH]);
		await removeDraft(hub, exec);
		return {ok: true, tag: draft.tag, preTag};
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}


/** A unified diff between two texts (null is an absent file), for showing what each side of a conflict changed. */
export async function textDiff(from: string | null, to: string | null, exec: Exec = defaultExec): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'pirl-diff-'));
	try {
		writeFileSync(join(dir, 'a'), from ?? '', 'utf8');
		writeFileSync(join(dir, 'b'), to ?? '', 'utf8');
		// Exit code 1 means the texts differ; the diff is still on stdout.
		const result = await exec('git', ['diff', '--no-index', '--no-color', 'a', 'b'], {cwd: dir, timeoutMs: 30_000});
		return result.stdout;
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}

/** Commits changes the user made to the Hub by hand, before an update or a restore needs a clean Hub. */
export async function commitUncommitted(hub: string, files: string[], exec: Exec = defaultExec): Promise<void> {
	await git(exec, hub, ['add', '--all', '--', ...files]);
	const message = ['Manual framework change', '', 'Pirl-Source: manual'].join('\n');
	await git(exec, hub, ['commit', '--quiet', '-m', message, '--', ...files], await identity(hub, exec));
}
