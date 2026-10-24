import type {RunEvent} from './types.js';

/**
 * Turns one line of `claude -p --output-format stream-json --verbose` into run events.
 * Subagents are started with the Agent tool (named Task before Claude Code 2.1.63); their own messages
 * carry `parent_tool_use_id`, the id of that Agent call, which is how activity is attributed to a role.
 */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

type Block = {type?: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; tool_use_id?: string; is_error?: boolean};

const short = (value: unknown, max = 80) => {
	const text = String(value ?? '').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A plain-language line for one tool call, shown as the role's latest activity. */
export function describeTool(name: string, input: Record<string, unknown> = {}): string {
	const path = input['file_path'] ?? input['path'] ?? input['notebook_path'];
	switch (name) {
		case 'Read':
			return `Đọc ${short(path)}`;
		case 'Edit':
		case 'MultiEdit':
			return `Sửa ${short(path)}`;
		case 'Write':
			return `Ghi ${short(path)}`;
		case 'Grep':
			return `Tìm "${short(input['pattern'], 40)}"`;
		case 'Glob':
			return `Liệt kê ${short(input['pattern'], 60)}`;
		case 'Bash':
			return `Chạy ${short(input['command'])}`;
		case 'TodoWrite':
			return 'Cập nhật danh sách việc';
		default:
			return name;
	}
}

export function parseStreamLine(line: string): RunEvent[] {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return [];
	}
	const type = data['type'];
	if (type === 'system') {
		const subtype = data['subtype'];
		if (subtype === 'init' && typeof data['session_id'] === 'string') return [{type: 'session', sessionId: data['session_id']}];
		if (subtype === 'api_retry') return [{type: 'retry', attempt: Number(data['attempt'] ?? 0), error: String(data['error'] ?? 'unknown')}];
		if (subtype === 'permission_denied') return [{type: 'denied', detail: short(data['tool_name'] ?? data['message'] ?? JSON.stringify(data), 120)}];
		return [];
	}
	if (type === 'result') {
		const usage = (data['usage'] ?? {}) as Record<string, unknown>;
		const denials = Array.isArray(data['permission_denials']) ? (data['permission_denials'] as Array<Record<string, unknown>>) : [];
		return [
			...denials.map(denial => ({type: 'denied' as const, detail: describeTool(String(denial['tool_name'] ?? ''), (denial['tool_input'] ?? {}) as Record<string, unknown>)})),
			{
				type: 'result',
				// A failed run has no `result`; its reasons are in `errors`.
				text: typeof data['result'] === 'string' ? data['result'] : Array.isArray(data['errors']) ? (data['errors'] as unknown[]).map(String).join('; ') : '',
				isError: data['is_error'] === true || (typeof data['subtype'] === 'string' && data['subtype'] !== 'success'),
				sessionId: typeof data['session_id'] === 'string' ? data['session_id'] : null,
				usage: {
					inputTokens: Number(usage['input_tokens'] ?? 0) + Number(usage['cache_read_input_tokens'] ?? 0) + Number(usage['cache_creation_input_tokens'] ?? 0),
					outputTokens: Number(usage['output_tokens'] ?? 0),
				},
			},
		];
	}
	if (type !== 'assistant' && type !== 'user') return [];
	const message = (data['message'] ?? {}) as {content?: unknown};
	const blocks: Block[] = Array.isArray(message.content) ? (message.content as Block[]) : [];
	const parent = typeof data['parent_tool_use_id'] === 'string' ? data['parent_tool_use_id'] : null;
	const events: RunEvent[] = [];
	for (const block of blocks) {
		if (type === 'assistant' && block.type === 'tool_use' && block.name) {
			if (SPAWN_TOOLS.has(block.name) && block.id) {
				events.push({
					type: 'role-start',
					toolUseId: block.id,
					role: String(block.input?.['subagent_type'] ?? 'general-purpose'),
					description: short(block.input?.['description'] ?? '', 100),
				});
			} else {
				events.push({type: 'activity', agent: parent, text: describeTool(block.name, block.input)});
			}
		} else if (type === 'assistant' && block.type === 'text' && block.text && parent === null) {
			events.push({type: 'text', text: block.text});
		} else if (type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
			// Only the end of a subagent matters; other tool results are left out.
			events.push({type: 'role-end', toolUseId: block.tool_use_id, ok: block.is_error !== true});
		}
	}
	return events;
}
