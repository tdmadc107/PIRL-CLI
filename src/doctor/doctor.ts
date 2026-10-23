import {succeeded, type Exec} from '../core/exec.js';
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
		: {id: 'node', label: 'Node.js', state: 'fail', detail: `v${version}`, fix: `Cài Node.js ${MIN_NODE_MAJOR} trở lên.`};
}

export async function gitCheck(exec: Exec): Promise<Check> {
	const result = await exec('git', ['--version'], {timeoutMs: 10_000});
	return succeeded(result)
		? {id: 'git', label: 'Git', state: 'ok', detail: result.stdout.trim().replace(/^git version\s*/, '')}
		: {id: 'git', label: 'Git', state: 'fail', detail: 'Không tìm thấy', fix: 'Cài Git và đảm bảo lệnh `git` chạy được trong terminal.'};
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
			detail: tooOld ? `${tooOld} quá cũ` : 'Không tìm thấy',
			fix: `Cài Python ${need} trở lên; các công cụ của framework (validator, record) chạy bằng Python.`,
		},
	};
}

export async function providerCheck(provider: Provider, exec: Exec): Promise<Check> {
	const base = {id: 'provider' as const, label: provider.label};
	if (!provider.available) return {...base, state: 'fail', detail: 'Chưa được hỗ trợ', fix: 'Chọn Claude Code trong /settings.'};
	const found = await provider.detect(exec);
	if (!found.installed) return {...base, state: 'fail', detail: 'Chưa cài', fix: found.fix};
	const version = found.version ? `${found.version} · ` : '';
	if (found.loggedIn === false) return {...base, state: 'fail', detail: `${version}chưa đăng nhập`, fix: found.fix};
	if (found.loggedIn === null) return {...base, state: 'warn', detail: `${version}không xác định được trạng thái đăng nhập`};
	return {...base, state: 'ok', detail: `${version}đã đăng nhập${found.authMethod ? ` bằng ${found.authMethod}` : ''}`};
}

export function hubCheck(status: HubStatus | null, error: string | null): Check {
	const base = {id: 'hub' as const, label: 'Hub'};
	if (!status) return {...base, state: 'fail', detail: error ?? 'Chưa tạo được Hub'};
	if (status.branch !== 'main') {
		return {...base, state: 'warn', detail: `Đang ở nhánh ${status.branch ?? '(không có)'}`, fix: `Chuyển Hub (${status.path}) về nhánh main.`};
	}
	const parts = [status.upstreamTag ?? 'không rõ phiên bản', `${status.localImprovements} cải tiến cục bộ`];
	if (status.uncommitted.length > 0) parts.push(`${status.uncommitted.length} thay đổi chưa commit`);
	if (status.updateAvailable) parts.push(`có framework ${status.bundledVersion} mới`);
	return {...base, state: status.uncommitted.length > 0 ? 'warn' : 'ok', detail: parts.join(' · ')};
}

export function targetCheck(target: TargetRepo): Check {
	return target.kind === 'git'
		? {id: 'target', label: 'Target repo', state: 'ok', detail: `${target.root}${target.branch ? ` (${target.branch})` : ''}`}
		: {id: 'target', label: 'Target repo', state: 'warn', detail: target.reason, fix: 'Mở `pirl` trong thư mục của một git repo để dùng các layer.'};
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
