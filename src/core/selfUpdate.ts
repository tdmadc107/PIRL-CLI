import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, isAbsolute} from 'node:path';
import spawn from 'cross-spawn';
import {exec as defaultExec, succeeded, type Exec} from './exec.js';

/**
 * Keeping PIRL itself up to date: `pirl update` installs the newest version from npm, and the TUI says when one
 * is out. Both ask npm (so the user's registry and proxy settings apply), and both only ever consider a plain
 * release version: npm's staged-publishing placeholder (`0.0.0-stage`) and pre-releases are never offered.
 */

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compares two release versions: negative when `a` is older, positive when newer, 0 when equal or not comparable. */
export function compareVersions(a: string, b: string): number {
	const left = RELEASE.exec(a);
	const right = RELEASE.exec(b);
	if (!left || !right) return 0;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(left[i]) - Number(right[i]);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The version npm's `latest` tag points to, or null when npm cannot tell or names something other than a release. */
export async function latestVersion(name: string, exec: Exec = defaultExec): Promise<string | null> {
	const result = await exec('npm', ['view', name, 'dist-tags.latest'], {timeoutMs: 20_000});
	if (!succeeded(result)) return null;
	// With `json=true` in the user's npm config, the version comes quoted.
	const version = result.stdout.trim().replace(/^"(.*)"$/, '$1');
	return RELEASE.test(version) ? version : null;
}

/** The last answer from npm, kept in `~/.pirl/update-check.json` so the TUI asks at most once a day. */
type UpdateCheck = {checkedAt: string; latest: string};

export const updateCheckFile = (home: string) => join(home, 'update-check.json');
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function readCheck(file: string): UpdateCheck | null {
	try {
		const data = JSON.parse(readFileSync(file, 'utf8')) as UpdateCheck;
		return typeof data.checkedAt === 'string' ? data : null;
	} catch {
		return null;
	}
}

function writeCheck(file: string, check: UpdateCheck) {
	try {
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(file, `${JSON.stringify(check)}\n`);
	} catch {
		// A check that cannot be saved is asked again next time.
	}
}

/** A variable that is set to something other than an empty string, `0` or `false`. */
const isOn = (value: string | undefined) => value !== undefined && !['', '0', 'false'].includes(value.trim().toLowerCase());

/** The checks are off in CI and when the user asks for it, with PIRL_NO_UPDATE_CHECK or NO_UPDATE_NOTIFIER. */
export const updateCheckDisabled = (env: NodeJS.ProcessEnv = process.env) => isOn(env['PIRL_NO_UPDATE_CHECK']) || isOn(env['NO_UPDATE_NOTIFIER']) || isOn(env['CI']);

/**
 * A newer release than `current`, or null. npm is asked at most once a day; in between, its last answer is used.
 * Never throws: an update check that fails is simply silent, and is not saved, so the next start asks again.
 */
export async function checkForUpdate(options: {
	file: string;
	name: string;
	current: string;
	exec?: Exec;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
	if (updateCheckDisabled(options.env)) return null;
	const now = options.now ?? Date.now;
	const saved = readCheck(options.file);
	// A check dated in the future (the clock was changed) counts as old.
	const age = saved ? now() - Date.parse(saved.checkedAt) : Number.NaN;
	const fresh = saved !== null && age >= 0 && age < CHECK_EVERY_MS;
	let latest = fresh ? saved.latest : null;
	if (!fresh) {
		latest = await latestVersion(options.name, options.exec).catch(() => null);
		if (latest) writeCheck(options.file, {checkedAt: new Date(now()).toISOString(), latest});
	}
	return latest && compareVersions(latest, options.current) > 0 ? latest : null;
}

/** Runs a program in the user's terminal, showing its output, and resolves to its exit code (null if it never started). */
export type RunInTerminal = (command: string, args: string[]) => Promise<number | null>;

const runInTerminal: RunInTerminal = (command, args) =>
	new Promise(resolve => {
		const child = spawn(command, args, {stdio: 'inherit'});
		child.on('error', () => resolve(null));
		child.on('close', code => resolve(code));
	});

/** Whether `dir` is inside `parent`, comparing real paths (a linked install resolves to its source); Windows ignores case. */
function inside(dir: string, parent: string): boolean {
	const real = (path: string) => {
		let resolved = path;
		try {
			resolved = realpathSync(path);
		} catch {
			// compare as given
		}
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	const rel = relative(real(parent), real(dir));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

type PackageJson = {version: string; pirl?: {frameworkVersion?: string}};
const readPackage = (root: string): PackageJson | null => {
	try {
		return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
	} catch {
		return null;
	}
};

/**
 * `pirl update`: installs the newest release with `npm install -g`. A copy run from its source (a clone, or a
 * linked install) is left alone, with the way to update it. Returns the process exit code.
 */
export async function runUpdate(options: {
	name: string;
	current: string;
	root: string;
	log?: (line: string) => void;
	exec?: Exec;
	run?: RunInTerminal;
	platform?: NodeJS.Platform;
}): Promise<number> {
	const log = options.log ?? (line => console.log(line));
	const exec = options.exec ?? defaultExec;
	const install = `npm install -g ${options.name}`;
	log(`Đang kiểm tra bản mới của ${options.name}…`);
	const latest = await latestVersion(options.name, exec);
	if (!latest) {
		log('Không lấy được bản mới nhất từ npm: mất mạng, hoặc npm vẫn đang xử lý một bản vừa đăng. Thử lại sau ít phút.');
		log(`Hoặc tự cập nhật: ${install}`);
		return 1;
	}
	if (compareVersions(latest, options.current) <= 0) {
		log(`Đang dùng bản mới nhất (${options.current}).`);
		return 0;
	}
	const globalRoot = await exec('npm', ['root', '-g'], {timeoutMs: 20_000});
	if (!succeeded(globalRoot) || !inside(options.root, globalRoot.stdout.trim())) {
		log(`Có bản mới ${latest} (đang dùng ${options.current}), nhưng PIRL này chạy từ ${options.root}, không phải bản cài bằng npm install -g.`);
		log('- Cài bằng pnpm, yarn hoặc bun: cập nhật bằng chính trình đó (ví dụ pnpm add -g pirl-framework-cli).');
		log('- Chạy từ mã nguồn: trong thư mục đó, chạy git pull rồi npm run setup.');
		return 1;
	}
	const framework = readPackage(options.root)?.pirl?.frameworkVersion ?? null;
	log(`Cập nhật ${options.current} → ${latest}…`);
	const code = await (options.run ?? runInTerminal)('npm', ['install', '-g', `${options.name}@${latest}`]);
	if (code !== 0) {
		log('Cập nhật không thành công; xem lỗi của npm ở trên.');
		if ((options.platform ?? process.platform) === 'win32') {
			log(`Nếu npm báo EPERM hoặc EBUSY: đóng các cửa sổ đang chạy pirl rồi chạy lại ${install}@${latest}. Vẫn lỗi quyền thì mở terminal bằng "Run as administrator".`);
		} else {
			log(`Nếu npm báo lỗi quyền (EACCES): sudo ${install}@${latest}`);
		}
		return 1;
	}
	// npm replaced the package in place, so its package.json is now the new one.
	const updated = readPackage(options.root);
	log(`Đã cập nhật lên ${updated?.version ?? latest}.`);
	const newFramework = updated?.pirl?.frameworkVersion;
	if (newFramework && newFramework !== framework) {
		log(`Bản này kèm framework mới (fw-${newFramework}). Mở pirl và vào /framework để cập nhật Hub khi bạn muốn.`);
	}
	return 0;
}
