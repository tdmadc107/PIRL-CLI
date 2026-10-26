import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {t} from '../core/i18n.js';

/** Written by scripts/bundle-framework.mjs: the framework version shipped with this CLI and each file's Git blob hash. */
export type FrameworkManifest = {
	version: string;
	digest: string;
	files: Record<string, string>;
};

export type BundledFramework = {
	manifest: FrameworkManifest;
	/** Directory holding the framework files; read each one through `storedPath`. */
	filesDir: string;
};

/** Where a framework file is stored inside the package; mirrors `storedPath` in scripts/bundle-framework.mjs. */
export const storedPath = (path: string) => path.replace(/(^|\/)\.gitignore$/, '$1gitignore.pirl-bundled');

export function loadBundledFramework(packageRoot: string): BundledFramework {
	const dir = join(packageRoot, 'bundled-framework');
	const manifestPath = join(dir, 'manifest.json');
	if (!existsSync(manifestPath)) {
		throw new Error(t(`Thiếu ${manifestPath}. Chạy \`npm run bundle-framework\` trước.`, `${manifestPath} is missing. Run \`npm run bundle-framework\` first.`));
	}
	return {manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as FrameworkManifest, filesDir: join(dir, 'files')};
}

export const frameworkTag = (version: string) => `fw-${version}`;
