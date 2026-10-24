#!/usr/bin/env node
// Copies the PIRL framework that ships with this CLI version into bundled-framework/files/
// and writes bundled-framework/manifest.json: the framework version and the Git blob hash of each file.
// The Hub compares those hashes with its `upstream` branch to tell whether a newer framework is bundled.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'pirl-framework');
const target = join(root, 'bundled-framework');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Inside a Git checkout, ship exactly the tracked framework files; otherwise (an unpacked source archive)
// ship every file except the outputs the framework's own .gitignore keeps on the user's machine.
function listFiles() {
	try {
		const out = execFileSync('git', ['ls-files', '-z', '--', '.'], {cwd: source, encoding: 'utf8'});
		const files = out.split('\0').filter(Boolean);
		if (files.length > 0) return files;
	} catch {}
	const skip = /(^|\/)(\.git|__pycache__|\.tmp|\.repos|\.tools)(\/|$)|^\.agents\/evals\/records\//;
	const walk = dir =>
		readdirSync(dir).flatMap(name => {
			const full = join(dir, name);
			const rel = relative(source, full).split(sep).join('/');
			if (skip.test(rel)) return [];
			return statSync(full).isDirectory() ? walk(full) : [rel];
		});
	return walk(source);
}

// npm leaves every file named .gitignore out of a published package, so it is stored under another name
// and the Hub puts it back (src/hub/framework.ts, storedPath). Without it the Hub would commit Plans and records.
const storedPath = path => path.replace(/(^|\/)\.gitignore$/, '$1gitignore.pirl-bundled');

const blobHash = content =>
	createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

if (!existsSync(source)) {
	console.error(`bundle-framework: ${source} not found`);
	process.exit(1);
}
rmSync(target, {recursive: true, force: true});
mkdirSync(join(target, 'files'), {recursive: true});
const files = {};
for (const file of listFiles().sort()) {
	const from = join(source, file);
	const to = join(target, 'files', storedPath(file));
	mkdirSync(dirname(to), {recursive: true});
	cpSync(from, to);
	files[file] = blobHash(readFileSync(from));
}
const digest = createHash('sha1')
	.update(Object.entries(files).map(([path, hash]) => `${hash} ${path}\n`).join(''))
	.digest('hex');
const manifest = {version: pkg.pirl.frameworkVersion, digest, files};
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`bundle-framework: ${Object.keys(files).length} files, version ${manifest.version}, digest ${digest.slice(0, 8)}`);
