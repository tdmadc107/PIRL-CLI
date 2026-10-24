import {join} from 'node:path';
import {render} from 'ink';
import {createClipboard} from '../core/clipboard.js';
import {loadConfig, saveConfig, type Config} from '../core/config.js';
import {exec} from '../core/exec.js';
import {configFile, displayPath, hubDir, packageInfo, packageRoot, pirlHome} from '../core/paths.js';
import {detectTargetRepo} from '../core/targetRepo.js';
import {runDoctor} from '../doctor/doctor.js';
import {readClaudeQuota} from '../engine/claudeQuota.js';
import {attachmentContext, pathIndex, resolveMentions, type PathEntry} from '../engine/attachments.js';
import {createClaudeRunner} from '../engine/claudeRunner.js';
import {readPlanPackages, readRecords} from '../engine/hubData.js';
import {RunController} from '../engine/run.js';
import {listRuns, saveRun} from '../engine/runStore.js';
import {loadBundledFramework, type BundledFramework} from '../hub/framework.js';
import {frameworkServices} from '../hub/services.js';
import {ensureHub, type HubStatus} from '../hub/hub.js';
import {getProvider} from '../providers/index.js';
import {App} from '../ui/App.js';
import {MOUSE_OFF, mouseSequence} from '../ui/terminalInput.js';
import type {StartupNote} from '../ui/session.js';

/** The run's model settings as the provider's arguments; `default` and `inherit` leave the choice to it. */
export const runModels = (config: Config) => ({
	model: config.model === 'default' ? undefined : config.model,
	roleModel: config.roleModel === 'inherit' ? undefined : config.roleModel,
	effort: config.effort === 'default' ? undefined : config.effort,
});

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

	let bundle: BundledFramework | null = null;
	let hub: HubStatus | null = null;
	let hubError: string | null = null;
	try {
		bundle = loadBundledFramework(root);
		const result = await ensureHub(hubDir(home), bundle);
		hub = result.status;
		if (result.created) notes.push({tone: 'success', text: `Đã tạo Hub tại ${displayPath(hub.path)} với framework ${hub.upstreamTag ?? ''}.`});
	} catch (error) {
		hubError = error instanceof Error ? error.message : String(error);
		notes.push({tone: 'error', text: `Không chuẩn bị được Hub: ${hubError}`});
	}

	const targetRoot = target.kind === 'git' ? target.root : null;
	// `@` mentions are read from the target repository, or from the start directory outside one.
	const attachBase = targetRoot ?? process.cwd();
	const paths = cachedPaths(() => pathIndex(attachBase));
	const runner = createClaudeRunner();
	const instance = render(
		<App
			info={{cliVersion: pkg.version, target, hub, hubError}}
			initialConfig={config}
			startupNotes={notes}
			services={{
				runDoctor: current => runDoctor({exec, provider: getProvider(current.provider), target, hub, hubError}),
				saveConfig: next => saveConfig(configFile(home), next),
				startRun: options =>
					new RunController(
						{runner, hub: hub!.path, target: targetRoot, logDir: join(home, 'logs'), quota: () => readClaudeQuota('claude', hub!.path), python: options.python, maxParallelRoles: options.config.maxParallelRoles, recentOutputs: options.recentOutputs, attachments: options.attachments, ...runModels(options.config)},
						options.id,
						options.kind,
						options.request,
						options.resume,
					),
				saveRun: run => targetRoot && saveRun(home, targetRoot, run),
				runs: () => (targetRoot ? listRuns(home, targetRoot) : []),
				plans: () => (hub && targetRoot ? readPlanPackages(hub.path, targetRoot) : []),
				records: () => (hub ? readRecords(hub.path, targetRoot) : []),
				clipboard: createClipboard({writeTerminal: data => process.stdout.write(data)}),
				quota: () => (hub ? readClaudeQuota('claude', hub.path) : Promise.resolve(null)),
				paths: () => paths.get(),
				attach: text => attachmentContext(resolveMentions(text, attachBase, process.cwd()), [attachBase, ...(hub ? [hub.path] : [])]),
				setMouse: mode => process.stdout.write(mouseSequence(mode)),
				framework: hub && bundle ? frameworkServices(hub.path, bundle, runner, config => runModels(config).model) : undefined,
			}}
		/>,
		// Ctrl+C is handled by the TUI: it stops a running run first. The kitty keyboard protocol, where the
		// terminal supports it (Windows Terminal 1.25+, kitty, WezTerm, Ghostty, iTerm2), tells Shift+Enter from Enter.
		// Incremental rendering rewrites only the rows that changed: a spinner tick sends a few bytes, not a screen.
		{alternateScreen: true, exitOnCtrlC: false, kittyKeyboard: {mode: 'auto'}, incrementalRendering: true},
	);
	// The terminal keeps reporting the mouse after the TUI ends unless it is told to stop, even on a crash.
	process.once('exit', () => process.stdout.write(MOUSE_OFF));
	await instance.waitUntilExit();
	process.stdout.write(MOUSE_OFF);
	return 0;
}

main().then(
	code => process.exit(code),
	error => {
		console.error(error instanceof Error ? error.stack : error);
		process.exit(1);
	},
);

/** The path index for `@` completion, read again when older than a few seconds so new files show up. */
function cachedPaths(read: () => Promise<PathEntry[]>, maxAgeMs = 10_000) {
	let cached: {at: number; value: Promise<PathEntry[]>} | null = null;
	return {
		get(): Promise<PathEntry[]> {
			if (!cached || Date.now() - cached.at > maxAgeMs) cached = {at: Date.now(), value: read().catch(() => [])};
			return cached.value;
		},
	};
}
