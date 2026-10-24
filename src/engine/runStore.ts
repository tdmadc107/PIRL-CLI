import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {PersistedRun} from './run.js';

/**
 * The last run of each target repository, kept in ~/.pirl/sessions/ so /resume can continue it after the TUI
 * was closed, the quota ran out or the network dropped. It holds the provider session id, never a credential.
 */
const fileFor = (home: string, target: string) => join(home, 'sessions', `${createHash('sha1').update(target).digest('hex').slice(0, 16)}.json`);

export function saveRun(home: string, target: string, run: PersistedRun): void {
	const file = fileFor(home, target);
	mkdirSync(join(home, 'sessions'), {recursive: true});
	writeFileSync(`${file}.tmp`, JSON.stringify({target, ...run}, null, 2), 'utf8');
	renameSync(`${file}.tmp`, file);
}

export function loadRun(home: string, target: string): PersistedRun | null {
	try {
		const data = JSON.parse(readFileSync(fileFor(home, target), 'utf8')) as PersistedRun & {target?: string};
		return data.target === target && data.kind && data.request ? data : null;
	} catch {
		return null;
	}
}

export function clearRun(home: string, target: string): void {
	rmSync(fileFor(home, target), {force: true});
}

/** A run /resume can continue: it was stopped, failed, or is waiting for answers, and has a provider session. */
export const resumable = (run: PersistedRun | null): run is PersistedRun =>
	!!run && !!run.sessionId && (run.status === 'stopped' || run.status === 'failed' || run.status === 'waiting' || run.status === 'running');
