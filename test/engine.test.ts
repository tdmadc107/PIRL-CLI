import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {readRoleCatalog, roleAgents} from '../src/engine/agents.js';
import {claudeArgs} from '../src/engine/claudeRunner.js';
import {createStreamParser, describeTool, parseStreamLine} from '../src/engine/claudeStream.js';
import {allowedPaths, outsideAllowed, readFrontmatter, readPlanPackages, readRecords, sameRepo} from '../src/engine/hubData.js';
import {permissionsFor, ruleRoot} from '../src/engine/permissions.js';
import {answersMessage, hostInstructions, parseOutputs, parseQuestions, parseSuggestion, stripBlocks} from '../src/engine/protocol.js';
import {formatElapsed, RunController} from '../src/engine/run.js';
import {listRuns, resumable, saveRun} from '../src/engine/runStore.js';
import type {RunEvent} from '../src/engine/types.js';
import {cleanupTemp, fakeRunner, git, hubAndTarget, outputsBlock, PYTHON, result, tempDir, usage, writePlan, writeRecord} from './helpers/hub.js';

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
			{type: 'result', text: 'Xong', isError: false, sessionId: 's-1'},
		]);
	});

	test('tokens are counted per model request, roles included, and only once per request', () => {
		const parse = createStreamParser();
		const message = (id: string, usage: Record<string, unknown>, parent: string | null = null) =>
			JSON.stringify({type: 'assistant', parent_tool_use_id: parent, message: {id, model: 'claude-opus-5-5', usage, content: [{type: 'text', text: 'x'}]}});
		const usage = {input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 50, cache_creation: {ephemeral_1h_input_tokens: 1000}};
		// Opus 5.5: 2 in at $4, 1k one-hour writes at $8, 20k reads at $0.20, 50 out at $20 per million.
		const cost = (2 * 4 + 1000 * 8 + 20000 * 0.2 + 50 * 20) / 1e6;
		expect(parse(message('m1', usage))[0]).toEqual({type: 'usage', model: 'claude-opus-5-5', request: true, inputTokens: 2, cacheWriteTokens: 1000, cacheReadTokens: 20000, outputTokens: 50, costUsd: cost});
		// The next content block of the same request repeats its usage: nothing new to count.
		expect(parse(message('m1', usage)).filter(event => event.type === 'usage')).toEqual([]);
		// A later block with more output adds only the difference.
		expect(parse(message('m1', {...usage, output_tokens: 80}))[0]).toMatchObject({type: 'usage', request: false, outputTokens: 30, cacheReadTokens: 0});
		// A role's request counts too.
		expect(parse(message('m2', usage, 'tu-1'))[0]).toMatchObject({type: 'usage', request: true, cacheReadTokens: 20000});
	});

	test('a request\'s output arrives at its end; the result gives exact totals; the plan windows come with the call', () => {
		const parse = createStreamParser();
		const start = {type: 'stream_event', event: {type: 'message_start', message: {id: 'm9', model: 'claude-sonnet-5-5', usage: {input_tokens: 2, cache_creation_input_tokens: 6716, cache_read_input_tokens: 0, output_tokens: 16}}}};
		expect(parse(JSON.stringify(start))[0]).toMatchObject({type: 'usage', request: true, cacheWriteTokens: 6716, outputTokens: 16});
		const end = {type: 'stream_event', api_message_id: 'm9', event: {type: 'message_delta', usage: {input_tokens: 2, cache_creation_input_tokens: 6716, cache_read_input_tokens: 0, output_tokens: 214}}};
		expect(parse(JSON.stringify(end))[0]).toMatchObject({type: 'usage', model: 'claude-sonnet-5-5', request: false, cacheWriteTokens: 0, outputTokens: 198});
		// The assistant message of the same request repeats the start values: nothing new, and nothing taken back.
		const message = {type: 'assistant', message: {id: 'm9', model: 'claude-sonnet-5-5', usage: start.event.message.usage, content: []}};
		expect(parse(JSON.stringify(message))).toEqual([]);
		const result = {
			type: 'result',
			subtype: 'success',
			result: 'OK',
			session_id: 's',
			modelUsage: {'claude-sonnet-5-5': {inputTokens: 8, outputTokens: 363, cacheReadInputTokens: 10016, cacheCreationInputTokens: 10628, costUSD: 0.0419516}},
		};
		expect(parse(JSON.stringify(result))[0]).toEqual({
			type: 'usage-totals',
			models: {'claude-sonnet-5-5': {inputTokens: 8, outputTokens: 363, cacheReadTokens: 10016, cacheWriteTokens: 10628, costUsd: 0.0419516}},
		});
		const limits = {
			type: 'rate_limit_event',
			rate_limit_info: {status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, unifiedWindows: {five_hour: {utilization: 0.4, resetsAt: 1792823400}, seven_day: {utilization: 0.22, resetsAt: 1793332800}}},
		};
		expect(parse(JSON.stringify(limits))[0]).toEqual({
			type: 'quota',
			rows: [
				{kind: 'five_hour', label: '5 giờ', percent: 40, resetsAt: new Date(1792823400 * 1000).toISOString()},
				{kind: 'seven_day', label: 'Tuần', percent: 22, resetsAt: new Date(1793332800 * 1000).toISOString()},
			],
		});
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
			{type: 'result', text: 'No conversation found with session ID: s', isError: true, sessionId: 's'},
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
		expect(plan.allow).toContain(`Bash(${PYTHON.command} -B .agents/evals/*)`);
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
		expect(args.join(' ')).toContain('-p --output-format stream-json --verbose --append-system-prompt-file /tmp/host.md --agents /tmp/agents.json --tools Read,Write,Edit,Bash,Glob,Grep,Agent --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --permission-prompts none');
		expect(args).toContain('Read,Bash(git log *)');
		expect(args.slice(-4)).toEqual(['--add-dir', '/w', '--resume', 's-9']);
		expect(args).not.toContain('--bare'); // bare mode would not use the user's subscription
		expect(args).not.toContain('--model');
	});

	test('the model and effort settings reach the coordinator', () => {
		const args = claudeArgs(
			{cwd: '/h', addDirs: [], prompt: 'x', systemPrompt: 'y', agents: {}, permissions: {allow: [], deny: []}, model: 'sonnet', effort: 'medium'},
			{systemPrompt: '/tmp/host.md', agents: '/tmp/agents.json'},
		);
		expect(args.join(' ')).toContain('--model sonnet --effort medium');
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
		// Without a role model the roles run on the coordinator's; with one, every role gets it.
		expect(Object.values(agents).some(agent => 'model' in agent)).toBe(false);
		expect(Object.values(roleAgents(hub, catalog, 'haiku')).every(agent => agent.model === 'haiku')).toBe(true);
		expect(Object.values(roleAgents(hub, catalog, undefined, null, 'high')).every(agent => agent.effort === 'high')).toBe(true);
		expect(Object.values(agents).some(agent => 'effort' in agent)).toBe(false);
		// Subagents do not see the host instructions: each role gets the run's command rules, with the target's path.
		const withTarget = roleAgents(hub, catalog, undefined, '/work/shop');
		expect(withTarget['code-analyst']!.prompt).toContain('git -C /work/shop <command>');
		expect(withTarget['code-analyst']!.prompt).toContain('never with `cat`, `ls`, `grep`');
		expect(agents['code-analyst']!.prompt).not.toContain('git -C');
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

	test('quoted frontmatter values keep Windows backslashes, as the validator reads them', () => {
		const fields = readFrontmatter('---\ntarget_repo: "D:\\new-app\\shop"\ntitle: \'it\'\'s\'\nplan_set: "a \\"b\\""\n---\n');
		expect(fields).toEqual({target_repo: 'D:\\new-app\\shop', title: "it's", plan_set: 'a "b"'});
	});

	test('Allowed paths: directories with a trailing slash, exact files', () => {
		const plan = '- Allowed paths: `src/orders/`, `docs/api.md`, `test/orders.test.ts`.';
		expect(allowedPaths(plan)).toEqual(['src/orders/', 'docs/api.md', 'test/orders.test.ts']);
		expect(outsideAllowed(['src/orders/cancel.ts', 'docs/api.md', 'src/app.ts'], allowedPaths(plan))).toEqual(['src/app.ts']);
		expect(outsideAllowed(['anything'], [])).toEqual([]);
	});
});

describe('run store', () => {
	const before = {hubChanges: [], records: 0, planSets: [], targetChanges: []};

	test('keeps every run of a target repository, newest first; a resumed run updates its own entry', () => {
		const home = tempDir();
		const first = {key: 'k1', savedAt: '2026-10-24T08:00:00Z', kind: 'plan' as const, request: 'Thêm email', sessionId: 's-1', status: 'stopped' as const, questions: [], before};
		const second = {...first, key: 'k2', savedAt: '2026-10-24T09:00:00Z', kind: 'implement' as const, request: 'T01', sessionId: 's-2', status: 'failed' as const};
		saveRun(home, '/w/a', first);
		saveRun(home, '/w/a', second);
		expect(listRuns(home, '/w/a').map(run => run.key)).toEqual(['k2', 'k1']);
		expect(listRuns(home, '/w/b')).toEqual([]);
		saveRun(home, '/w/a', {...first, savedAt: '2026-10-24T10:00:00Z', status: 'done'});
		expect(listRuns(home, '/w/a').map(run => [run.key, run.status])).toEqual([['k1', 'done'], ['k2', 'failed']]);
		expect(listRuns(home, '/w/a').filter(resumable).map(run => run.key)).toEqual(['k2']);
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
		expect(run.state.improvements).toEqual({files: ['.agents/roles/code-analyst.role.md'], state: 'pending', tests: {state: 'pass'}});
		expect(seen).toContain('checking');
		await run.resolveImprovements('commit');
		expect(run.state.status).toBe('done');
		const log = git(hub, 'log', '-1', '--format=%B');
		expect(log).toContain('Pirl-Source: auditor');
		expect(log).toMatch(/Pirl-Record: plan-/);
		expect(git(hub, 'status', '--porcelain')).toBe('');
	});

	test('an improvement that breaks the framework\'s tests cannot be committed', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([
			() => {
				const {planSet} = writePlan(hub, target);
				const recordId = writeRecord(hub, target, planSet);
				// A link to a file that does not exist fails the framework's link test.
				appendFileSync(join(hub, '.agents/roles/code-analyst.role.md'), '\n- See [the missing guide](missing-guide.md).\n');
				return [result('Plan đã sẵn sàng.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: recordId}))];
			},
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email huỷ đơn');
		await run.start();
		expect(run.state.improvements?.tests?.state).toBe('fail');
		await run.resolveImprovements('commit');
		expect(run.state.status).toBe('improvements');
		expect(run.state.improvements?.error).toContain('không commit một framework hỏng');
		expect(git(hub, 'log', '-1', '--format=%s')).not.toContain('Framework improvement');
		await run.resolveImprovements('discard');
		expect(run.state.status).toBe('done');
		expect(git(hub, 'status', '--porcelain')).toBe('');
	});

	test('questions pause the run; answers resume the same session', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([
			() => [usage(), result('Cần quyết định.\n```pirl-questions\n[{"id":"Q1","question":"Gửi email khi admin huỷ?","options":["Có","Không"]}]\n```')],
			() => {
				const {planSet} = writePlan(hub, target);
				writeRecord(hub, target, planSet);
				return [usage(), usage('claude-haiku-5-5'), result('Xong.' + outputsBlock({plan_set: planSet, plan_file: null, report: null, record_id: null}))];
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
		expect(run.state.usage).toMatchObject({calls: 2, requests: 3, inputTokens: 0, cacheWriteTokens: 3000, cacheReadTokens: 27000, outputTokens: 600, models: ['claude-sonnet-5-5', 'claude-haiku-5-5']});
		// Sonnet 5.5: 1k cache writes at $2.50, 9k reads at $0.10, 200 out at $10 per million; Haiku 5.5 a twentieth of that.
		expect(run.state.usage.costUsd).toBeCloseTo(2 * 0.0054 + 0.000315, 6);
	});

	test('exact totals replace the live count; a resumed session\'s earlier totals are taken off', async () => {
		const {hub, target} = await hubAndTarget();
		const totals = (cacheRead: number, cost: number): RunEvent => ({
			type: 'usage-totals',
			models: {'claude-sonnet-5-5': {inputTokens: 10, cacheWriteTokens: 1000, cacheReadTokens: cacheRead, outputTokens: 100, costUsd: cost}},
		});
		const {runner} = fakeRunner([
			() => [usage(), totals(5000, 0.01), result('Cần quyết định.\n```pirl-questions\n[{"id":"Q1","question":"Có?","options":["Có","Không"]}]\n```')],
			// The resumed session reports the first call's tokens again, plus its own.
			() => [usage(), {type: 'usage-totals', models: {'claude-sonnet-5-5': {inputTokens: 20, cacheWriteTokens: 1500, cacheReadTokens: 12000, outputTokens: 250, costUsd: 0.025}}}, result('Xong')],
		]);
		const run = new RunController(deps(hub, target, runner), 1, 'chat', 'Hỏi');
		await run.start();
		expect(run.state.usage).toMatchObject({calls: 1, requests: 1, inputTokens: 10, cacheWriteTokens: 1000, cacheReadTokens: 5000, outputTokens: 100, costUsd: 0.01});
		await run.answer(['Có']);
		expect(run.state.usage).toMatchObject({calls: 2, requests: 2, inputTokens: 20, cacheWriteTokens: 1500, cacheReadTokens: 12000, outputTokens: 250});
		expect(run.state.usage.costUsd).toBeCloseTo(0.025, 6);
		expect(run.persisted().providerTotals?.['claude-sonnet-5-5']?.cacheReadTokens).toBe(12000);
	});

	test('the plan meters are read when the run starts and after each provider call', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => [usage(), result('Xong')]]);
		const meters = [
			[{kind: 'session', label: '5 giờ', percent: 12, resetsAt: null}],
			[{kind: 'session', label: '5 giờ', percent: 19, resetsAt: null}],
		];
		const run = new RunController({...deps(hub, target, runner), logDir: tempDir(), quota: async () => meters.shift() ?? null}, 1, 'chat', 'Hỏi');
		await run.start();
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(run.state.quota.before?.[0]?.percent).toBe(12);
		expect(run.state.quota.after?.[0]?.percent).toBe(19);
		expect(readFileSync(run.state.logFile!, 'utf8')).toMatch(/Token đến giờ: 9000 đọc cache/);
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

	test('stop() before the provider started: no provider is started and the run ends stopped', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner, calls} = fakeRunner([() => new Promise(() => {})]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email');
		const started = run.start();
		run.stop(); // while the snapshot of the Hub and the target is still being taken
		await started;
		expect(calls).toHaveLength(0);
		expect(run.state.status).toBe('stopped');
	});

	test('the log file has every entry, the run its duration, and a refusal reported twice counts once', async () => {
		const {hub, target} = await hubAndTarget();
		const logDir = tempDir();
		let clock = 1_000_000;
		const {runner} = fakeRunner([
			(_call, emit) => {
				emit({type: 'role-start', toolUseId: 'tu-1', role: 'code-analyst', description: 'Trace'});
				for (let i = 0; i < 250; i++) {
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
		expect(run.state.lastAt).toBe(250_000);
		await new Promise(resolve => setTimeout(resolve, 50));
		const file = readFileSync(run.state.logFile!, 'utf8').trim().split('\n');
		expect(file.length).toBeGreaterThan(250);
		expect(file[0]).toMatch(/^00:00 pirl\s+Bắt đầu Chat: Hỏi$/);
		expect(file.some(line => /^\d\d:\d\d code-analyst\s+Đọc file-0\.ts$/.test(line))).toBe(true);
		expect(file.some(line => /code-analyst\s+Đọc file-249\.ts$/.test(line))).toBe(true);
		expect(file.at(-1)).toMatch(/pirl\s+Xong$/);
		expect(formatElapsed(3_725_000)).toBe('1:02:05');
	});

	test('a fault while handling an event is written to the log, and the run still finishes', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => [{type: 'session', sessionId: 's-1'}, {type: 'activity', agent: null, text: 'Đọc'}, result('Xong.')]]);
		const run = new RunController({...deps(hub, target, runner), logDir: tempDir()}, 1, 'chat', 'Hỏi');
		let thrown = false;
		run.subscribe(state => {
			if (state.activity === 'Đọc' && !thrown) {
				thrown = true;
				throw new Error('listener hỏng');
			}
		});
		await run.start();
		expect(run.state.status).toBe('done');
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(readFileSync(run.state.logFile!, 'utf8')).toMatch(/Lỗi nội bộ khi xử lý sự kiện activity: listener hỏng/);
	});

	test('a choice on the improvements that fails is shown on them instead of being thrown', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => [result('Xong.')]]);
		const run = new RunController(deps(hub, target, runner), 1, 'chat', 'Hỏi');
		await run.start();
		run.state = {...run.state, status: 'improvements', improvements: {files: ['AGENTS.md'], state: 'pending', tests: {state: 'pass'}}};
		(run as unknown as {exec: unknown}).exec = async () => {
			throw new Error('git không chạy được');
		};
		await expect(run.resolveImprovements('commit')).resolves.toBeUndefined();
		expect(run.state.improvements).toMatchObject({state: 'pending', error: 'git không chạy được'});
	});

	test('a provider error fails the run with its message', async () => {
		const {hub, target} = await hubAndTarget();
		const {runner} = fakeRunner([() => [{type: 'result', text: 'Credit balance is too low', isError: true, sessionId: 's'}]]);
		const run = new RunController(deps(hub, target, runner), 1, 'plan', 'Email');
		await run.start();
		expect(run.state).toMatchObject({status: 'failed', error: 'Credit balance is too low'});
	});
});
