import {t} from '../core/i18n.js';
import {costUsd} from './pricing.js';
import type {ModelTotals, RunEvent, TokenUsage} from './types.js';

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
			return t(`Đọc ${short(path)}`, `Read ${short(path)}`);
		case 'Edit':
		case 'MultiEdit':
			return t(`Sửa ${short(path)}`, `Edit ${short(path)}`);
		case 'Write':
			return t(`Ghi ${short(path)}`, `Write ${short(path)}`);
		case 'Grep':
			return t(`Tìm "${short(input['pattern'], 40)}"`, `Search "${short(input['pattern'], 40)}"`);
		case 'Glob':
			return t(`Liệt kê ${short(input['pattern'], 60)}`, `List ${short(input['pattern'], 60)}`);
		case 'Bash':
			return t(`Chạy ${short(input['command'])}`, `Run ${short(input['command'])}`);
		case 'TodoWrite':
			return t('Cập nhật danh sách việc', 'Update the to-do list');
		default:
			return name;
	}
}

type Seen = TokenUsage & {cacheWrite1h: number; model: string};
type ParserState = {calls: Map<string, string>; requests: Map<string, Seen>};

/**
 * A parser for one run's stream. It remembers each tool call by id, so a denial, which Claude Code reports
 * with the tool's name only, can say which command was refused; and the tokens of each model request, which
 * Claude Code reports several times while the request streams.
 */
export function createStreamParser(): (line: string) => RunEvent[] {
	const state: ParserState = {calls: new Map(), requests: new Map()};
	return line => parseLine(line, state);
}

/** One line on its own, without the calls seen before it. */
export const parseStreamLine = (line: string) => parseLine(line, {calls: new Map(), requests: new Map()});

/**
 * Tokens of one model request as they stream in, for the live count. A request's usage arrives with its start
 * (input only), its end (`message_delta`, with the output) and its content blocks; each report holds totals so
 * far, so only the growth since the last report is new. Some role requests never show their end in the
 * stream; the result's `modelUsage` gives the exact totals when the provider call ends.
 */
function usageEvent(id: unknown, model: unknown, raw: unknown, requests: Map<string, Seen>): RunEvent | null {
	if (typeof id !== 'string' || !raw || typeof raw !== 'object') return null;
	const usage = raw as Record<string, unknown>;
	const split = (usage['cache_creation'] ?? {}) as Record<string, unknown>;
	const before = requests.get(id);
	const read = (key: string, previous = 0) => Math.max(previous, Number(usage[key] ?? 0) || 0);
	const now: Seen = {
		model: typeof model === 'string' ? model : before?.model ?? 'unknown',
		inputTokens: read('input_tokens', before?.inputTokens),
		cacheWriteTokens: read('cache_creation_input_tokens', before?.cacheWriteTokens),
		cacheReadTokens: read('cache_read_input_tokens', before?.cacheReadTokens),
		outputTokens: read('output_tokens', before?.outputTokens),
		cacheWrite1h: Math.max(before?.cacheWrite1h ?? 0, Number(split['ephemeral_1h_input_tokens'] ?? 0) || 0),
	};
	requests.set(id, now);
	const added = {
		inputTokens: now.inputTokens - (before?.inputTokens ?? 0),
		cacheWriteTokens: now.cacheWriteTokens - (before?.cacheWriteTokens ?? 0),
		cacheReadTokens: now.cacheReadTokens - (before?.cacheReadTokens ?? 0),
		outputTokens: now.outputTokens - (before?.outputTokens ?? 0),
	};
	if (before && added.inputTokens + added.cacheWriteTokens + added.cacheReadTokens + added.outputTokens === 0) return null;
	const cacheWrite1h = now.cacheWrite1h - (before?.cacheWrite1h ?? 0);
	return {type: 'usage', model: now.model, request: !before, costUsd: costUsd(now.model, {...added, cacheWrite1h}), ...added};
}

/** The result's per-model totals: every request of the provider session, the roles' included. */
function usageTotals(data: Record<string, unknown>): RunEvent | null {
	const raw = data['modelUsage'];
	if (!raw || typeof raw !== 'object') return null;
	const models: Record<string, ModelTotals> = {};
	for (const [model, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
		models[model] = {
			inputTokens: Number(value['inputTokens'] ?? 0) || 0,
			cacheWriteTokens: Number(value['cacheCreationInputTokens'] ?? 0) || 0,
			cacheReadTokens: Number(value['cacheReadInputTokens'] ?? 0) || 0,
			outputTokens: Number(value['outputTokens'] ?? 0) || 0,
			costUsd: typeof value['costUSD'] === 'number' ? value['costUSD'] : null,
		};
	}
	return Object.keys(models).length ? {type: 'usage-totals', models} : null;
}

const windowLabel = (kind: string): string | undefined =>
	({five_hour: t('5 giờ', '5 hours'), seven_day: t('Tuần', 'Week'), seven_day_opus: t('Tuần (Opus)', 'Week (Opus)'), seven_day_sonnet: t('Tuần (Sonnet)', 'Week (Sonnet)')})[kind];

/** The plan's usage windows Claude Code reports with each provider call (`rate_limit_event`). */
function quotaEvent(data: Record<string, unknown>): RunEvent | null {
	const info = (data['rate_limit_info'] ?? {}) as Record<string, unknown>;
	const windows = (info['unifiedWindows'] ?? {}) as Record<string, Record<string, unknown>>;
	const entries = Object.entries(windows).filter(([, value]) => typeof value?.['utilization'] === 'number');
	if (entries.length === 0 && typeof info['utilization'] === 'number' && typeof info['rateLimitType'] === 'string') {
		entries.push([info['rateLimitType'], info]);
	}
	if (entries.length === 0) return null;
	return {
		type: 'quota',
		rows: entries.map(([kind, value]) => ({
			kind,
			label: windowLabel(kind) ?? kind,
			percent: (value['utilization'] as number) * 100,
			resetsAt: typeof value['resetsAt'] === 'number' ? new Date(value['resetsAt'] * 1000).toISOString() : null,
		})),
	};
}

const isEvent = (event: RunEvent | null): event is RunEvent => event !== null;

function parseLine(line: string, {calls, requests}: ParserState): RunEvent[] {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return [];
	}
	const type = data['type'];
	if (type === 'stream_event') {
		const event = (data['event'] ?? {}) as Record<string, unknown>;
		const message = (event['message'] ?? {}) as Record<string, unknown>;
		if (event['type'] === 'message_start') return [usageEvent(message['id'], message['model'], message['usage'], requests)].filter(isEvent);
		if (event['type'] === 'message_delta') return [usageEvent(data['api_message_id'], null, event['usage'], requests)].filter(isEvent);
		return [];
	}
	if (type === 'rate_limit_event') return [quotaEvent(data)].filter(isEvent);
	if (type === 'system') {
		const subtype = data['subtype'];
		if (subtype === 'init' && typeof data['session_id'] === 'string') return [{type: 'session', sessionId: data['session_id']}];
		if (subtype === 'api_retry') return [{type: 'retry', attempt: Number(data['attempt'] ?? 0), error: String(data['error'] ?? 'unknown')}];
		if (subtype === 'permission_denied') {
			const id = typeof data['tool_use_id'] === 'string' ? data['tool_use_id'] : null;
			return [{type: 'denied', id, detail: (id && calls.get(id)) || short(data['tool_name'] ?? data['message'] ?? 'tool', 120)}];
		}
		return [];
	}
	if (type === 'result') {
		const denials = Array.isArray(data['permission_denials']) ? (data['permission_denials'] as Array<Record<string, unknown>>) : [];
		return [
			...denials.map(denial => ({
				type: 'denied' as const,
				id: typeof denial['tool_use_id'] === 'string' ? denial['tool_use_id'] : null,
				detail: describeTool(String(denial['tool_name'] ?? ''), (denial['tool_input'] ?? {}) as Record<string, unknown>),
			})),
			...[usageTotals(data)].filter(isEvent),
			{
				type: 'result',
				// A failed run has no `result`; its reasons are in `errors`.
				text: typeof data['result'] === 'string' ? data['result'] : Array.isArray(data['errors']) ? (data['errors'] as unknown[]).map(String).join('; ') : '',
				isError: data['is_error'] === true || (typeof data['subtype'] === 'string' && data['subtype'] !== 'success'),
				sessionId: typeof data['session_id'] === 'string' ? data['session_id'] : null,
			},
		];
	}
	if (type !== 'assistant' && type !== 'user') return [];
	const message = (data['message'] ?? {}) as Record<string, unknown>;
	const blocks: Block[] = Array.isArray(message['content']) ? (message['content'] as Block[]) : [];
	const parent = typeof data['parent_tool_use_id'] === 'string' ? data['parent_tool_use_id'] : null;
	const events: RunEvent[] = [];
	if (type === 'assistant') {
		const usage = usageEvent(message['id'], message['model'], message['usage'], requests);
		if (usage) events.push(usage);
	}
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
				const text = describeTool(block.name, block.input);
				if (block.id) calls.set(block.id, text);
				events.push({type: 'activity', agent: parent, text});
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
