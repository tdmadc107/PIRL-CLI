import {succeeded, type Exec} from '../core/exec.js';
import {plural, t} from '../core/i18n.js';
import type {TargetRepo} from '../core/targetRepo.js';
import type {HubStatus} from '../hub/hub.js';
import type {Provider} from '../providers/types.js';

export type CheckState = 'ok' | 'warn' | 'fail';

export type Check = {
	id: 'node' | 'git' | 'python' | 'provider' | 'hub' | 'target';
	label: string;
	state: CheckState;
	detail: string;
	fix?: string;
};

export type PythonCommand = {command: string; args: string[]; version: string};

export type DoctorReport = {checks: Check[]; python: PythonCommand | null};

export const MIN_NODE_MAJOR = 22;
export const MIN_PYTHON: readonly [number, number] = [3, 9];

export function nodeCheck(version: string = process.versions.node): Check {
	const major = Number(version.split('.')[0]);
	return major >= MIN_NODE_MAJOR
		? {id: 'node', label: 'Node.js', state: 'ok', detail: `v${version}`}
		: {id: 'node', label: 'Node.js', state: 'fail', detail: `v${version}`, fix: t(`Cài Node.js ${MIN_NODE_MAJOR} trở lên.`, `Install Node.js ${MIN_NODE_MAJOR} or later.`)};
}

export async function gitCheck(exec: Exec): Promise<Check> {
	const result = await exec('git', ['--version'], {timeoutMs: 10_000});
	return succeeded(result)
		? {id: 'git', label: 'Git', state: 'ok', detail: result.stdout.trim().replace(/^git version\s*/, '')}
		: {id: 'git', label: 'Git', state: 'fail', detail: t('Không tìm thấy', 'Not found'), fix: t('Cài Git và đảm bảo lệnh `git` chạy được trong terminal.', 'Install Git and make sure the `git` command runs in a terminal.')};
}

/** The Windows `py` launcher comes first there; the Microsoft Store `python3` stub fails the version parse and is skipped. */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): Array<Omit<PythonCommand, 'version'>> {
	const plain = [
		{command: 'python3', args: []},
		{command: 'python', args: []},
	];
	return platform === 'win32' ? [{command: 'py', args: ['-3']}, ...plain.reverse()] : plain;
}

export function parsePythonVersion(output: string): [number, number, string] | null {
	const match = /Python (\d+)\.(\d+)(\.\d+)?/.exec(output);
	return match ? [Number(match[1]), Number(match[2]), `${match[1]}.${match[2]}${match[3] ?? ''}`] : null;
}

export async function findPython(exec: Exec, platform: NodeJS.Platform = process.platform): Promise<{check: Check; python: PythonCommand | null}> {
	let tooOld: string | null = null;
	for (const candidate of pythonCandidates(platform)) {
		const result = await exec(candidate.command, [...candidate.args, '--version'], {timeoutMs: 10_000});
		const parsed = succeeded(result) ? parsePythonVersion(result.stdout + result.stderr) : null;
		if (!parsed) continue;
		const [major, minor, version] = parsed;
		if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
			const python = {...candidate, version};
			return {python, check: {id: 'python', label: 'Python', state: 'ok', detail: `${version} (${[candidate.command, ...candidate.args].join(' ')})`}};
		}
		tooOld ??= version;
	}
	const need = `${MIN_PYTHON[0]}.${MIN_PYTHON[1]}`;
	return {
		python: null,
		check: {
			id: 'python',
			label: 'Python',
			state: 'fail',
			detail: tooOld ? t(`${tooOld} quá cũ`, `${tooOld} is too old`) : t('Không tìm thấy', 'Not found'),
			fix: t(`Cài Python ${need} trở lên; các công cụ của framework (validator, record) chạy bằng Python.`, `Install Python ${need} or later; the framework's tools (validator, record) run on Python.`),
		},
	};
}

export async function providerCheck(provider: Provider, exec: Exec): Promise<Check> {
	const base = {id: 'provider' as const, label: provider.label};
	if (!provider.available) return {...base, state: 'fail', detail: t('Chưa được hỗ trợ', 'Not supported yet'), fix: t('Chọn Claude Code trong /settings.', 'Choose Claude Code in /settings.')};
	const found = await provider.detect(exec);
	if (!found.installed) return {...base, state: 'fail', detail: t('Chưa cài', 'Not installed'), fix: found.fix};
	const version = found.version ? `${found.version} · ` : '';
	if (found.loggedIn === false) return {...base, state: 'fail', detail: version + t('chưa đăng nhập', 'not signed in'), fix: found.fix};
	if (found.outdated) return {...base, state: 'fail', detail: version + t('cần bản mới hơn', 'needs a newer version'), fix: found.fix};
	if (found.loggedIn === null) return {...base, state: 'warn', detail: version + t('không xác định được trạng thái đăng nhập', 'sign-in state unknown')};
	return {...base, state: 'ok', detail: version + (found.authMethod ? t(`đã đăng nhập bằng ${found.authMethod}`, `signed in with ${found.authMethod}`) : t('đã đăng nhập', 'signed in'))};
}

export function hubCheck(status: HubStatus | null, error: string | null): Check {
	const base = {id: 'hub' as const, label: 'Hub'};
	if (!status) return {...base, state: 'fail', detail: error ?? t('Chưa tạo được Hub', 'The Hub could not be created')};
	if (status.branch !== 'main') {
		return {...base, state: 'warn', detail: t(`Đang ở nhánh ${status.branch ?? '(không có)'}`, `On branch ${status.branch ?? '(none)'}`), fix: t(`Chuyển Hub (${status.path}) về nhánh main.`, `Switch the Hub (${status.path}) back to the main branch.`)};
	}
	const parts = [status.upstreamTag ?? t('không rõ phiên bản', 'unknown version'), t(`${status.localImprovements} cải tiến cục bộ`, `${status.localImprovements} local ${plural(status.localImprovements, 'improvement')}`)];
	if (status.uncommitted.length > 0) parts.push(t(`${status.uncommitted.length} thay đổi chưa commit`, `${status.uncommitted.length} uncommitted ${plural(status.uncommitted.length, 'change')}`));
	if (status.updateAvailable) parts.push(t(`có framework ${status.bundledVersion} mới`, `framework ${status.bundledVersion} available`));
	return {...base, state: status.uncommitted.length > 0 ? 'warn' : 'ok', detail: parts.join(' · ')};
}

export function targetCheck(target: TargetRepo): Check {
	return target.kind === 'git'
		? {id: 'target', label: 'Target repo', state: 'ok', detail: `${target.root}${target.branch ? ` (${target.branch})` : ''}`}
		: {id: 'target', label: 'Target repo', state: 'warn', detail: target.reason, fix: t('Mở `pirl` trong thư mục của một git repo để dùng các layer.', 'Open `pirl` in the folder of a git repository to use the layers.')};
}

export async function runDoctor(input: {
	exec: Exec;
	provider: Provider;
	target: TargetRepo;
	hub: HubStatus | null;
	hubError: string | null;
}): Promise<DoctorReport> {
	const [git, python, provider] = await Promise.all([gitCheck(input.exec), findPython(input.exec), providerCheck(input.provider, input.exec)]);
	return {
		checks: [nodeCheck(), git, python.check, provider, hubCheck(input.hub, input.hubError), targetCheck(input.target)],
		python: python.python,
	};
}
