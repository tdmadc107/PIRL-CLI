import {basename} from 'node:path';
import type {RunState, RunStatus} from '../engine/run.js';
import {LAYER_LABELS, type Question} from '../engine/types.js';
import {blank, hanging, type Line, type Span} from './lines.js';
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

export function runLines(run: RunState, columns: number, theme: Theme, interaction: Interaction | null): Line[] {
	const g = theme.glyphs;
	const lines: Line[] = [];
	const statusTone = run.status === 'failed' ? 'danger' : run.status === 'done' ? 'success' : run.status === 'stopped' ? 'muted' : run.status === 'running' || run.status === 'checking' ? 'accent' : 'warning';
	const statusGlyph = run.status === 'done' ? g.ok : run.status === 'failed' ? g.fail : run.status === 'stopped' ? g.pending : run.status === 'waiting' || run.status === 'improvements' ? g.warn : g.running;
	if (run.kind !== 'chat') {
		lines.push([
			{text: `${statusGlyph} `, color: statusTone},
			{text: LAYER_LABELS[run.kind], bold: true, color: 'accent'},
			{text: ` ${g.sep} ${STATUS_LABELS[run.status]}`, color: statusTone},
		]);
	} else if (run.status !== 'done') {
		lines.push([{text: `${statusGlyph} `, color: statusTone}, {text: `PIRL ${g.sep} ${STATUS_LABELS[run.status]}`, color: statusTone}]);
	}

	for (const role of run.roles) {
		const glyph = role.state === 'running' ? g.running : role.state === 'done' ? g.ok : g.fail;
		const roleSpan: Span = isRole(role.role) ? {text: role.role, role: role.role, bold: true} : {text: role.role, bold: true};
		lines.push(...hanging([{text: '  '}, {text: `${glyph} `, color: role.state === 'failed' ? 'danger' : role.state === 'done' ? 'success' : 'accent'}, roleSpan, {text: '  '}], role.description, columns, {dim: true}));
		if (role.state === 'running' && role.activity) lines.push(...hanging([{text: '      '}], role.activity, columns, {dim: true}));
	}
	if ((run.status === 'running' || run.status === 'checking') && run.activity) {
		lines.push(...hanging([{text: '  '}, {text: `${g.running} `, color: 'accent'}, {text: 'coordinator  ', dim: true}], run.activity, columns, {dim: true}));
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
		lines.push(...hanging([{text: '  '}, {text: `${g.warn} `, color: 'warning'}], `Bị chặn theo quyền của run: ${run.denials.join('; ')}`, columns, {dim: true}));
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
			if (improvements.error) lines.push(...hanging([{text: '    '}], `Lỗi: ${improvements.error}`, columns, {color: 'danger'}));
			if (interaction?.kind === 'improvements' && interaction.runId === run.id) {
				lines.push(...hanging([{text: '    '}], 'Commit cải tiến này vào Hub?', columns));
				lines.push(...choiceLines(IMPROVEMENT_CHOICES.map(choice => choice.label), interaction.selected, 0, columns, theme));
			}
		}
	}

	if (run.error) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: `${g.fail} `, color: 'danger'}], run.error, columns, {color: 'danger'}));
		lines.push(...hanging([{text: '    '}], 'Gõ /resume để chạy tiếp từ chỗ dừng.', columns, {dim: true}));
	}
	if (run.status === 'stopped') lines.push(...hanging([{text: '    '}], 'Đã dừng. Gõ /resume để chạy tiếp.', columns, {dim: true}));

	if (run.suggestion) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: `${g.info} `, color: 'accent'}], `Yêu cầu này là một layer. Lệnh đã được điền sẵn vào ô nhập: ${run.suggestion}`, columns));
	}
	const next = nextStep(run);
	if (next) {
		lines.push(blank);
		lines.push(...hanging([{text: '  '}, {text: 'Bước tiếp theo, khi bạn muốn: ', dim: true}], next, columns, {color: 'accent'}));
	}
	if (run.usage.calls > 0 && run.status !== 'running') {
		const tokens = run.usage.inputTokens + run.usage.outputTokens;
		lines.push([{text: `  ${run.usage.calls} lượt gọi ${g.sep} ${tokens.toLocaleString('vi-VN')} token`, dim: true}]);
	}
	return lines;
}

/** Roles of the run for the side panel: one line each, the running role's activity under it. */
export function runPanelLines(run: RunState | null, columns: number, theme: Theme): Line[] {
	const g = theme.glyphs;
	if (!run) return hanging([{text: `${g.pending} `, dim: true}], 'Chưa có run nào. Gõ /pirl-plan <request> để bắt đầu.', columns, {dim: true});
	const lines: Line[] = [[{text: `${LAYER_LABELS[run.kind]} `, bold: true, color: 'accent'}, {text: STATUS_LABELS[run.status], dim: true}]];
	if (run.roles.length === 0) lines.push(...hanging([{text: '  '}], run.status === 'running' ? 'Coordinator đang chuẩn bị…' : 'Không có role nào chạy.', columns, {dim: true}));
	for (const role of run.roles) {
		const glyph = role.state === 'running' ? g.running : role.state === 'done' ? g.ok : g.fail;
		const name: Span = isRole(role.role) ? {text: role.role, role: role.role} : {text: role.role};
		lines.push([{text: `${glyph} `, color: role.state === 'failed' ? 'danger' : role.state === 'done' ? 'success' : 'accent'}, name]);
		if (role.state === 'running' && role.activity) lines.push(...hanging([{text: '  '}], role.activity, columns, {dim: true}));
	}
	return lines;
}
