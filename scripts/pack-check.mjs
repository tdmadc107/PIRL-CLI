#!/usr/bin/env node
// Checks the package exactly as npm would publish it: what the tarball holds, then that it installs on its own
// (outside this checkout, so no local .npmrc or node_modules helps) and that `pirl --version` and `--help` run.
// Run with `npm run pack:check` before publishing; CI runs it on every platform.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', shell, ...options});
	if (result.status !== 0) {
		console.error(`pack-check: "${command} ${args.join(' ')}" failed (exit ${result.status ?? result.error?.message})\n${result.stderr ?? ''}`);
		process.exit(1);
	}
	return result.stdout;
}

const fail = message => {
	console.error(`pack-check: ${message}`);
	process.exit(1);
};

const work = mkdtempSync(join(tmpdir(), 'pirl-pack-check-'));
try {
	run('npm', ['pack', '--pack-destination', work, '--silent']);
	const tarball = readdirSync(work).find(name => name.endsWith('.tgz'));
	if (!tarball) fail('npm pack produced no tarball');

	const listing = run('tar', ['-tzf', join(work, tarball)], {shell: false})
		.split('\n')
		.map(line => line.trim().replace(/^package\//, ''))
		.filter(Boolean);
	const required = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/bin/pirl.js', 'dist/bin/main.js', 'bundled-framework/manifest.json'];
	for (const file of required) if (!listing.includes(file)) fail(`the package lacks ${file}`);
	const forbidden = [/^src\//, /^test\//, /^scripts\//, /^docs\//, /^pirl-framework\//, /\.map$/, /\.tgz$/, /node_modules\//, /\.tmp\//, /evals\/records\//, /__pycache__/, /(^|\/)\.gitignore$/];
	for (const file of listing) {
		const rule = forbidden.find(pattern => pattern.test(file));
		if (rule) fail(`the package must not contain ${file} (${rule})`);
	}
	const manifest = JSON.parse(readFileSync(join(root, 'bundled-framework', 'manifest.json'), 'utf8'));
	const bundled = listing.filter(file => file.startsWith('bundled-framework/files/'));
	if (bundled.length !== Object.keys(manifest.files).length) fail(`the package holds ${bundled.length} framework files, the manifest lists ${Object.keys(manifest.files).length}`);
	if (manifest.version !== pkg.pirl.frameworkVersion) fail(`bundled framework ${manifest.version} differs from package.json pirl.frameworkVersion ${pkg.pirl.frameworkVersion}`);

	const prefix = join(work, 'prefix');
	run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(work, tarball)], {cwd: work});
	const bin = shell ? join(prefix, 'pirl.cmd') : join(prefix, 'bin', 'pirl');
	if (!existsSync(bin)) fail(`installing the package made no ${bin}`);
	const version = run(bin, ['--version'], {cwd: work}).trim();
	const expected = `pirl ${pkg.version} (framework fw-${manifest.version})`;
	if (version !== expected) fail(`pirl --version printed "${version}", expected "${expected}"`);
	if (!run(bin, ['--help'], {cwd: work}).includes('pirl --version')) fail('pirl --help does not print the usage');

	console.log(`pack-check: ${tarball}: ${listing.length} files; installs and runs (${version}).`);
} finally {
	rmSync(work, {recursive: true, force: true});
}
