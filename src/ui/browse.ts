import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import type {PlanPackage, RecordSummary} from '../engine/hubData.js';
import type {PersistedRun} from '../engine/run.js';
import {LAYER_LABELS} from '../engine/types.js';
import {blank, hanging, type Line, type Span} from './lines.js';
import type {ListDetail, ListEntry} from './listOverlay.js';
import {markdownLines, STATUS_LABELS} from './runView.js';
import type {Theme} from './theme.js';

/** The entries of /plans, /records and /resume, and what each one shows when opened (src/ui/listOverlay.ts). */

/** The pointer and the row's own lines: the chosen row is marked and drawn in the accent color. */
function row(active: boolean, theme: Theme, columns: number, head: Span[], text: string, rest: Line[] = []): Line[] {
	const pointer: Span = {text: active ? `${theme.glyphs.pointer} ` : '  ', color: 'accent'};
	const first = hanging([pointer, ...head], text, columns, active ? {color: 'accent', bold: true} : {});
	return [...first, ...rest.map(line => [{text: '  '}, ...line])];
}

/** A Plan or report file: its frontmatter as "field: value" lines, then the Markdown body. */
export function documentLines(path: string, columns: number): Line[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		return hanging([], `Không đọc được ${path}: ${error instanceof Error ? error.message : String(error)}`, columns, {color: 'danger'});
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	const lines: Line[] = [];
	if (match) {
		for (const field of match[1]!.split(/\r?\n/)) {
			const pair = /^([\w-]+):\s*(.*)$/.exec(field);
			if (pair) lines.push(...hanging([{text: `${pair[1]}: `, dim: true}], pair[2]!.replace(/^"(.*)"$/, '$1'), columns));
		}
		lines.push(blank);
	}
	lines.push(...markdownLines(match ? text.slice(match[0].length) : text, columns));
	lines.push(blank, ...hanging([{text: 'File: ', dim: true}], path, columns, {dim: true}));
	return lines;
}

export function planEntries(packages: PlanPackage[], theme: Theme): ListEntry[] {
	const entries: ListEntry[] = [];
	for (const item of packages) {
		entries.push({render: () => [blank, [{text: item.planSet, bold: true, color: 'accent'}]]});
		for (const task of item.tasks) {
			const tone = task.status === 'implemented' ? 'success' : task.status === 'failed' || task.status === 'blocked' ? 'danger' : 'warning';
			entries.push({
				render: (active, columns) => row(active, theme, columns, [{text: `${task.taskId} `, bold: true}, {text: `[${task.status}] `, color: tone}], task.title),
				open: (): ListDetail => ({title: `${task.taskId} ${task.title}`, lines: columns => documentLines(task.file, columns)}),
			});
			for (const report of item.reports.filter(report => report.taskId === task.taskId)) {
				const verdictTone = report.verdict === 'PASS' ? 'success' : report.verdict === 'FAIL' ? 'danger' : 'warning';
				entries.push({
					render: (active, columns) => row(active, theme, columns, [{text: '  Review vòng '}, {text: `${report.round}: `}, {text: report.verdict, color: verdictTone}, {text: '  '}], basename(report.file)),
					open: (): ListDetail => ({title: `${task.taskId} · Review vòng ${report.round}: ${report.verdict}`, lines: columns => documentLines(report.file, columns)}),
				});
			}
		}
	}
	return entries;
}

const text = (value: unknown) => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);

/** A record laid out by section: what the run did, its roles, the issues found and the improvements made. */
export function recordLines(data: Record<string, unknown>, columns: number, theme: Theme): Line[] {
	const g = theme.glyphs;
	const field = (label: string, value: unknown) => (text(value) ? hanging([{text: `${label}: `, dim: true}], text(value), columns) : []);
	const section = (title: string) => [blank, [{text: title, bold: true, color: 'accent'} as Span]];
	const outcome = (data['outcome'] ?? {}) as Record<string, unknown>;
	const task = (data['task'] ?? {}) as Record<string, unknown>;
	const audit = (data['audit'] ?? {}) as Record<string, unknown>;
	const lines: Line[] = [
		...field('Layer', data['layer']),
		...field('Thời điểm', data['recorded_at']),
		...field('Plan', task['plan_set']),
		...field('Task', list(task['task_ids']).length ? (task['task_ids'] as string[]).join(', ') : task['task_ids']),
		...field('Report', task['report_file']),
		...field('Repo', data['target_repo']),
		...field('Kết quả', [outcome['status'], outcome['verdict']].filter(Boolean).join(' · ')),
		...field('Tóm tắt', outcome['summary']),
	];
	lines.push(...section('Role'));
	for (const role of list(data['roles'])) {
		const tone = role['result'] === 'PASS' ? 'success' : role['result'] === 'FAIL' ? 'danger' : 'warning';
		lines.push([{text: `${text(role['role'])} `, bold: true}, {text: `${text(role['mode'])} `, dim: true}, {text: text(role['result']), color: tone}]);
		if (text(role['assignment'])) lines.push(...hanging([{text: '  '}], text(role['assignment']), columns, {dim: true}));
	}
	lines.push(...field('Tự đánh giá', `process-auditor · ${text(audit['mode'])} · ${text(audit['result'])}`));
	const issues = list(data['issues']);
	lines.push(...section(`Vấn đề (${issues.length})`));
	if (issues.length === 0) lines.push([{text: 'Không có.', dim: true}]);
	for (const issue of issues) {
		lines.push(...hanging([{text: `${g.warn} `, color: 'warning'}, {text: `${text(issue['id'])} `, bold: true}], `${text(issue['issue_key'])} · ${text(issue['role'])} · nguyên nhân ${text(issue['cause'])}`, columns));
		for (const [label, key] of [['Quyết định sai', 'decision'], ['Quy tắc', 'rule'], ['Bằng chứng', 'evidence'], ['Sửa trước đó', 'prior_fix']] as const) {
			if (text(issue[key])) lines.push(...hanging([{text: '  '}, {text: `${label}: `, dim: true}], text(issue[key]), columns));
		}
	}
	const fixes = list(data['fixes']);
	lines.push(...section(`Cải tiến (${fixes.length})`));
	if (fixes.length === 0) lines.push([{text: 'Không có.', dim: true}]);
	for (const fix of fixes) {
		const applied = fix['status'] === 'applied';
		lines.push(
			...hanging(
				[{text: `${applied ? g.ok : g.pending} `, color: applied ? 'success' : 'warning'}, {text: `${text(fix['id'])} `, bold: true}],
				`${applied ? 'đã áp dụng' : `chờ duyệt (${text(fix['reason'])})`} · cho ${list(fix['issues']).length ? (fix['issues'] as string[]).join(', ') : text(fix['issues'])}`,
				columns,
			),
		);
		for (const file of list(fix['files'])) lines.push(...hanging([{text: '  '}], `${text(file['path'])} · ${text(file['section'])}`, columns, {dim: true}));
		if (text(fix['summary'])) lines.push(...hanging([{text: '  '}], text(fix['summary']), columns));
		for (const check of list(fix['checks'])) lines.push(...hanging([{text: '  $ ', dim: true}], text(check), columns, {dim: true}));
	}
	if (data['supersedes'] || data['evaluates']) lines.push(blank, ...field('Sửa record', data['supersedes']), ...field('Đánh giá record', data['evaluates']));
	return lines;
}

export function recordEntries(records: RecordSummary[], theme: Theme): ListEntry[] {
	const g = theme.glyphs;
	return records.map(record => ({
		render: (active, columns) => {
			const fixes = record.fixes > 0 || record.pending > 0 ? ` ${g.sep} ${record.fixes} cải tiến đã áp dụng${record.pending ? `, ${record.pending} chờ duyệt` : ''}` : '';
			return [blank, ...row(active, theme, columns, [], `${record.recordId}  ${record.layer} ${g.sep} ${record.status}${fixes}`, hanging([{text: '  '}], record.summary, columns - 2, {dim: true}))];
		},
		open: (): ListDetail => ({title: record.recordId, lines: columns => recordLines(record.data, columns, theme)}),
	}));
}

/** When a run was saved, as "24/10 14:05". */
const when = (iso: string | undefined) => {
	const date = iso ? new Date(iso) : null;
	if (!date || Number.isNaN(date.getTime())) return '';
	const two = (value: number) => String(value).padStart(2, '0');
	return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

export function resumeEntries(runs: PersistedRun[], theme: Theme, pick: (run: PersistedRun) => void): ListEntry[] {
	const g = theme.glyphs;
	return runs.map(run => ({
		render: (active, columns) => {
			const waiting = run.status === 'waiting' && run.questions.length ? ` ${g.sep} ${run.questions.length} câu hỏi chờ trả lời` : '';
			return [
				blank,
				...row(
					active,
					theme,
					columns,
					[{text: `${LAYER_LABELS[run.kind]} `, bold: true}, {text: `${STATUS_LABELS[run.status]}${waiting} `, color: 'warning'}, {text: when(run.savedAt), dim: true}],
					'',
					hanging([{text: '  '}], run.request.split('\n')[0]!, columns - 2, {dim: true}),
				),
			];
		},
		act: () => pick(run),
	}));
}
