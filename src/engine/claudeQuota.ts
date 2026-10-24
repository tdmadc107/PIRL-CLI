import spawn from 'cross-spawn';
import type {QuotaRow} from './types.js';

/**
 * The plan's usage meters (the 5-hour session, the weekly limits) as Claude Code's `/usage` reports them.
 * `claude -p` runs `/usage` locally, without a model request, and puts the meters in the `usage_report` of its
 * reply. Reading them before and after a run shows how much of each limit the run took. The meters count the
 * whole account, so other Claude Code sessions and claude.ai chats at the same time show up in the difference.
 */
export type {QuotaRow};

const KIND_LABELS: Record<string, string> = {session: '5 giờ', weekly_all: 'Tuần'};

function labelOf(row: Record<string, unknown>): string {
	const kind = String(row['kind'] ?? '');
	const scope = (row['scope'] ?? {}) as Record<string, {display_name?: string} | null | undefined>;
	const name = scope['model']?.display_name ?? scope['surface']?.display_name;
	if (KIND_LABELS[kind]) return KIND_LABELS[kind];
	if (String(row['group'] ?? '') === 'weekly' || kind.startsWith('weekly')) return name ? `Tuần (${name})` : 'Tuần';
	return name ?? kind;
}

/** The meters in one stream-json line, or null when the line has none (an API key login has no plan meters). */
export function parseQuotaLine(line: string): QuotaRow[] | null {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (data['type'] !== 'assistant') return null;
	const message = (data['message'] ?? {}) as Record<string, unknown>;
	const report = (data['usage_report'] ?? message['usage_report']) as {rate_limits?: {limits?: unknown} | null} | undefined;
	const limits = report?.rate_limits?.limits;
	if (!Array.isArray(limits)) return null;
	return (limits as Array<Record<string, unknown>>)
		.filter(row => typeof row['percent'] === 'number')
		.map(row => ({kind: String(row['kind'] ?? ''), label: labelOf(row), percent: row['percent'] as number, resetsAt: typeof row['resets_at'] === 'string' ? row['resets_at'] : null}));
}

/** Null when the meters cannot be read: no subscription, an old Claude Code, a rate-limited usage endpoint. */
export function readClaudeQuota(command = 'claude', cwd?: string, timeoutMs = 20_000): Promise<QuotaRow[] | null> {
	return new Promise(resolve => {
		let rows: QuotaRow[] | null = null;
		let buffer = '';
		const child = spawn(command, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
			cwd,
			stdio: ['pipe', 'pipe', 'ignore'],
			windowsHide: true,
		});
		const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
		child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) rows = parseQuotaLine(line) ?? rows;
		});
		child.once('error', () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.once('close', () => {
			clearTimeout(timer);
			resolve(parseQuotaLine(buffer) ?? rows);
		});
		child.stdin?.on('error', () => {});
		child.stdin?.end('/usage');
	});
}
