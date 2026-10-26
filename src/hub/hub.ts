import {cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';
import {t} from '../core/i18n.js';
import {frameworkTag, storedPath, type BundledFramework} from './framework.js';

/**
 * The Hub is a local Git repository with no remote:
 * - `upstream` holds the framework versions as shipped (one commit and one `fw-<version>` tag per version);
 * - `main` is `upstream` plus the user's own improvements, and is the branch the layers run on.
 * A CLI update never writes here; only `/framework` brings a newer bundled version in (src/hub/update.ts).
 */
export const UPSTREAM = 'upstream';
export const MAIN = 'main';

/** Git settings for every Hub command: content stored byte for byte, and no signing prompt from the user's config. */
export const GIT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
/** Baseline commits on `upstream` are written by the tool, not by the user. */
export const TOOL_AUTHOR = ['-c', 'user.name=PIRL CLI', '-c', 'user.email=pirl-cli@localhost'];

export class HubError extends Error {}

export type HubStatus = {
	path: string;
	/** `fw-<version>` of the original framework merged into `main` last, or null when no tag is found. */
	upstreamTag: string | null;
	/** Commits on `main` that are not on `upstream`: the user's local improvements. */
	localImprovements: number;
	/** Paths with uncommitted changes in the Hub. */
	uncommitted: string[];
	/** The framework bundled with this CLI differs from `upstream`, or `upstream` is not merged into `main` yet. */
	updateAvailable: boolean;
	bundledVersion: string;
	/** Branch currently checked out; anything other than `main` is reported by /doctor. */
	branch: string | null;
};

export type EnsureHubResult = {created: boolean; status: HubStatus};

export async function git(exec: Exec, cwd: string, args: string[], extra: string[] = []) {
	const result = await exec('git', [...GIT_FLAGS, ...extra, ...args], {cwd, timeoutMs: 60_000});
	if (!succeeded(result)) {
		throw new HubError(`git ${args.join(' ')}: ${(result.error ?? result.stderr).trim() || `exit ${result.code}`}`);
	}
	return result.stdout;
}

async function isPirlHub(exec: Exec, path: string): Promise<boolean> {
	if (!existsSync(join(path, '.git'))) return false;
	const result = await exec('git', ['config', '--local', '--get', 'pirl.hub'], {cwd: path, timeoutMs: 10_000});
	return succeeded(result) && result.stdout.trim() === 'true';
}

/** Creates the Hub from the bundled framework on first use; never touches a directory that is not a PIRL Hub. */
export async function ensureHub(path: string, bundle: BundledFramework, exec: Exec = defaultExec): Promise<EnsureHubResult> {
	if (existsSync(path)) {
		if (!(await isPirlHub(exec, path))) {
			if (readdirSync(path).length > 0) {
				throw new HubError(t(`${path} đã tồn tại nhưng không phải Hub của PIRL CLI; CLI không thay đổi thư mục này.`, `${path} exists but is not a PIRL CLI Hub; the CLI leaves this folder unchanged.`));
			}
		} else {
			return {created: false, status: await hubStatus(path, bundle, exec)};
		}
	}
	// Build in a sibling directory and rename at the end, so an interrupted first run leaves no half-made Hub.
	mkdirSync(dirname(path), {recursive: true});
	const staging = `${path}.creating-${process.pid}`;
	rmSync(staging, {recursive: true, force: true});
	mkdirSync(staging, {recursive: true});
	try {
		await git(exec, staging, ['init', '--quiet']);
		await git(exec, staging, ['symbolic-ref', 'HEAD', `refs/heads/${UPSTREAM}`]);
		await git(exec, staging, ['config', 'core.autocrlf', 'false']);
		for (const file of Object.keys(bundle.manifest.files)) {
			const to = join(staging, file);
			mkdirSync(dirname(to), {recursive: true});
			cpSync(join(bundle.filesDir, storedPath(file)), to);
		}
		await git(exec, staging, ['add', '--all']);
		const tag = frameworkTag(bundle.manifest.version);
		await git(exec, staging, ['commit', '--quiet', '-m', `Framework ${tag}`], TOOL_AUTHOR);
		await git(exec, staging, ['tag', tag]);
		await git(exec, staging, ['branch', MAIN]);
		await git(exec, staging, ['checkout', '--quiet', MAIN]);
		// Marked last: a directory carries the marker only once it is a complete Hub.
		await git(exec, staging, ['config', 'pirl.hub', 'true']);
		if (existsSync(path)) rmSync(path, {recursive: true, force: true}); // only an empty directory reaches here
		renameSync(staging, path);
	} catch (error) {
		rmSync(staging, {recursive: true, force: true});
		throw error instanceof HubError ? error : new HubError(String(error));
	}
	return {created: true, status: await hubStatus(path, bundle, exec)};
}

export function parseLsTree(output: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of output.split('\0')) {
		const tab = entry.indexOf('\t');
		if (tab < 0) continue;
		const [, type, hash] = entry.slice(0, tab).split(' ');
		if (type === 'blob' && hash) files[entry.slice(tab + 1)] = hash;
	}
	return files;
}

/** `git status --porcelain -z`: "XY path" entries; a rename or copy is followed by its original path. */
export function parsePorcelain(output: string): string[] {
	const entries = output.split('\0');
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.length < 4) continue;
		paths.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') i++;
	}
	return paths;
}

export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export async function hubStatus(path: string, bundle: BundledFramework, exec: Exec = defaultExec): Promise<HubStatus> {
	// The original version in use is the latest one merged into `main`, not the newest one staged on `upstream`.
	const tagResult = await exec('git', ['describe', '--tags', '--abbrev=0', '--match', 'fw-*', MAIN], {cwd: path, timeoutMs: 10_000});
	const upstreamFiles = parseLsTree(await git(exec, path, ['ls-tree', '-r', '-z', UPSTREAM]));
	// Update merges are not improvements of the user's.
	const ahead = Number((await git(exec, path, ['rev-list', '--count', '--no-merges', `${UPSTREAM}..${MAIN}`])).trim());
	const uncommitted = parsePorcelain(await git(exec, path, ['status', '--porcelain', '-z']));
	const branchResult = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {cwd: path, timeoutMs: 10_000});
	// After an undone update, `upstream` already holds the newer version but `main` does not.
	const merged = succeeded(await exec('git', ['merge-base', '--is-ancestor', UPSTREAM, MAIN], {cwd: path, timeoutMs: 10_000}));
	return {
		path,
		upstreamTag: succeeded(tagResult) ? tagResult.stdout.trim() : null,
		localImprovements: Number.isFinite(ahead) ? ahead : 0,
		uncommitted,
		updateAvailable: !sameFiles(upstreamFiles, bundle.manifest.files) || !merged,
		bundledVersion: bundle.manifest.version,
		branch: succeeded(branchResult) ? branchResult.stdout.trim() : null,
	};
}
