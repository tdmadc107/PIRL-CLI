import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageRoot} from '../../src/core/paths.js';
import {loadBundledFramework, storedPath, type BundledFramework} from '../../src/hub/framework.js';

export const bundle = loadBundledFramework(packageRoot());

/** A later framework version: the bundled files with some changed, as a CLI update would ship them. */
export function newerBundle(changes: Record<string, (text: string) => string>, version = '9.9.9', temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))): BundledFramework {
	const filesDir = join(temp('pirl-bundle-'), 'files');
	cpSync(bundle.filesDir, filesDir, {recursive: true});
	const files = {...bundle.manifest.files};
	for (const [path, change] of Object.entries(changes)) {
		const file = join(filesDir, storedPath(path));
		writeFileSync(file, change(readFileSync(file, 'utf8')));
		files[path] = execFileSync('git', ['hash-object', '--no-filters', file], {encoding: 'utf8'}).trim();
	}
	return {manifest: {version, digest: 'test', files}, filesDir};
}
