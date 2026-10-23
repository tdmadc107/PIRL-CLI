import {describe, expect, test} from 'vitest';
import {dispatch} from '../src/commands/dispatch.js';
import {COMMANDS, parseInput, suggestCommands} from '../src/commands/registry.js';
import type {TargetRepo} from '../src/core/targetRepo.js';

const repo: TargetRepo = {kind: 'git', root: '/work/shop-web', name: 'shop-web', branch: 'main'};
const noRepo: TargetRepo = {kind: 'none', cwd: '/tmp', reason: 'Thư mục hiện tại không nằm trong git repo'};

describe('command list', () => {
	test('holds exactly the confirmed 12 commands', () => {
		expect(COMMANDS.map(c => c.name)).toEqual([
			'pirl-plan',
			'pirl-implement',
			'pirl-review',
			'resume',
			'plans',
			'records',
			'settings',
			'doctor',
			'framework',
			'clear',
			'help',
			'exit',
		]);
	});

	test('only the three layer commands take a request', () => {
		expect(COMMANDS.filter(c => c.takesRequest).map(c => c.name)).toEqual(['pirl-plan', 'pirl-implement', 'pirl-review']);
	});
});

describe('parseInput', () => {
	test('splits the command from a multi-line request and trims it', () => {
		const parsed = parseInput('  /pirl-plan  Khách nhận email\nkhi đơn bị huỷ  ');
		expect(parsed).toMatchObject({kind: 'command', request: 'Khách nhận email\nkhi đơn bị huỷ'});
		expect(parsed.kind === 'command' && parsed.spec.name).toBe('pirl-plan');
	});

	test('command names ignore case', () => {
		expect(parseInput('/HELP')).toMatchObject({kind: 'command', spec: {name: 'help'}});
	});

	test('text without a leading slash is a request for the coordinator', () => {
		expect(parseInput('T02 phụ thuộc gì?')).toEqual({kind: 'text', text: 'T02 phụ thuộc gì?'});
	});

	test('blank input and unknown commands', () => {
		expect(parseInput('   ')).toEqual({kind: 'empty'});
		expect(parseInput('/deploy now')).toEqual({kind: 'unknown-command', name: 'deploy'});
	});
});

describe('suggestCommands', () => {
	test('offers prefix matches first, then commands containing the text', () => {
		expect(suggestCommands('/p').map(c => c.name)).toEqual(['pirl-plan', 'pirl-implement', 'pirl-review', 'plans', 'help']);
		expect(suggestCommands('/plan').map(c => c.name)).toEqual(['plans', 'pirl-plan']);
		expect(suggestCommands('/').length).toBe(COMMANDS.length);
	});

	test('closes once the request starts or for plain text', () => {
		expect(suggestCommands('/pirl-plan ')).toEqual([]);
		expect(suggestCommands('pirl')).toEqual([]);
		expect(suggestCommands('/zzz')).toEqual([]);
	});
});

describe('dispatch', () => {
	const run = (input: string, target: TargetRepo = repo) => dispatch(parseInput(input), {target});

	test('layers are locked outside a git repository', () => {
		const [effect] = run('/pirl-plan Thêm email', noRepo);
		expect(effect).toMatchObject({type: 'note', tone: 'error'});
		expect(effect?.type === 'note' && effect.text).toContain('Layer Plan bị khoá');
	});

	test('a layer command without a request shows its syntax', () => {
		const [effect] = run('/pirl-review');
		expect(effect).toMatchObject({type: 'note', tone: 'warning', hint: 'Cú pháp: /pirl-review <request>'});
	});

	test('a layer with a request reports the phase it arrives in, and never opens another layer', () => {
		expect(run('/pirl-plan Thêm email')).toEqual([expect.objectContaining({type: 'note', tone: 'info', text: expect.stringContaining('giai đoạn 1')})]);
		expect(run('/pirl-implement T01')).toEqual([expect.objectContaining({text: expect.stringContaining('giai đoạn 2')})]);
	});

	test('management commands open their panels or act on the session', () => {
		expect(run('/help')).toEqual([{type: 'overlay', overlay: 'help'}]);
		expect(run('/doctor')).toEqual([{type: 'overlay', overlay: 'doctor'}, {type: 'doctor'}]);
		expect(run('/settings')).toEqual([{type: 'overlay', overlay: 'settings'}]);
		expect(run('/framework')).toEqual([{type: 'overlay', overlay: 'framework'}]);
		expect(run('/clear')).toEqual([{type: 'clear'}]);
		expect(run('/exit')).toEqual([{type: 'exit'}]);
		expect(run('/resume')).toEqual([expect.objectContaining({text: 'Không có run nào đang dở.'})]);
	});

	test('unknown commands and free text get a note', () => {
		expect(run('/deploy')).toEqual([expect.objectContaining({tone: 'error', text: 'Không có lệnh /deploy.'})]);
		expect(run('Plan T01 phụ thuộc gì?')).toEqual([expect.objectContaining({tone: 'info'})]);
		expect(run('')).toEqual([]);
	});
});
