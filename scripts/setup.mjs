#!/usr/bin/env node
// Installs or updates the `pirl` command from this checkout in one step:
// install dependencies, build and pack the package, install the package globally, remove the tarball.
// Run with `npm run setup`, after cloning and after every `git pull`.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm is a .cmd file on Windows, which Node only starts through a shell.
const shell = process.platform === 'win32';

function npm(args, cwd = root) {
	console.log(`\n> npm ${args.join(' ')}`);
	const result = spawnSync('npm', args, {cwd, stdio: 'inherit', shell});
	if (result.status !== 0) {
		console.error(`\nsetup: "npm ${args.join(' ')}" failed (exit ${result.status ?? result.error?.message}).`);
		process.exit(result.status ?? 1);
	}
}

const packDir = mkdtempSync(join(tmpdir(), 'pirl-setup-'));
try {
	npm(['install', '--no-audit', '--no-fund']);
	npm(['pack', '--pack-destination', packDir]);
	const tarball = readdirSync(packDir).find(name => name.endsWith('.tgz'));
	if (!tarball) throw new Error('npm pack produced no tarball');
	npm(['install', '--global', '--no-audit', '--no-fund', join(packDir, tarball)]);
	console.log('\nsetup: done. Run `pirl --version` to check, then `pirl` inside a project.');
} finally {
	rmSync(packDir, {recursive: true, force: true});
}
