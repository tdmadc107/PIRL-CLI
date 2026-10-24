import type {Config} from '../../src/core/config.js';
import {DEFAULT_CONFIG} from '../../src/core/config.js';
import type {DoctorReport} from '../../src/doctor/doctor.js';
import type {AppProps} from '../../src/ui/App.js';
import type {SessionInfo} from '../../src/ui/session.js';

export const READY_REPORT: DoctorReport = {
	python: {command: 'python3', args: [], version: '3.12.4'},
	checks: [
		{id: 'node', label: 'Node.js', state: 'ok', detail: 'v22.22.0'},
		{id: 'git', label: 'Git', state: 'ok', detail: '2.43.0'},
		{id: 'python', label: 'Python', state: 'ok', detail: '3.12.4 (python3)'},
		{id: 'provider', label: 'Claude Code', state: 'ok', detail: '2.1.309 · đã đăng nhập bằng tài khoản Claude (subscription)'},
		{id: 'hub', label: 'Hub', state: 'ok', detail: 'fw-1.0.0 · 0 cải tiến cục bộ'},
		{id: 'target', label: 'Target repo', state: 'ok', detail: '/work/shop-web (main)'},
	],
};

export function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		cliVersion: '0.1.0',
		target: {kind: 'git', root: '/work/projects/shop-web', name: 'shop-web', branch: 'main'},
		hub: {
			path: '/home/dev/.pirl/hub',
			upstreamTag: 'fw-1.0.0',
			localImprovements: 2,
			uncommitted: [],
			updateAvailable: false,
			bundledVersion: '1.0.0',
			branch: 'main',
		},
		hubError: null,
		...overrides,
	};
}

export function appProps(overrides: Partial<AppProps> = {}, report: DoctorReport = READY_REPORT) {
	const saved: Config[] = [];
	const props: AppProps = {
		info: sessionInfo(),
		initialConfig: {...DEFAULT_CONFIG},
		services: {runDoctor: async () => report, saveConfig: config => void saved.push(config)},
		env: {},
		platform: 'linux',
		...overrides,
	};
	return {props, saved};
}
