import {basename} from 'node:path';
import {formatElapsed, type RunState, type RunStatus} from '../engine/run.js';
import {displayPath} from '../core/paths.js';
import {LAYER_LABELS, totalTokens, type Question, type QuotaRow, type Usage} from '../engine/types.js';
import {blank, hanging, type Line, type Span} from './lines.js';
import {padEnd, truncateEnd, width} from './text.js';
import {ROLE_IDS, type RoleId, type Theme} from './theme.js';

/** A decision the TUI is waiting for: a question from the coordinator, or what to do with framework improvements. */
export type Interaction =
	| {kind: 'question'; runId: number; index: number; total: number; question: Question; selected: number}
	| {kind: 'improvements'; runId: number; selected: number};

export const IMPROVEMENT_CHOICES = [
	{id: 'commit', label: 'Commit vào Hub'},
	{id: 'keep', label: 'Giữ, chưa commit'},
	{id: 'discard', label: 'Bỏ cải tiến'},
] as const;

export const STATUS_LABELS: Record<RunStatus, string> = {
	running: 'đang chạy',
	waiting: 'cần quyết định',
	checking: 'đang kiểm tra kết quả',
	improvements: 'chờ quyết định về cải tiến',
	done: 'xong',
	failed: 'lỗi',
	stopped: 'đã dừng',
};

const isRole = (id: string): id is RoleId => (ROLE_IDS as readonly string[]).includes(id);

/** A light Markdown layout for replies: headings, bullets, numbered lists and code blocks. */
export function markdownLines(text: string, columns: number, indent = 0): Line[] {
	const pad: Span = {text: ' '.repeat(indent)};
	const lines: Line[] = [];
	let code = false;
	for (const raw of text.split('\n')) {
		if (/^\s*```/.test(raw)) {
			code = !code;
			continue;
		}
		if (code) {
			lines.push(...hanging([pad, {text: '  '}], raw || ' ', columns, {dim: true}));
			continue;
		}
		const line = raw.replace(/\*\*(.+?)\*\*/g, '$1');
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
		const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
		if (heading) lines.push(...hanging([pad], heading[1]!, columns, {bold: true}));
		else if (bullet) lines.push(...hanging([pad, {text: `${bullet[1]}• `}], bullet[2]!, columns));
		else if (numbered) lines.push(...hanging([pad, {text: `${numbered[1]}${numbered[2]} `}], numbered[3]!, columns));
		else if (line.trim() === '') lines.push(blank);
		else lines.push(...hanging([pad], line, columns));
	}
	return lines;
}

function choiceLines(options: string[], selected: number, recommended: number | undefined, columns: number, theme: Theme): Line[] {
	return options.flatMap((option, index) => {
		const active = index === selected;
		const prefix: Span[] = [{text: '    '}, {text: active ? `${theme.glyphs.pointer} ` : '  ', color: 'accent'}, {text: `${index + 1}. `, color: active ? 'accent' : undefined, bold: active}];
		const label = index === recommended ? `${option} (khuyến nghị)` : option;
		return hanging(prefix, label, columns, active ? {color: 'accent', bold: true} : {});
	});
}

/** The next layer, as a command for the user to type; PIRL never opens it by itself. */
export function nextStep(run: RunState): string | null {
	if (run.status !== 'done') return null;
	if (run.kind === 'plan' && run.outputs.planSet) return `/pirl-implement T01 của ${basename(run.outputs.planSet)}`;
	if (run.kind === 'implement' && run.outputs.planFile) return `/pirl-review ${basename(run.outputs.planFile)}`;
	if (run.kind === 'review' && run.outputs.report) return `/pirl-implement Sửa theo report ${basename(run.outputs.report)} (nếu Review là FAIL)`;
	return null;
}

/**
 * What moves while a run works: the spinner frame and the clock. Kept apart from the run's state so the
 * transcript cache can tell "only the spinner changed" from "the run changed".
 */
export type Live = {motion: boolean};

/** The spinner cell: turning with motion on, a still glyph with motion off. */
export const spinnerSpan = (theme: Theme, motion: boolean, extra: Partial<Span> = {}): Span =>
	motion ? {text: theme.glyphs.spinner[0]!, live: {kind: 'spinner', frames: theme.glyphs.spinner}, ...extra} : {text: theme.glyphs.running, ...extra};

/** Time since `since`, kept current by the ticker. */
export const clockSpan = (since: number): Span => ({text: '00:00', dim: true, live: {kind: 'clock', since}});

export const isActive = (run: RunState) => run.status === 'running' || run.status === 'checking';

export function runLines(run: RunState, columns: number, theme: Theme, interaction: Interaction | null, live?: Live): Line[] {
	const g = theme.glyphs;
	const lines: Line[] = [];
	const active = isActive(run);
	const motion = live?.motion ?? false;
	const statusTone = run.status === 'failed' ? 'danger' : run.status === 'done' ? 'success' : run.status === 'stopped' ? 'muted' : active ? 'accent' : 'warning';
	const statusGlyph = run.status === 'done' ? g.ok : run.status === 'failed' ? g.fail : run.status === 'stopped' ? g.pending : run.status === 'waiting' || run.status === 'improvements' ? g.warn : null;
	const glyph: Span[] = [statusGlyph ? {text: statusGlyph, color: statusTone} : spinnerSpan(theme, motion, {color: statusTone}), {text: ' '}];
	const clock: Span[] = active ? [{text: ` ${g.sep} `, dim: true}, clockSpan(run.startedAt)] : [];
	if (run.kind !== 'chat') {
		lines.push([
			...glyph,
			{text: LAYER_LABELS[run.kind], bold: true, color: 'accent'},
			{text: ` ${g.sep} ${STATUS_LABELS[run.status]}`, color: statusTone},
			...clock,
		]);
	} else if (run.status !== 'done') {
		lines.push([...glyph, {text: `PIRL ${g.sep} ${STATUS_LABELS[run.status]}`, color: statusTone}, ...clock]);
	}

	for (const role of run.roles) {
		const tone = role.state === 'failed' ? 'danger' : role.state === 'done' ? 'success' : ('accent' as const);
		const mark: Span = role.state === 'running' ? spinnerSpan(theme, motion, {color: tone}) : {text: role.state === 'done' ? g.ok : g.fail, color: tone};
		const roleSpan: Span = isRole(role.role) ? {text: role.role, role: role.role, bold: true} : {text: role.role, bold: true};
		lines.push(...hanging([{text: '  '}, mark, {text: ' '}, roleSpan, {text: '  '}], role.description, columns, {dim: true}));
		if (role.state === 'running' && role.activity) lines.push(...hanging([{text: '      '}], role.activity, columns, {dim: true}));
	}
	if (active && run.activity) {
		lines.push(...hanging([{text: '  '}, spinnerSpan(theme, motion, {color: 'accent'}), {text: ' '}, {text: 'coordinator  ', dim: true}], run.activity, columns, {dim: true}));
	}

	if (run.reply && (run.status !== 'running' || run.kind === 'chat')) {
		if (lines.length > 0) lines.push(blank);
		lines.push(...markdownLines(run.reply, columns, run.kind === 'chat' ? 0 : 2));
	}

	if (interaction?.kind === 'question' && interaction.runId === run.id) {
		const q = interaction.question;
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: `? `, color: 'warning', bold: true}, {text: `Cần quyết định (${interaction.index + 1}/${interaction.total}): `, color: 'warning'}], q.question, columns, {bold: true}));
		lines.push(...choiceLines(q.options, interaction.selected, q.recommended, columns, theme));
		const how = q.options.length > 0 ? `Chọn bằng ${g.upDown} rồi Enter, gõ số rồi Enter, hoặc nhập câu trả lời khác.` : 'Nhập câu trả lời rồi Enter.';
		lines.push(...hanging([{text: '    '}], how, columns, {dim: true}));
	}

	const checks = [
		run.checks.validator && {label: 'Validator', ...run.checks.validator},
		run.checks.record && {label: 'Record tự đánh giá', ...run.checks.record},
		run.checks.paths && {label: 'Allowed paths', ...run.checks.paths},
	].filter(Boolean) as Array<{label: string; state: 'pass' | 'fail' | 'skipped'; detail?: string}>;
	if (checks.length > 0) {
		lines.push(blank);
		for (const check of checks) {
			const glyph = check.state === 'pass' ? g.ok : check.state === 'fail' ? g.fail : g.pending;
			const tone = check.state === 'pass' ? 'success' : check.state === 'fail' ? 'danger' : 'muted';
			lines.push(...hanging([{text: '  '}, {text: `${glyph} `, color: tone}, {text: `${check.label}: `, bold: true}], check.detail ?? '', columns, {dim: check.state !== 'fail'}));
		}
	}

	if (run.denials.length > 0) {
		// Refusals are the run's permissions working; the run goes on, and the coordinator reports what it could not do.
		const shown = run.denials.slice(0, 3).join('; ');
		const more = run.denials.length > 3 ? ` (và ${run.denials.length - 3} lệnh khác, xem nhật ký)` : '';
		lines.push(...hanging([{text: '  '}, {text: `${g.info} `, color: 'muted'}], `Đã chặn ${run.denials.length} lệnh ngoài quyền của run, run vẫn tiếp tục: ${shown}${more}`, columns, {dim: true}));
	}

	const improvements = run.improvements;
	if (improvements) {
		lines.push(blank);
		const title =
			improvements.state === 'pending'
				? `Tự cải tiến: ${improvements.files.length} file framework đã sửa`
				: improvements.state === 'committed'
					? `Đã commit ${improvements.files.length} file cải tiến vào Hub`
					: improvements.state === 'kept'
						? `Giữ ${improvements.files.length} file cải tiến, chưa commit`
						: `Đã bỏ ${improvements.files.length} file cải tiến`;
		lines.push(...hanging([{text: '  '}, {text: `${improvements.state === 'pending' ? g.warn : g.ok} `, color: improvements.state === 'pending' ? 'warning' : 'success'}], title, columns, {bold: true}));
		if (improvements.state === 'pending') {
			for (const file of improvements.files) lines.push(...hanging([{text: '    '}], file, columns, {dim: true}));
			const tests = improvements.tests;
			if (tests?.state === 'pass') lines.push(...hanging([{text: '    '}, {text: `${g.ok} `, color: 'success'}], 'Test của framework: PASS', columns));
			if (tests?.state === 'skipped') lines.push(...hanging([{text: '    '}, {text: `${g.warn} `, color: 'warning'}], `Test của framework: bỏ qua (${tests.detail ?? ''})`, columns));
			if (tests?.state === 'fail') {
				lines.push(...hanging([{text: '    '}, {text: `${g.fail} `, color: 'danger'}], 'Test của framework: FAIL. Cải tiến này làm hỏng framework nên không được commit; nên bỏ.', columns, {color: 'danger'}));
				for (const line of (tests.detail ?? '').split('\n').slice(0, 5)) lines.push(...hanging([{text: '      '}], line, columns, {dim: true}));
			}
			if (improvements.error) lines.push(...hanging([{text: '    '}], `Lỗi: ${improvements.error}`, columns, {color: 'danger'}));
			if (interaction?.kind === 'improvements' && interaction.runId === run.id) {
				lines.push(...hanging([{text: '    '}], 'Commit cải tiến này vào Hub?', columns));
				const labels = IMPROVEMENT_CHOICES.map(choice => (choice.id === 'commit' && tests?.state === 'fail' ? `${choice.label} (bị chặn: test lỗi)` : choice.label));
				lines.push(...choiceLines(labels, interaction.selected, tests?.state === 'fail' ? 2 : 0, columns, theme));
			}
		}
	}

	if (run.error) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: `${g.fail} `, color: 'danger'}], run.error, columns, {color: 'danger'}));
		lines.push(...hanging([{text: '    '}], 'Gõ /resume để chạy tiếp từ chỗ dừng.', columns, {dim: true}));
	}
	if (run.status === 'stopped') {
		// Stopped before the provider started: there is no provider session to continue.
		const next = run.sessionId ? 'Đã dừng. Gõ /resume để chạy tiếp.' : 'Đã dừng trước khi provider bắt đầu. Gõ lại lệnh để chạy.';
		lines.push(...hanging([{text: '    '}], next, columns, {dim: true}));
	}

	if (run.suggestion) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: `${g.info} `, color: 'accent'}], `Yêu cầu này là một layer. Lệnh đã được điền sẵn vào ô nhập: ${run.suggestion}`, columns));
	}
	const next = nextStep(run);
	if (next) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: 'Bước tiếp theo, khi bạn muốn: ', dim: true}], next, columns, {color: 'accent'}));
	}
	if (run.usage.calls > 0 && !active) {
		const took = run.log.length > 0 ? ` ${g.sep} ${formatElapsed(run.log.at(-1)!.at)}` : '';
		lines.push([{text: `  ${run.usage.calls} lượt gọi${took}`, dim: true}]);
		for (const text of usageDetail(run.usage, g.sep)) lines.push(...hanging([{text: '  '}], text, columns, {dim: true}));
		const quota = quotaText(run.quota, g.sep, g.arrow);
		if (quota) lines.push(...hanging([{text: '  '}], quota, columns, {dim: true}));
	}
	if (run.logFile && !active) lines.push(...hanging([{text: '  '}], `Nhật ký đầy đủ: ${displayPath(run.logFile)}`, columns, {dim: true}));
	return lines;
}

/** 950 → "950", 12_345 → "12k", 1_209_213 → "1,21M": token counts at a glance. */
export function compactTokens(count: number): string {
	const format = (value: number, digits: number) => value.toLocaleString('vi-VN', {maximumFractionDigits: digits});
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${format(count / 1000, count < 10_000 ? 1 : 0)}k`;
	return `${format(count / 1_000_000, 2)}M`;
}

export const costText = (usd: number | null) => (usd === null ? null : `≈ $${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`);

/** The tokens of a run by kind, then what they come to at the Claude API list price, with the models used. */
export function usageDetail(usage: Usage, sep: string): string[] {
	const total = totalTokens(usage);
	if (total === 0) return [];
	const parts = [
		`${compactTokens(usage.cacheReadTokens)} đọc cache`,
		`${compactTokens(usage.cacheWriteTokens)} ghi cache`,
		`${compactTokens(usage.outputTokens)} ra`,
		`${compactTokens(usage.inputTokens)} vào mới`,
	];
	const cost = costText(usage.costUsd);
	const models = usage.models.map(model => model.replace(/^claude-/, '')).join(', ');
	return [`${compactTokens(total)} token: ${parts.join(` ${sep} `)}`, [cost && `${cost} theo giá API`, models].filter(Boolean).join(` ${sep} `)].filter(Boolean);
}

/**
 * How much of each plan limit the run took: "Hạn mức: 5 giờ 12% → 19% (+7)". The meters count the whole
 * account, so other sessions at the same time are in the difference too.
 */
export function quotaText(quota: RunState['quota'], sep: string, arrow: string): string | null {
	const {before, after} = quota;
	if (!after) return null;
	const rows = after.map(row => {
		const start = before?.find(item => item.label === row.label);
		if (!start) return `${row.label} ${Math.round(row.percent)}%`;
		const added = Math.round(row.percent - start.percent);
		return `${row.label} ${Math.round(start.percent)}% ${arrow} ${Math.round(row.percent)}% (${added >= 0 ? '+' : ''}${added})`;
	});
	return rows.length ? `Hạn mức${before ? '' : ' hiện tại'}: ${rows.join(` ${sep} `)}` : null;
}

/** The side panel's Run section: the run and its roles. */
export function runPanelLines(run: RunState | null, columns: number, theme: Theme, live?: Live): Line[] {
	const g = theme.glyphs;
	if (!run) return hanging([{text: `${g.pending} `, dim: true}], 'Chưa có run nào. Gõ /pirl-plan <request> để bắt đầu.', columns, {dim: true});
	const active = isActive(run);
	const motion = live?.motion ?? false;
	const lines: Line[] = [
		[
			{text: `${LAYER_LABELS[run.kind]} `, bold: true, color: 'accent'},
			{text: STATUS_LABELS[run.status], dim: true},
			...(active ? [{text: ` ${g.sep} `, dim: true}, clockSpan(run.startedAt)] : []),
		],
	];
	if (run.roles.length === 0) lines.push(...hanging([{text: '  '}], active ? 'Coordinator đang chuẩn bị…' : 'Không có role nào chạy.', columns, {dim: true}));
	for (const role of run.roles) {
		const tone = role.state === 'failed' ? 'danger' : role.state === 'done' ? 'success' : ('accent' as const);
		const mark: Span = role.state === 'running' ? spinnerSpan(theme, motion, {color: tone}) : {text: role.state === 'done' ? g.ok : g.fail, color: tone};
		const name: Span = isRole(role.role) ? {text: role.role, role: role.role} : {text: role.role};
		lines.push([mark, {text: ' '}, name]);
	}
	return lines;
}

/** When a usage window resets: the time today, otherwise the day and time. */
export function resetText(iso: string | null, now = new Date()): string | null {
	if (!iso) return null;
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return null;
	const two = (value: number) => String(value).padStart(2, '0');
	const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
	return at.toDateString() === now.toDateString() ? time : `${two(at.getDate())}/${two(at.getMonth() + 1)} ${time}`;
}

/**
 * The side panel's Hạn mức section: each usage window of the plan as a bar, its percentage and when it resets.
 * The numbers come from Claude Code: `/usage` when the TUI opens, and the windows each run reports.
 */
export function quotaPanelLines(rows: QuotaRow[] | null, columns: number, theme: Theme): Line[] {
	if (!rows || rows.length === 0) return hanging([], 'Chưa có số liệu. Claude Code báo hạn mức khi chạy run.', columns, {dim: true});
	const labelWidth = Math.min(14, Math.max(...rows.map(row => width(row.label))) + 2);
	const barWidth = Math.max(4, Math.min(12, columns - labelWidth - 6));
	const lines: Line[] = [];
	for (const row of rows) {
		const percent = Math.max(0, Math.min(100, Math.round(row.percent)));
		const filled = Math.round((percent / 100) * barWidth);
		const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'success';
		const bar = theme.unicode ? `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}` : `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;
		lines.push([{text: padEnd(truncateEnd(row.label, labelWidth - 1, theme.glyphs.ellipsis), labelWidth), dim: true}, {text: bar, color: tone}, {text: ` ${percent}%`, color: tone}]);
		const reset = resetText(row.resetsAt);
		if (reset) lines.push([{text: ' '.repeat(labelWidth)}, {text: `đặt lại ${reset}`, dim: true}]);
	}
	return lines;
}
