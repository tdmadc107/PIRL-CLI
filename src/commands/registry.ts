import {t} from '../core/i18n.js';

/** The confirmed command list (proposal section 6), plus /copy. Every command typed in the TUI comes from here. */
export type CommandGroup = 'layer' | 'run' | 'lookup' | 'config' | 'framework' | 'session';

export const groupLabel = (group: CommandGroup) =>
	({layer: 'Layer', run: 'Run', lookup: t('Tra cứu', 'Lookup'), config: t('Cấu hình', 'Configuration'), framework: 'Framework', session: t('Phiên', 'Session')})[group];

export type CommandName =
	| 'pirl-plan'
	| 'pirl-implement'
	| 'pirl-review'
	| 'resume'
	| 'plans'
	| 'records'
	| 'settings'
	| 'doctor'
	| 'framework'
	| 'copy'
	| 'clear'
	| 'help'
	| 'exit';

export type CommandSpec = {
	name: CommandName;
	group: CommandGroup;
	/** Read when shown, so it follows the language chosen in /settings. */
	summary: () => string;
	/** Whether the text after the command name is the request. */
	takesRequest: boolean;
};

export const COMMANDS: readonly CommandSpec[] = [
	{name: 'pirl-plan', group: 'layer', summary: () => t('Tạo hoặc điều chỉnh Plan', 'Create or adjust a Plan'), takesRequest: true},
	{name: 'pirl-implement', group: 'layer', summary: () => t('Thực hiện một task của Plan, hoặc sửa theo report', 'Implement a Plan task, or fix per a report'), takesRequest: true},
	{name: 'pirl-review', group: 'layer', summary: () => t('Review kết quả implement của một task', 'Review the implementation of a task'), takesRequest: true},
	{name: 'resume', group: 'run', summary: () => t('Chạy tiếp run bị dừng', 'Resume a stopped run'), takesRequest: false},
	{name: 'plans', group: 'lookup', summary: () => t('Danh sách Plan, task, report của repo này', 'Plans, tasks and reports of this repository'), takesRequest: false},
	{name: 'records', group: 'lookup', summary: () => t('Tra cứu record tự cải tiến', 'Browse the self-improvement records'), takesRequest: false},
	{name: 'settings', group: 'config', summary: () => t('Ngôn ngữ, provider, giao diện, số role chạy song song', 'Language, provider, appearance, parallel roles'), takesRequest: false},
	{name: 'doctor', group: 'config', summary: () => t('Kiểm tra provider, Python, Git, Hub', 'Check the provider, Python, Git, Hub'), takesRequest: false},
	{name: 'framework', group: 'framework', summary: () => t('Phiên bản framework, cải tiến cục bộ, cập nhật', 'Framework version, local improvements, updates'), takesRequest: false},
	{name: 'copy', group: 'session', summary: () => t('Copy câu trả lời gần nhất của PIRL', 'Copy the latest PIRL reply'), takesRequest: false},
	{name: 'clear', group: 'session', summary: () => t('Xoá khung chat, bắt đầu hội thoại mới', 'Clear the chat and start a new conversation'), takesRequest: false},
	{name: 'help', group: 'session', summary: () => t('Danh sách lệnh và phím tắt', 'Commands and shortcuts'), takesRequest: false},
	{name: 'exit', group: 'session', summary: () => t('Thoát PIRL', 'Quit PIRL'), takesRequest: false},
];

export const commandUsage = (spec: CommandSpec) => `/${spec.name}${spec.takesRequest ? ' <request>' : ''}`;

export type ParsedInput =
	| {kind: 'empty'}
	| {kind: 'command'; spec: CommandSpec; request: string}
	| {kind: 'unknown-command'; name: string}
	| {kind: 'text'; text: string};

export function parseInput(raw: string): ParsedInput {
	const text = raw.trim();
	if (!text) return {kind: 'empty'};
	if (!text.startsWith('/')) return {kind: 'text', text};
	const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text)!;
	const name = match[1]!.toLowerCase();
	const spec = COMMANDS.find(command => command.name === name);
	return spec ? {kind: 'command', spec, request: match[2]!.trim()} : {kind: 'unknown-command', name};
}

/**
 * Commands offered while the user types a command name: input starting with "/" and no space yet.
 * Prefix matches come first, then commands that contain the typed text elsewhere (so "/plan" finds /pirl-plan).
 */
export function suggestCommands(input: string): CommandSpec[] {
	if (!input.startsWith('/') || /\s/.test(input)) return [];
	const typed = input.slice(1).toLowerCase();
	const prefix = COMMANDS.filter(command => command.name.startsWith(typed));
	const inside = COMMANDS.filter(command => !command.name.startsWith(typed) && command.name.includes(typed));
	return [...prefix, ...inside];
}
