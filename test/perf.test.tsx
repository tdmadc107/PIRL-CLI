import {performance} from 'node:perf_hooks';
import {afterEach, describe, expect, test} from 'vitest';
import {RunController} from '../src/engine/run.js';
import type {RunEvent} from '../src/engine/types.js';
import {App} from '../src/ui/App.js';
import type {Services} from '../src/ui/session.js';
import {appProps, sessionInfo} from './helpers/fixtures.js';
import {cleanupTemp, fakeRunner, hubAndTarget, PYTHON, result} from './helpers/hub.js';
import {KEYS, renderTerminal, tick} from './helpers/terminal.js';

/**
 * How much the TUI costs while a busy run streams events. Run with PIRL_PERF=1; prints frames drawn,
 * render time and CPU for a burst of events, so changes to the run view can be compared by numbers.
 */
const enabled = process.env['PIRL_PERF'] === '1';
afterEach(cleanupTemp);

describe.runIf(enabled)('performance while a run is idle', () => {
	test.each([
		['spinner bật, run đứng yên 3 giây', true],
		['spinner tắt, run đứng yên 3 giây', false],
	])('%s', async (label, motion) => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([(_call, emit) => (emit({type: 'session', sessionId: 's'}), new Promise(() => {}))]);
		const base = appProps({
			initialConfig: {...appProps().props.initialConfig, motion},
			info: sessionInfo({target: {kind: 'git', root: target, name: 'shop', branch: 'main'}, hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'}}),
		});
		const services: Services = {
			...base.props.services,
			startRun: options => new RunController({runner, hub, target, python: PYTHON, maxParallelRoles: 2}, options.id, options.kind, options.request, options.resume),
		};
		let frames = 0;
		let renderMs = 0;
		const terminal = renderTerminal(<App {...base.props} services={services} />, 160, 45, {onRender: metrics => ((frames += 1), (renderMs += metrics.renderTime))});
		await tick(80);
		await terminal.type('/pirl-plan thử');
		await terminal.press(KEYS.enter);
		await tick(500);
		frames = 0;
		renderMs = 0;
		const cpu = process.cpuUsage();
		await tick(3000);
		const used = process.cpuUsage(cpu);
		console.log(`[perf] ${label}: ${frames} khung hình, tổng render ${renderMs.toFixed(0)} ms, CPU ${((used.user + used.system) / 1000).toFixed(0)} ms trong 3000 ms`);
		terminal.cleanup();
	});
});

describe.runIf(enabled)('performance under a busy run', () => {
	test.each([
		['1.000 sự kiện trong ~2 giây', 1000, 2],
		['3.000 sự kiện dồn cùng lúc', 3000, 0],
	])('%s', async (_label, count, spreadMs) => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([
			async (_call, emit) => {
				emit({type: 'session', sessionId: 's'});
				emit({type: 'role-start', toolUseId: 'r1', role: 'code-analyst', description: 'Trace'});
				for (let i = 0; i < count; i++) {
					emit({type: 'activity', agent: i % 3 === 0 ? null : 'r1', text: `Đọc src/module-${i % 40}/file-${i}.ts`});
					if (spreadMs && i % 10 === 0) await new Promise(resolve => setTimeout(resolve, spreadMs * 10));
				}
				return [{type: 'role-end', toolUseId: 'r1', ok: true} as RunEvent, result('Xong.')];
			},
		]);
		const base = appProps({info: sessionInfo({target: {kind: 'git', root: target, name: 'shop', branch: 'main'}, hub: {path: hub, upstreamTag: 'fw-1.0.0', localImprovements: 0, uncommitted: [], updateAvailable: false, bundledVersion: '1.0.0', branch: 'main'}})});
		const services: Services = {
			...base.props.services,
			startRun: options => new RunController({runner, hub, target, python: PYTHON, maxParallelRoles: 2}, options.id, options.kind, options.request, options.resume),
		};
		let frames = 0;
		let renderMs = 0;
		const terminal = renderTerminal(<App {...base.props} services={services} />, 160, 45, {
			onRender: metrics => {
				frames += 1;
				renderMs += metrics.renderTime;
			},
		});
		await tick(80);
		await terminal.type('chat thử');
		frames = 0;
		renderMs = 0;
		const cpu = process.cpuUsage();
		const started = performance.now();
		await terminal.press(KEYS.enter);
		while (!terminal.frame().includes('Xong.')) await tick(20);
		const wall = performance.now() - started;
		const used = process.cpuUsage(cpu);
		console.log(
			`[perf] ${_label}: ${frames} khung hình vẽ, tổng render ${renderMs.toFixed(0)} ms, CPU ${((used.user + used.system) / 1000).toFixed(0)} ms, thời gian thực ${wall.toFixed(0)} ms`,
		);
		terminal.cleanup();
		expect(frames).toBeGreaterThan(0);
	});
});
