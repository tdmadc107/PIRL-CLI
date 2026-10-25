import {closeSync, openSync, readdirSync, readFileSync, readSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep, win32} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';

/**
 * Files and folders the user attaches to a request by writing `@path` (or `@"path with spaces"`).
 * The TUI offers paths from an index of the target repository while `@` is typed; on submit each mention that
 * names an existing path becomes context sent with the request: a text file's content, a folder's file list.
 */

/** One path of the index: relative to its base, with `/` separators. */
export type PathEntry = {path: string; folder: boolean};

/** Directories never listed: version control, dependencies and caches, which a repository's .gitignore usually leaves out. */
const SKIPPED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.next', '.turbo', '.cache']);

/** Most entries an index or a folder listing walks; a bigger tree is cut there. */
export const WALK_LIMIT = 20_000;

/** Files under `dir` (relative, `/` separators) by walking it, skipping SKIPPED, up to `limit` files. */
function walk(dir: string, limit: number): string[] {
	const files: string[] = [];
	const pending = [''];
	while (pending.length > 0 && files.length < limit) {
		const current = pending.shift()!;
		let names;
		try {
			names = readdirSync(join(dir, current), {withFileTypes: true});
		} catch {
			continue;
		}
		names.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of names) {
			const path = current ? `${current}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED.has(entry.name)) pending.push(path);
			} else if (entry.isFile()) {
				files.push(path);
				if (files.length >= limit) break;
			}
		}
	}
	return files;
}

/** Files of `dir`: those Git tracks or would track (so .gitignore applies) inside a repository, else a walk. */
async function filesOf(dir: string, exec: Exec): Promise<string[]> {
	const listed = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: dir, timeoutMs: 20_000});
	if (succeeded(listed)) return listed.stdout.split('\0').filter(Boolean).slice(0, WALK_LIMIT);
	return walk(dir, WALK_LIMIT);
}

/** The files under `base` and every folder holding them, for completing `@` mentions. */
export async function pathIndex(base: string, exec: Exec = defaultExec): Promise<PathEntry[]> {
	const files = await filesOf(base, exec);
	const folders = new Set<string>();
	for (const file of files) {
		for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at));
	}
	return [...[...folders].map(path => ({path, folder: true})), ...files.map(path => ({path, folder: false}))];
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Paths for a mention being typed, best first. Nothing typed lists the top level; `folder/` lists that folder,
 * itself first so Enter can attach it. Otherwise: paths starting with the text, then names starting with it,
 * then names and paths containing it; folders first, shorter paths first.
 */
export function suggestPaths(index: PathEntry[], query: string, limit = 50): PathEntry[] {
	const typed = query.toLowerCase().replace(/\\/g, '/');
	const byOrder = (a: PathEntry, b: PathEntry) => Number(b.folder) - Number(a.folder) || a.path.length - b.path.length || a.path.localeCompare(b.path);
	if (typed === '' || typed.endsWith('/')) {
		const parent = typed.replace(/\/$/, '');
		const self = index.find(entry => entry.folder && entry.path.toLowerCase() === parent);
		const children = index.filter(entry => {
			const path = entry.path.toLowerCase();
			if (parent && !path.startsWith(`${parent}/`)) return false;
			return !path.slice(parent ? parent.length + 1 : 0).includes('/');
		});
		return [...(self ? [self] : []), ...children.sort(byOrder)].slice(0, limit);
	}
	const rank = (entry: PathEntry) => {
		const path = entry.path.toLowerCase();
		const name = basename(path);
		if (path.startsWith(typed)) return 0;
		if (name.startsWith(typed)) return 1;
		if (name.includes(typed)) return 2;
		if (path.includes(typed)) return 3;
		return -1;
	};
	return index
		.map(entry => ({entry, score: rank(entry)}))
		.filter(item => item.score >= 0)
		.sort((a, b) => a.score - b.score || byOrder(a.entry, b.entry))
		.slice(0, limit)
		.map(item => item.entry);
}

/** How a path is written after `@`: quoted when it has spaces; a folder ends with `/`. */
export const mentionText = (entry: PathEntry) => {
	const path = entry.folder ? `${entry.path}/` : entry.path;
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
};

/** Every `@path` and `@"path"` in the text, written after a space or at the start (so an e-mail address is not one). */
export function findMentions(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/(^|\s)@(?:"([^"]+)"|([^\s"]+))/g)) found.push(match[2] ?? match[3]!);
	return found;
}

export type Attachment = {
	/** As the user wrote it. */
	mention: string;
	/** Absolute path. */
	path: string;
	/** Path shown to the user: relative to the base when inside it. */
	display: string;
	kind: 'file' | 'folder';
	size: number;
};

/**
 * The share or device a Windows path starts with (`\\host\share\`, `\\?\C:\`, `\\.\pipe\`), or null for a
 * local path. Windows takes any two separators at the start as one, so `//host/share` and `/\host\share` count too.
 * Elsewhere `//tmp/x` is an ordinary local path and `\` an ordinary character: null.
 */
export function remoteRoot(path: string, platform: NodeJS.Platform = process.platform): string | null {
	if (platform !== 'win32' || !/^[\\/]{2}/.test(path)) return null;
	return win32.parse(win32.normalize(path)).root.toLowerCase();
}

/**
 * The path a mention names, if it exists: `~/` is the home directory; a relative path is read from `base`, then from `cwd`.
 * On Windows a path on a network share or a device is never looked at unless the base, the start directory or the
 * home directory is on that same share: merely reading it would connect to the host (SMB, or WebDAV for
 * `\\host@80\x`) and send it the user's NTLM credentials, and a mention can come from pasted text.
 */
function locate(mention: string, base: string, cwd: string, platform: NodeJS.Platform): {path: string; kind: 'file' | 'folder'; size: number} | null {
	const candidates = mention.startsWith('~/') || mention === '~' ? [join(homedir(), mention.slice(1))] : isAbsolute(mention) ? [resolve(mention)] : [resolve(base, mention), resolve(cwd, mention)];
	const trusted = [base, cwd, homedir()].map(dir => remoteRoot(dir, platform)).filter((root): root is string => root !== null);
	const untrusted = (path: string) => {
		const root = remoteRoot(path, platform);
		return root !== null && !trusted.includes(root);
	};
	// The mention as written and each path it resolves to: either one naming a share is enough to skip it.
	if (untrusted(mention)) return null;
	for (const candidate of candidates) {
		if (untrusted(candidate)) continue;
		try {
			const stat = statSync(candidate);
			if (stat.isDirectory()) return {path: candidate, kind: 'folder', size: 0};
			if (stat.isFile()) return {path: candidate, kind: 'file', size: stat.size};
		} catch {
			// not this one
		}
	}
	return null;
}

/**
 * The mentions of the text that name an existing file or folder, once each. A mention followed by punctuation
 * ("xem @src/a.ts, rồi…") still names the path without it. Mentions that name nothing stay plain text.
 */
export function resolveMentions(text: string, base: string, cwd: string = base, platform: NodeJS.Platform = process.platform): Attachment[] {
	const attachments: Attachment[] = [];
	const seen = new Set<string>();
	for (const mention of findMentions(text)) {
		const trimmed = mention.replace(/[.,;:!?)\]}'"]+$/, '');
		const found = locate(mention, base, cwd, platform) ?? (trimmed && trimmed !== mention ? locate(trimmed, base, cwd, platform) : null);
		if (!found || seen.has(found.path)) continue;
		seen.add(found.path);
		const inside = relative(base, found.path);
		const display = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : found.path;
		attachments.push({mention, path: found.path, display: found.kind === 'folder' ? `${display.replace(/\/$/, '')}/` : display, kind: found.kind, size: found.size});
	}
	return attachments;
}

/** A file's content goes with the request up to this size; a bigger one is sent as its path, for the agent to read. */
export const FILE_LIMIT = 100_000;
/** All included contents together stay under this; files past it are sent as paths. */
export const TOTAL_LIMIT = 300_000;
/** Files a folder lists with its path; a bigger folder says how many more it holds. */
export const FOLDER_LIMIT = 300;

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Text files only: a NUL byte in the first 8 KB marks a binary file (an image, a PDF, an archive). */
function isBinary(path: string): boolean {
	const buffer = Buffer.alloc(8192);
	let fd: number | null = null;
	try {
		fd = openSync(path, 'r');
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, read).includes(0);
	} catch {
		return true;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** A Markdown fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
	return '`'.repeat(longest + 1);
}

export type AttachedContext = {
	/** Appended to the request sent to the provider; empty when nothing is attached. */
	text: string;
	/** Attached folders outside the Hub and the target, which the provider's tools need to reach (Read reaches any file). */
	dirs: string[];
	/** One line per attachment for the user: what was sent and how. */
	summary: Array<{display: string; detail: string; tone?: 'warning'}>;
};

/** The request's context from its attachments: contents of text files within the limits, paths for the rest, file lists of folders. */
export async function attachmentContext(attachments: Attachment[], roots: string[], exec: Exec = defaultExec): Promise<AttachedContext> {
	if (attachments.length === 0) return {text: '', dirs: [], summary: []};
	const inside = (path: string) => roots.some(root => {
		const rel = relative(root, path);
		return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
	});
	const dirs = new Set<string>();
	const summary: AttachedContext['summary'] = [];
	const parts = [
		'# Attached by the user',
		'',
		'The user attached these paths with `@` in the request above. They are part of the request: read what bears on the task in full, and give the relevant paths to every role you delegate to, since roles do not see this message.',
	];
	let total = 0;
	for (const item of attachments) {
		if (item.kind === 'folder' && !inside(item.path)) dirs.add(item.path);
		if (item.kind === 'folder') {
			const files = await filesOf(item.path, exec);
			const shown = files.slice(0, FOLDER_LIMIT);
			parts.push('', `## Folder: ${item.display} (${item.path}, ${files.length >= WALK_LIMIT ? `${WALK_LIMIT}+` : files.length} files)`, '');
			parts.push(...shown.map(file => `- ${file}`));
			if (files.length > shown.length) parts.push(`- … and ${files.length - shown.length} more; list them with Glob.`);
			summary.push({display: item.display, detail: `thư mục, ${files.length} file: gửi danh sách file`});
			continue;
		}
		const heading = `## File: ${item.display} (${item.path}, ${formatSize(item.size)})`;
		if (isBinary(item.path)) {
			parts.push('', heading, '', 'Not text (an image, a PDF or another binary file): read it with Read if it bears on the task.');
			summary.push({display: item.display, detail: `${formatSize(item.size)}, không phải văn bản: gửi đường dẫn`});
			continue;
		}
		if (item.size > FILE_LIMIT || total + item.size > TOTAL_LIMIT) {
			parts.push('', heading, '', 'Too large to include here: read it with Read, in parts where needed.');
			summary.push({display: item.display, detail: `${formatSize(item.size)}, quá lớn để gửi kèm: gửi đường dẫn`, tone: 'warning'});
			continue;
		}
		const content = readFileSync(item.path, 'utf8');
		total += item.size;
		const marks = fence(content);
		const name = basename(item.display);
		parts.push('', heading, '', `${marks}${name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''}`, content.replace(/\n$/, ''), marks);
		summary.push({display: item.display, detail: `${formatSize(item.size)}: gửi kèm nội dung`});
	}
	return {text: parts.join('\n'), dirs: [...dirs], summary};
}
