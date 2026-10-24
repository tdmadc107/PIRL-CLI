import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** `~/.pirl` (`%USERPROFILE%\.pirl` on Windows). PIRL_HOME moves it, which tests use to stay off the real home. */
export function pirlHome(env: NodeJS.ProcessEnv = process.env): string {
	return env['PIRL_HOME'] || join(homedir(), '.pirl');
}

export const hubDir = (home: string) => join(home, 'hub');

/** Paths under the user's home are shown as `~/…`, which keeps them short and readable in the TUI. */
export function displayPath(path: string, home: string = homedir()): string {
	if (!home) return path;
	if (path === home) return '~';
	// Either separator: Windows accepts both, and paths reach here from Git and from the user's shell.
	return path.startsWith(home + sep) || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export const configFile = (home: string) => join(home, 'config.json');

/** The directory holding this package's package.json, found from the running file (src/ in dev, dist/ when built). */
export function packageRoot(from: string = fileURLToPath(import.meta.url)): string {
	let dir = dirname(from);
	while (!existsSync(join(dir, 'package.json'))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error('package.json of pirl-cli not found');
		dir = parent;
	}
	return dir;
}

export type PackageInfo = {name: string; version: string};

export function packageInfo(root: string = packageRoot()): PackageInfo {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageInfo;
	return {name: pkg.name, version: pkg.version};
}
