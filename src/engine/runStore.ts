import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {PersistedRun} from './run.js';

/**
 * The layer runs of each target repository, kept in ~/.pirl/sessions/<repo>/ so /resume can continue any of them
 * after the TUI was closed, the quota ran out or the network dropped. One file per run, named by its key; each holds
 * the provider session id, never a credential. The newest KEEP runs of a repository are kept.
 */
const KEEP = 20;

const repoKey = (target: string) => createHash('sha1').update(target).digest('hex').slice(0, 16);
const dirFor = (home: string, target: string) => join(home, 'sessions', repoKey(target));
const safeName = (key: string) => key.replace(/[^\w.-]/g, '_');

export function saveRun(home: string, target: string, run: PersistedRun): void {
	const dir = dirFor(home, target);
	mkdirSync(dir, {recursive: true});
	const file = join(dir, `${safeName(run.key)}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify({target, ...run}, null, 2), 'utf8');
	renameSync(`${file}.tmp`, file);
	prune(dir);
}

function prune(dir: string) {
	const files = readdirSync(dir)
		.filter(name => name.endsWith('.json'))
		.map(name => ({name, time: statSync(join(dir, name)).mtimeMs}))
		.sort((a, b) => b.time - a.time);
	for (const file of files.slice(KEEP)) rmSync(join(dir, file.name), {force: true});
}

/** The saved runs of `target`, newest first. */
export function listRuns(home: string, target: string): PersistedRun[] {
	const dir = dirFor(home, target);
	if (!existsSync(dir)) return [];
	const runs: Array<PersistedRun & {mtime: number}> = [];
	for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
		try {
			const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PersistedRun & {target?: string};
			if (data.target === target && data.kind && data.request) runs.push({...data, key: data.key ?? name.replace(/\.json$/, ''), mtime: statSync(join(dir, name)).mtimeMs});
		} catch {}
	}
	return runs
		.sort((a, b) => (Date.parse(b.savedAt ?? '') || b.mtime) - (Date.parse(a.savedAt ?? '') || a.mtime))
		.map(({mtime: _mtime, ...run}) => run);
}

/** A run /resume can continue: it was stopped, failed, or is waiting for answers, and has a provider session. */
export const resumable = (run: PersistedRun | null): run is PersistedRun =>
	!!run && !!run.sessionId && (run.status === 'stopped' || run.status === 'failed' || run.status === 'waiting' || run.status === 'running');
