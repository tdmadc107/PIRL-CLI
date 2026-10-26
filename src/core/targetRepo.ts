import {basename} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from './exec.js';
import {t} from './i18n.js';

export type TargetRepo =
	| {kind: 'git'; root: string; name: string; branch: string | null}
	| {kind: 'none'; cwd: string; reason: string};

/**
 * The target repository is the Git repository holding the directory where `pirl` was started.
 * From a subdirectory, its repository root is used. Outside any repository the TUI still opens,
 * but the layers stay locked.
 */
export async function detectTargetRepo(cwd: string, exec: Exec = defaultExec): Promise<TargetRepo> {
	const top = await exec('git', ['rev-parse', '--show-toplevel'], {cwd, timeoutMs: 10_000});
	if (top.error) return {kind: 'none', cwd, reason: t('Không tìm thấy Git', 'Git not found')};
	if (!succeeded(top)) return {kind: 'none', cwd, reason: t('Thư mục hiện tại không nằm trong git repo', 'The current folder is not in a git repository')};
	const root = top.stdout.trim();
	const head = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {cwd: root, timeoutMs: 10_000});
	let branch: string | null = succeeded(head) ? head.stdout.trim() : null;
	if (!branch) {
		const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, timeoutMs: 10_000});
		branch = succeeded(sha) ? `@${sha.stdout.trim()}` : null;
	}
	return {kind: 'git', root, name: basename(root), branch};
}
