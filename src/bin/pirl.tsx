#!/usr/bin/env node
import {render} from 'ink';
import {loadConfig, saveConfig} from '../core/config.js';
import {exec} from '../core/exec.js';
import {configFile, displayPath, hubDir, packageInfo, packageRoot, pirlHome} from '../core/paths.js';
import {detectTargetRepo} from '../core/targetRepo.js';
import {runDoctor} from '../doctor/doctor.js';
import {loadBundledFramework} from '../hub/framework.js';
import {ensureHub, type HubStatus} from '../hub/hub.js';
import {getProvider} from '../providers/index.js';
import {App} from '../ui/App.js';
import type {StartupNote} from '../ui/session.js';

const HELP = `PIRL CLI: chạy PIRL framework (Plan – Implement – Review) bằng agent CLI bạn đã đăng nhập.

Cách dùng
  pirl              Mở TUI. Thư mục hiện tại (git repo) là target repo.
  pirl --version    In phiên bản CLI và framework đi kèm.
  pirl --help       In hướng dẫn này.

Trong TUI, gõ / để xem lệnh, hoặc /help để xem lệnh và phím tắt.`;

async function main(): Promise<number> {
	const root = packageRoot();
	const pkg = packageInfo(root);
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(HELP);
		return 0;
	}
	if (args.includes('--version') || args.includes('-v')) {
		let framework = 'không có';
		try {
			framework = `fw-${loadBundledFramework(root).manifest.version}`;
		} catch {}
		console.log(`pirl ${pkg.version} (framework ${framework})`);
		return 0;
	}
	if (args.length > 0) {
		console.error(`pirl: không nhận tham số "${args[0]}". Lệnh chạy bên trong TUI.\n\n${HELP}`);
		return 2;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error('pirl cần chạy trong một terminal tương tác.');
		return 1;
	}

	const home = pirlHome();
	const notes: StartupNote[] = [];
	const {config, warning} = loadConfig(configFile(home));
	if (warning) notes.push({tone: 'warning', text: warning});

	const target = await detectTargetRepo(process.cwd());
	if (target.kind === 'none') {
		notes.push({tone: 'warning', text: `${target.reason}: các layer bị khoá.`, hint: 'Mở `pirl` trong thư mục của một git repo để dùng /pirl-plan, /pirl-implement, /pirl-review.'});
	}

	let hub: HubStatus | null = null;
	let hubError: string | null = null;
	try {
		const result = await ensureHub(hubDir(home), loadBundledFramework(root));
		hub = result.status;
		if (result.created) notes.push({tone: 'success', text: `Đã tạo Hub tại ${displayPath(hub.path)} với framework ${hub.upstreamTag ?? ''}.`});
	} catch (error) {
		hubError = error instanceof Error ? error.message : String(error);
		notes.push({tone: 'error', text: `Không chuẩn bị được Hub: ${hubError}`});
	}

	const instance = render(
		<App
			info={{cliVersion: pkg.version, target, hub, hubError}}
			initialConfig={config}
			startupNotes={notes}
			services={{
				runDoctor: current => runDoctor({exec, provider: getProvider(current.provider), target, hub, hubError}),
				saveConfig: next => saveConfig(configFile(home), next),
			}}
		/>,
		{alternateScreen: true, exitOnCtrlC: true},
	);
	await instance.waitUntilExit();
	return 0;
}

main().then(
	code => process.exit(code),
	error => {
		console.error(error instanceof Error ? error.stack : error);
		process.exit(1);
	},
);
