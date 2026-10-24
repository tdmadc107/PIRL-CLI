import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {readRoleCatalog, roleAgents} from '../src/engine/agents.js';
import {claudeArgs} from '../src/engine/claudeRunner.js';
import {createStreamParser, describeTool, parseStreamLine} from '../src/engine/claudeStream.js';
import {allowedPaths, outsideAllowed, readPlanPackages, readRecords, sameRepo} from '../src/engine/hubData.js';
import {permissionsFor, ruleRoot} from '../src/engine/permissions.js';
import {answersMessage, hostInstructions, parseOutputs, parseQuestions, parseSuggestion, stripBlocks} from '../src/engine/protocol.js';
import {formatElapsed, LOG_LIMIT, RunController} from '../src/engine/run.js';
import {loadRun, resumable, saveRun} from '../src/engine/runStore.js';
import {cleanupTemp, fakeRunner, git, hubAndTarget, outputsBlock, PYTHON, result, tempDir, writePlan, writeRecord} from './helpers/hub.js';

afterEach(cleanupTemp);

describe('Claude Code stream-json', () => {
	test('session, role start/activity/end attributed by parent_tool_use_id, and the result', () => {
		expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s-1"}')).toEqual([{type: 'session', sessionId: 's-1'}]);
		const spawn = parseStreamLine(
			JSON.stringify({type: 'assistant', parent_tool_use_id: null, message: {content: [{type: 'text', text: 'Bắt đầu'}, {type: 'tool_use', id: 'tu-1', name: 'Agent', input: {subagent_type: 'code-analyst', description: 'Trace cancelOrder'}}]}}),
		);
		expect(spawn).toEqual([
			{type: 'text', text: 'Bắt đầu'},
			{type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace cancelOrder'},
		]);
		expect(parseStreamLine(JSON.stringify({type: 'assistant', parent_tool_use_id: 'tu-1', message: {content: [{type: 'tool_use', id: 'x', name: 'Read', input: {file_path: 'src/orders/cancel.ts'}}]}}))).toEqual([
			{type: 'activity', agent: 'tu-1', text: 'Đọc src/orders/cancel.ts'},
		]);
		expect(parseStreamLine(JSON.stringify({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'tu-1', is_error: false}]}}))).toEqual([
			{type: 'role-end', toolUseId: 'tu-1', ok: true},
		]);
		expect(
			parseStreamLine(
				JSON.stringify({
					type: 'result',
					subtype: 'success',
					is_error: false,
					result: 'Xong',
					session_id: 's-1',
					usage: {input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5},
					permission_denials: [{tool_name: 'Bash', tool_input: {command: 'git commit -m x'}}],
				}),
			),
		).toEqual([
			{type: 'denied', id: null, detail: 'Chạy git commit -m x'},
			{type: 'result', text: 'Xong', isError: false, sessionId: 's-1', usage: {inputTokens: 100, outputTokens: 5}},
		]);
	});

	test('a denial names the refused command, which Claude Code only gives in the earlier tool call', () => {
		const parse = createStreamParser();
		parse(JSON.stringify({type: 'assistant', parent_tool_use_id: 'tu-1', message: {content: [{type: 'tool_use', id: 'b-7', name: 'Bash', input: {command: 'mkdir -p /tmp/x'}}]}}));
		expect(parse('{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"b-7","message":"denied"}')).toEqual([
			{type: 'denied', id: 'b-7', detail: 'Chạy mkdir -p /tmp/x'},
		]);
		// Without the earlier call (another parser), only the tool name is known.
		expect(parseStreamLine('{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"b-7"}')).toEqual([{type: 'denied', id: 'b-7', detail: 'Bash'}]);
	});

	test('the old Task tool name, errors and junk lines', () => {
		expect(parseStreamLine(JSON.stringify({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Task', input: {subagent_type: 'ux-designer'}}]}}))[0]).toMatchObject({type: 'role-start', role: 'ux-designer'});
		expect(parseStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s"}')[0]).toMatchObject({type: 'result', isError: true});
		expect(parseStreamLine('not json')).toEqual([]);
		// The shape Claude Code 2.1.309 prints for a resume of an unknown session.
		expect(parseStreamLine('{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s","usage":{"input_tokens":0,"output_tokens":0},"permission_denials":[],"errors":["No conversation found with session ID: s"]}')).toEqual([
			{type: 'result', text: 'No conversation found with session ID: s', isError: true, sessionId: 's', usage: {inputTokens: 0, outputTokens: 0}},
		]);
		expect(describeTool('Bash', {command: 'git log --oneline -5'})).toBe('Chạy git log --oneline -5');
	});
});

describe('permissions', () => {
	test('absolute paths become // rules, Windows drives become //d/...', () => {
		expect(ruleRoot('/home/dev/.pirl/hub')).toBe('//home/dev/.pirl/hub');
		expect(ruleRoot('D:\\Project\\.repository\\Portfolio\\')).toBe('//d/Project/.repository/Portfolio');
	});

	test('Plan and Review cannot edit the target; Implement can and may run tests; nobody may commit', () => {
		const paths = {hub: '/h/hub', target: '/w/shop'};
		const plan = permissionsFor('plan', paths, PYTHON);
		expect(plan.allow).toContain('Edit(//h/hub/**)');
		expect(plan.allow).toContain('Bash(python3 -B .agents/evals/*)');
		expect(plan.deny).toContain('Edit(//w/shop/**)');
		expect(plan.deny).toContain('Bash(git commit *)');
		expect(plan.allow.some(rule => rule.includes('npm test'))).toBe(false);
		expect(permissionsFor('review', paths, PYTHON).deny).toContain('Edit(//w/shop/**)');
		const implement = permissionsFor('implement', paths, PYTHON);
		expect(implement.allow).toContain('Edit(//w/shop/**)');
		expect(implement.allow).toContain('Bash(npm test *)');
		expect(implement.deny).not.toContain('Edit(//w/shop/**)');
		expect(permissionsFor('plan', paths, {command: 'py', args: ['-3']}).allow).toContain('Bash(py -3 -B .skills/*)');
		// Read-only Git in the target, and no tool that would keep a headless run waiting.
		expect(plan.allow).toContain('Bash(git -C /w/shop log *)');
		expect(plan.allow.some(rule => rule.startsWith('Bash(git -C /w/shop commit'))).toBe(false);
		expect(plan.deny).toEqual(expect.arrayContaining(['ScheduleWakeup', 'Monitor', 'CronCreate']));
	});

	test('claude arguments: headless stream, files for long values, dontAsk, resume', () => {
		const args = claudeArgs(
			{cwd: '/h', addDirs: ['/w'], prompt: 'x', systemPrompt: 'y', agents: {}, permissions: {allow: ['Read', 'Bash(git log *)'], deny: ['Bash(rm *)']}, resumeSessionId: 's-9'},
			{systemPrompt: '/tmp/host.md', agents: '/tmp/agents.json'},
		);
		expect(args.join(' ')).toContain('-p --output-format stream-json --verbose --append-system-prompt-file /tmp/host.md --agents /tmp/agents.json --permission-mode dontAsk --permission-prompts none');
		expect(args).toContain('Read,Bash(git log *)');
		expect(args.slice(-4)).toEqual(['--add-dir', '/w', '--resume', 's-9']);
		expect(args).not.toContain('--bare'); // bare mode would not use the user's subscription
	});
});

describe('host protocol', () => {
	const reply = [
		'## Kết quả',
		'Plan đã tạo.',
		'```pirl-questions',
		'[{"id":"Q1","question":"Gửi email cả khi admin huỷ?","options":["Có","Không"],"recommended":1}]',
		'```',
		'```pirl-result',
		'{"plan_set":"/h/order_20261024-101500","plan_file":null,"report":"null","record_id":"plan-1"}',
		'```',
	].join('\n');

	test('questions, outputs and the readable reply', () => {
		expect(parseQuestions(reply)).toEqual([{id: 'Q1', question: 'Gửi email cả khi admin huỷ?', options: ['Có', 'Không'], recommended: 1}]);
		expect(parseOutputs(reply)).toEqual({planSet: '/h/order_20261024-101500', planFile: null, report: null, recordId: 'plan-1'});
		expect(stripBlocks(reply)).toBe('## Kết quả\nPlan đã tạo.');
		expect(parseQuestions('```pirl-questions\nnot json\n```')).toEqual([]);
		expect(parseSuggestion('Dùng lệnh:\n```pirl-suggest\n/pirl-plan Thêm email\n```')).toBe('/pirl-plan Thêm email');
		expect(answersMessage([{id: 'Q1', question: 'A?', options: []}], ['Có'])).toContain('- Q1 (A?): Có');
	});

	test('host instructions name the layer, the python command, and never open another layer', () => {
		const text = hostInstructions({kind: 'plan', hub: '/h', target: '/w', python: {command: 'py', args: ['-3']}, maxParallelRoles: 2});
		expect(text).toContain('/pirl-plan');
		expect(text).toContain('.skills/pirl-plan/SKILL.md');
		expect(text).toContain('`py -3 -B ...`');
		expect(text).toContain('at most 2 role subagents');
		expect(text).toContain('Do not commit');
		const chat = hostInstructions({kind: 'chat', hub: '/h', target: null, python: null, maxParallelRoles: 1});
		expect(chat).toContain('pirl-suggest');
		expect(chat).not.toContain('pirl-result');
	});
});

describe('role agents', () => {
	test('one subagent per catalog role with the tools of its kind of work', async () => {
		const {hub} = await hubAndTarget();
		const catalog = readRoleCatalog(hub);
		expect(catalog.map(role => role.id)).toHaveLength(9);
		const agents = roleAgents(hub, catalog);
		expect(agents['business-analyst']!.tools).toEqual(['Read', 'Grep', 'Glob']);
		expect(agents['code-reviewer']!.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
		expect(agents['backend-developer']!.tools).toContain('Edit');
		expect(agents['technical-writer']!.tools).not.toContain('Bash');
		expect(agents['process-auditor']!.tools).toContain('Edit');
		for (const agent of Object.values(agents)) expect(agent.tools).not.toContain('Agent');
		expect(agents['ux-designer']!.prompt).toContain(join('.agents', 'roles', 'ux-designer.role.md'));
	});
});

describe('Hub data for /plans and /records', () => {
	test('packages and records are matched to the target repository', async () => {
		const {hub, target} = await hubAndTarget();
		const {planSet} = writePlan(hub, target);
		writeRecord(hub, target, planSet);
		const packages = readPlanPackages(hub, target);
		expect(packages).toHaveLength(1);
		expect(packages[0]!.tasks[0]).toMatchObject({taskId: 'T01', status: 'planned'});
		expect(readPlanPackages(hub, tempDir())).toEqual([]);
		expect(readRecords(hub, target)).toEqual([expect.objectContaining({layer: 'plan', status: 'ready', summary: 'Plan cho email huỷ đơn'})]);
		expect(readRecords(hub, tempDir())).toEqual([]);
		expect(sameRepo('../x', '/a/hub', '/a/x')).toBe(true);
	});

	test('Allowed paths: directories with a trailing slash, exact files', () => {
		const plan = '- Allowed paths: `src/orders/`, `docs/api.md`, `test/orders.test.ts`.';
		expect(allowedPaths(plan)).toEqual(['src/orders/', 'docs/api.md', 'test/orders.test.ts']);
		expect(outsideAllowed(['src/orders/cancel.ts', 'docs/api.md', 'src/app.ts'], allowedPaths(plan))).toEqual(['src/app.ts']);
		expect(outsideAllowed(['anything'], [])).toEqual([]);
	});
});

describe('run store', () => {
	test('saves the last run per target repository for /resume', () => {
		const home = tempDir();
		const run = {kind: 'plan' as const, request: 'Thêm email', sessionId: 's-1', status: 'stopped' as const, questions: [], before: {hubChanges: [], records: 0, planSets: [], targetChanges: []}};
		saveRun(home, '/w/a', run);
		expect(loadRun(home, '/w/a')).toMatchObject(run);
		expect(loadRun(home, '/w/b')).toBeNull();
		expect(resumable(loadRun(home, '/w/a'))).toBe(true);
		expect(resumable({...run, status: 'done'})).toBe(false);
	});
});

describe('RunController', () => {
	const deps = (hub: string, target: string, runner: ReturnType<typeof fakeRunner>['runner']) => ({runner, hub, target, python: PYTHON, maxParallelRoles: 2});

	test('a Plan run: roles, a valid package, a record, then the commit question for improvements', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([
			() => {
				const {planSet} = writePlan(hub, target);
				const recordId = writeRecord(hub, target, planSet);
				appendFileSync(join(hub, '.agents/roles/code-analyst.role.md'), '\n- Check every caller.\n');
				return [
					{type: 'session', sessionId: 'session-1'},
					{type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace cancelOrder'},
					{type: 'activity', agent: 'tu-1', text: 'Đọc src/orders/cancel.ts'},
					{type: 'role-end', toolUseId: 'tu-1', ok: true},
					result('Plan đã sẵn sàng.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: recordId})),
				];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Khách nhận email khi đơn bị huỷ');
		const seen: string[] = [];
		run.subscribe(state => seen.push(state.status));
		await run.start();
		expect(calls[0]!.prompt).toBe('Khách nhận email khi đơn bị huỷ');
		expect(calls[0]!.addDirs).toEqual([target]);
		expect(run.state.roles).toEqual([expect.objectContaining({role: 'code-analyst', state: 'done', activity: 'Đọc src/orders/cancel.ts'})]);
		expect(run.state.checks.validator).toMatchObject({state: 'pass'});
		expect(run.state.checks.record).toMatchObject({state: 'pass'});
		expect(run.state.status).toBe('improvements');
		expect(run.state.improvements).toEqual({files: ['.agents/roles/code-analyst.role.md'], state: 'pending'});
		expect(seen).toContain('checking');
		await run.resolveImprovements('commit');
		expect(run.state.status).toBe('done');
		const log = git(hub, 'log', '-1', '--format=%B');
		expect(log).toContain('Pirl-Source: auditor');
		expect(log).toMatch(/Pirl-Record: plan-/);
		expect(git(hub, 'status', '--porcelain')).toBe('');
	});

	test('questions pause the run; answers resume the same session', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([
			() => [result('Cần quyết định.\n```pirl-questions\n[{"id":"Q1","question":"Gửi email khi admin huỷ?","options":["Có","Không"]}]\n```')],
			() => {
				const {planSet} = writePlan(hub, target);
				writeRecord(hub, target, planSet);
				return [result('Xong.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: null}))];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email huỷ đơn');
		await run.start();
		expect(run.state.status).toBe('waiting');
		expect(run.state.questions[0]!.question).toBe('Gửi email khi admin huỷ?');
		await run.answer(['Không']);
		expect(calls[1]!.resumeSessionId).toBe('session-1');
		expect(calls[1]!.prompt).toContain('Q1 (Gửi email khi admin huỷ?): Không');
		expect(run.state.status).toBe('done');
		expect(run.state.usage).toEqual({calls: 2, inputTokens: 2000, outputTokens: 400});
	});

	test('a failing validator and a missing record send the coordinator back, at most twice', async () => {
		const {hub, target} = await hubAndTarget();
		let planSet = '';
		let planFile = '';
		const {runner, calls} = fakeRunner([
			() => {
				const written = writePlan(hub, target);
				planSet = written.planSet;
				planFile = written.planFile;
				// Break the Plan with an unknown role, and write no record yet.
				writeFileSync(planFile, readFileSync(planFile, 'utf8').replace('[code-analyst]', '[nobody]'));
				return [result('Plan xong.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: null}))];
			},
			call => {
				expect(call.prompt).toContain('Validator báo lỗi');
				expect(call.prompt).toContain('process-auditor chưa ghi record');
				writeFileSync(planFile, readFileSync(planFile, 'utf8').replace('[nobody]', '[code-analyst]'));
				writeRecord(hub, target, planSet);
				return [result('Đã sửa.')];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email');
		await run.start();
		expect(calls).toHaveLength(2);
		expect(run.state.checks.validator?.state).toBe('pass');
		expect(run.state.checks.record?.state).toBe('pass');
		expect(run.state.status).toBe('done');
	});

	test('Implement: changes outside the Plan\'s Allowed paths are reported', async () => {
		const {hub, target} = await hubAndTarget();
		const {planSet, planFile} = writePlan(hub, target);
		const {runner} = fakeRunner([
			() => {
				writeFileSync(join(target, 'README.md'), '# Shop\nchanged\n');
				writeFileSync(join(target, 'secret.txt'), 'x');
				writeRecord(hub, target, planSet, 'implement');
				return [result('Đã implement.' + outputsBlock({plan_set: planSet, plan_file: planFile, report: null, record_id: null}))];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'implement', 'Implement T01');
		await run.start();
		expect(run.state.checks.paths).toEqual({state: 'fail', detail: 'Ngoài Allowed paths: secret.txt'});
	});

	test('discarding improvements restores only the files this run changed', async () => {
		const {hub, target} = await hubAndTarget();
		appendFileSync(join(hub, 'CONTEXT.md'), '\nMy own edit.\n');
		const {runner} = fakeRunner([
			() => {
				appendFileSync(join(hub, 'AGENTS.md'), '\nAuditor edit.\n');
				return [result('Đã trả lời.')];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'chat', 'Giải thích AGENTS.md');
		await run.start();
		expect(run.state.improvements?.files).toEqual(['AGENTS.md']);
		await run.resolveImprovements('discard');
		expect(readFileSync(join(hub, 'AGENTS.md'), 'utf8')).not.toContain('Auditor edit.');
		expect(readFileSync(join(hub, 'CONTEXT.md'), 'utf8')).toContain('My own edit.');
	});

	test('a chat reply that asks for a layer suggests the slash command instead of running it', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([() => [result('Hãy dùng:\n```pirl-suggest\n/pirl-plan Email huỷ đơn\n```')]]);
		const run = new RunController(deps(hub, target, runner), 1, 'chat', 'tạo plan cho email huỷ đơn');
		await run.start();
		expect(run.state.suggestion).toBe('/pirl-plan Email huỷ đơn');
		expect(run.state.reply).toBe('Hãy dùng:');
		expect(calls[0]!.allow).toContain(`Edit(${ruleRoot(target)}/**)`);
	});

	test('stop() marks the run stopped and keeps the session for /resume', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => new Promise(() => {})]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email');
		const started = run.start();
		await new Promise(resolve => setTimeout(resolve, 50));
		run.stop();
		await started;
		expect(run.state.status).toBe('stopped');
		expect(run.persisted()).toMatchObject({kind: 'plan', request: 'Email', status: 'stopped'});
	});

	test('the log: bounded in memory, complete in the log file, and a refusal reported twice counts once', async () => {
		const {hub, target} = await hubAndTarget();
		const logDir = tempDir();
		let clock = 1_000_000;
		const {runner} = fakeRunner([
			(_call, emit) => {
				emit({type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace'});
				for (let i = 0; i < LOG_LIMIT + 50; i++) {
					clock += 1000;
					emit({type: 'activity', agent: 'tu-1', text: `Đọc file-${i}.ts`});
				}
				emit({type: 'denied', id: 'b-1', detail: 'Chạy mkdir -p /tmp/x'});
				emit({type: 'denied', id: 'b-1', detail: 'Chạy mkdir -p /tmp/x'});
				return [result('Xong.')];
			},
		]);
		const run = new RunController({...deps(hub, target, runner), logDir, now: () => clock}, 3, 'chat', 'Hỏi');
		await run.start();
		expect(run.state.denials).toEqual(['Chạy mkdir -p /tmp/x']);
		expect(run.state.log).toHaveLength(LOG_LIMIT);
		expect(run.state.logCount).toBeGreaterThan(LOG_LIMIT + 50);
		expect(run.state.log.at(-1)).toMatchObject({who: 'pirl', text: 'Xong', tone: 'success'});
		expect(run.state.log.some(entry => entry.who === 'code-analyst' && entry.text === `Đọc file-${LOG_LIMIT + 49}.ts`)).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 50));
		const file = readFileSync(run.state.logFile!, 'utf8').trim().split('\n');
		expect(file).toHaveLength(run.state.logCount);
		expect(file[0]).toMatch(/^00:00 pirl\s+Bắt đầu Chat: Hỏi$/);
		expect(file.some(line => /^\d\d:\d\d code-analyst\s+Đọc file-0\.ts$/.test(line))).toBe(true);
		expect(formatElapsed(3_725_000)).toBe('1:02:05');
	});

	test('a provider error fails the run with its message', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => [{type: 'result', text: 'Credit balance is too low', isError: true, sessionId: 's', usage: {inputTokens: 0, outputTokens: 0}}]]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email');
		await run.start();
		expect(run.state).toMatchObject({status: 'failed', error: 'Credit balance is too low'});
	});
});
