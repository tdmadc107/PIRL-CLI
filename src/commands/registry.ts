/** The confirmed command list (proposal section 6). Every command typed in the TUI comes from here. */
export type CommandGroup = 'Layer' | 'Run' | 'Tra cứu' | 'Cấu hình' | 'Framework' | 'Phiên';

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
	| 'clear'
	| 'help'
	| 'exit';

export type CommandSpec = {
	name: CommandName;
	group: CommandGroup;
	summary: string;
	/** Whether the text after the command name is the request. */
	takesRequest: boolean;
};

export const COMMANDS: readonly CommandSpec[] = [
	{name: 'pirl-plan', group: 'Layer', summary: 'Tạo hoặc điều chỉnh Plan', takesRequest: true},
	{name: 'pirl-implement', group: 'Layer', summary: 'Thực hiện một task của Plan, hoặc sửa theo report', takesRequest: true},
	{name: 'pirl-review', group: 'Layer', summary: 'Review kết quả implement của một task', takesRequest: true},
	{name: 'resume', group: 'Run', summary: 'Chạy tiếp run bị dừng', takesRequest: false},
	{name: 'plans', group: 'Tra cứu', summary: 'Danh sách Plan, task, report của repo này', takesRequest: false},
	{name: 'records', group: 'Tra cứu', summary: 'Tra cứu record tự cải tiến', takesRequest: false},
	{name: 'settings', group: 'Cấu hình', summary: 'Provider, giao diện, số role chạy song song', takesRequest: false},
	{name: 'doctor', group: 'Cấu hình', summary: 'Kiểm tra provider, Python, Git, Hub', takesRequest: false},
	{name: 'framework', group: 'Framework', summary: 'Phiên bản framework, cải tiến cục bộ, cập nhật', takesRequest: false},
	{name: 'clear', group: 'Phiên', summary: 'Xoá khung chat, bắt đầu hội thoại mới', takesRequest: false},
	{name: 'help', group: 'Phiên', summary: 'Danh sách lệnh và phím tắt', takesRequest: false},
	{name: 'exit', group: 'Phiên', summary: 'Thoát PIRL', takesRequest: false},
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
