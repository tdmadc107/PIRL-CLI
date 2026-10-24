import {describe, expect, test} from 'vitest';
import {dispatch} from '../src/commands/dispatch.js';
import {COMMANDS, parseInput, suggestCommands} from '../src/commands/registry.js';
import type {TargetRepo} from '../src/core/targetRepo.js';

const repo: TargetRepo = {kind: 'git', root: '/work/shop-web', name: 'shop-web', branch: 'main'};
const noRepo: TargetRepo = {kind: 'none', cwd: '/tmp', reason: 'Thư mục hiện tại không nằm trong git repo'};

describe('command list', () => {
	test('holds the confirmed 12 commands plus /copy', () => {
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
			'copy',
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
		expect(suggestCommands('/p').map(c => c.name)).toEqual(['pirl-plan', 'pirl-implement', 'pirl-review', 'plans', 'copy', 'help']);
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

	test('a layer with a request starts exactly that layer', () => {
		expect(run('/pirl-plan Thêm email')).toEqual([{type: 'run', kind: 'plan', request: 'Thêm email'}]);
		expect(run('/pirl-implement T01')).toEqual([{type: 'run', kind: 'implement', request: 'T01'}]);
		expect(run('/pirl-review T01')).toEqual([{type: 'run', kind: 'review', request: 'T01'}]);
	});

	test('management commands open their panels or act on the session', () => {
		expect(run('/help')).toEqual([{type: 'overlay', overlay: 'help'}]);
		expect(run('/doctor')).toEqual([{type: 'overlay', overlay: 'doctor'}, {type: 'doctor'}]);
		expect(run('/settings')).toEqual([{type: 'overlay', overlay: 'settings'}]);
		expect(run('/framework')).toEqual([{type: 'overlay', overlay: 'framework'}]);
		expect(run('/clear')).toEqual([{type: 'clear'}]);
		expect(run('/exit')).toEqual([{type: 'exit'}]);
		expect(run('/resume')).toEqual([{type: 'resume'}]);
		expect(run('/plans')).toEqual([{type: 'overlay', overlay: 'plans'}]);
		expect(run('/records')).toEqual([{type: 'overlay', overlay: 'records'}]);
		expect(run('/copy')).toEqual([{type: 'copy'}]);
	});

	test('unknown commands get a note; free text goes to the coordinator as chat, even outside a repo', () => {
		expect(run('/deploy')).toEqual([expect.objectContaining({tone: 'error', text: 'Không có lệnh /deploy.'})]);
		expect(run('Plan T01 phụ thuộc gì?')).toEqual([{type: 'run', kind: 'chat', request: 'Plan T01 phụ thuộc gì?'}]);
		expect(run('Giải thích PIRL', noRepo)).toEqual([{type: 'run', kind: 'chat', request: 'Giải thích PIRL'}]);
		expect(run('')).toEqual([]);
	});
});
