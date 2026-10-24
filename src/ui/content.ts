import {COMMANDS, commandUsage, type CommandSpec} from '../commands/registry.js';
import type {Tone} from '../commands/dispatch.js';
import {
	COLOR_SCHEME_IDS,
	EFFORT_IDS,
	MOUSE_IDS,
	MODEL_IDS,
	PARALLEL_LIMITS,
	ROLE_MODEL_IDS,
	type Config,
	type EffortSetting,
	type MouseSetting,
	type ModelSetting,
	type RoleModelSetting,
} from '../core/config.js';
import type {RunState} from '../engine/run.js';
import type {Check, CheckState} from '../doctor/doctor.js';
import {PROVIDERS} from '../providers/index.js';
import {blank, hanging, type Line, type Span} from './lines.js';
import {runLines, type Interaction, type Live} from './runView.js';
import type {DoctorState, Message} from './session.js';
import {padEnd, width} from './text.js';
import {COLOR_SCHEMES, type ColorToken, type Theme} from './theme.js';

const TONE: Record<Tone, {glyph: keyof Theme['glyphs']; color: ColorToken}> = {
	info: {glyph: 'info', color: 'accent'},
	success: {glyph: 'ok', color: 'success'},
	warning: {glyph: 'warn', color: 'warning'},
	error: {glyph: 'fail', color: 'danger'},
};

const CHECK_TONE: Record<CheckState, Tone> = {ok: 'success', warn: 'warning', fail: 'error'};

/**
 * A two-column list (command and summary) that becomes stacked rows when the window is too narrow
 * to keep the summary readable beside the command.
 */
export function definitionList(items: Array<{term: string; description: string}>, columns: number, indent = 2): Line[] {
	const termWidth = Math.max(...items.map(item => width(item.term))) + 2;
	const sideBySide = columns - indent - termWidth >= 24;
	return items.flatMap(item => {
		const term: Span = {text: item.term, color: 'accent'};
		if (sideBySide) {
			return hanging([{text: ' '.repeat(indent)}, {...term, text: padEnd(item.term, termWidth)}], item.description, columns);
		}
		return [
			[{text: ' '.repeat(indent)}, term],
			...hanging([{text: ' '.repeat(indent + 2)}], item.description, columns, {dim: true}),
		];
	});
}

const commandItems = (commands: readonly CommandSpec[]) => commands.map(spec => ({term: commandUsage(spec), description: spec.summary}));

export type TranscriptContext = {runs: Record<number, RunState>; interaction: Interaction | null; live?: Live};

export function messageLines(message: Message, columns: number, theme: Theme, context: TranscriptContext = {runs: {}, interaction: null}): Line[] {
	const g = theme.glyphs;
	switch (message.kind) {
		case 'welcome':
			return [
				[
					{text: 'PIRL', color: 'accent', bold: true},
					{text: ` ${g.sep} Plan ${g.sep} Implement ${g.sep} Review`, dim: true},
				],
				...hanging([], 'Gõ / để xem lệnh, hoặc nhập yêu cầu. Gõ @ để đính kèm file hoặc thư mục.', columns),
				blank,
				...definitionList(commandItems(COMMANDS.filter(spec => spec.group === 'Layer' || spec.name === 'help')), columns),
			];
		case 'user':
			return hanging([{text: `${g.prompt} `, color: 'user', bold: true}], message.text, columns, {bold: true});
		case 'run': {
			const run = context.runs[message.runId];
			return run ? runLines(run, columns, theme, context.interaction, context.live) : [];
		}
		case 'note': {
			const tone = TONE[message.tone];
			const prefix: Span[] = [{text: `${g[tone.glyph]} `, color: tone.color}];
			const lines = hanging(prefix, message.text, columns, message.tone === 'error' ? {color: 'danger'} : {});
			if (message.hint) lines.push(...hanging([{text: '  '}], message.hint, columns, {dim: true}));
			return lines;
		}
	}
}

/** Every message, separated by one blank line, laid out for `columns` cells. */
export function transcriptLines(messages: Message[], columns: number, theme: Theme, context?: TranscriptContext): Line[] {
	return messages.flatMap((message, index) => [...(index > 0 ? [blank] : []), ...messageLines(message, columns, theme, context)]);
}

// ---------- overlays ----------

const heading = (text: string): Line => [{text, bold: true}];

export function helpLines(columns: number, theme: Theme): Line[] {
	const groups = [...new Set(COMMANDS.map(spec => spec.group))];
	const keys = [
		{term: 'Enter', description: 'Gửi'},
		{term: 'Shift+Enter', description: 'Xuống dòng trong ô nhập (cũng được: \\ rồi Enter, Ctrl+J, Alt+Enter)'},
		{term: 'Ctrl+V', description: 'Dán từ clipboard (chuột phải hoặc phím dán của terminal cũng được)'},
		{term: 'Tab', description: 'Hoàn thành tên lệnh đang chọn'},
		{term: theme.glyphs.upDown, description: 'Chọn lệnh gợi ý hoặc đáp án; ngoài ra cuộn khung chat (chuột "Bôi đen tự do") hoặc xem lại nội dung đã gửi'},
		{term: 'Ctrl+P / Ctrl+N', description: 'Xem lại nội dung đã gửi'},
		{term: '@', description: 'Đính kèm file hoặc thư mục: Tab/Enter chọn, Enter lần nữa trên thư mục đang mở để đính kèm cả thư mục, Esc ẩn danh sách'},
		{term: 'PgUp / PgDn', description: 'Cuộn khung chat'},
		{term: 'Esc', description: 'Xoá ô nhập, đóng bảng đang mở, hoặc dừng run đang chạy'},
		{term: 'Ctrl+C', description: 'Dừng run đang chạy; khi không có run thì thoát'},
	];
	const lines: Line[] = [];
	for (const group of groups) {
		lines.push(heading(group));
		lines.push(...definitionList(commandItems(COMMANDS.filter(spec => spec.group === group)), columns));
		lines.push(blank);
	}
	lines.push(heading('Phím tắt'));
	lines.push(...definitionList(keys, columns));
	lines.push(blank);
	lines.push(...hanging([], 'Nhập không có dấu / là câu hỏi, standalone task hoặc bảo trì framework. Muốn copy một đoạn bất kỳ: bôi đen bằng chuột như mọi nội dung trong terminal; /copy copy nguyên câu trả lời gần nhất.', columns, {dim: true}));
	lines.push(...hanging([], 'Windows Terminal trước bản 1.25 không phân biệt Shift+Enter với Enter: dùng Ctrl+J, hoặc thêm phím tắt sendInput "\\n" cho shift+enter trong settings.json.', columns, {dim: true}));
	return lines;
}

function checkLines(check: Check, columns: number, theme: Theme): Line[] {
	const tone = TONE[CHECK_TONE[check.state]];
	const lines = hanging(
		[{text: `${theme.glyphs[tone.glyph]} `, color: tone.color}, {text: `${check.label}: `, bold: true}],
		check.detail,
		columns,
	);
	if (check.fix) lines.push(...hanging([{text: '  '}], check.fix, columns, {dim: true}));
	return lines;
}

export function doctorLines(doctor: DoctorState, columns: number, theme: Theme): Line[] {
	if (doctor.state === 'idle') return [[{text: 'Chưa kiểm tra.', dim: true}]];
	const report = doctor.state === 'done' ? doctor.report : doctor.previous;
	const lines: Line[] = [];
	if (doctor.state === 'running') lines.push([{text: `${theme.glyphs.running} Đang kiểm tra…`, color: 'accent'}], blank);
	for (const check of report?.checks ?? []) lines.push(...checkLines(check, columns, theme));
	if (report) {
		const failed = report.checks.filter(check => check.state === 'fail').length;
		lines.push(blank);
		lines.push(
			failed === 0
				? [{text: 'Môi trường sẵn sàng cho PIRL.', color: 'success'}]
				: [{text: `${failed} mục cần xử lý trước khi chạy layer.`, color: 'danger'}],
		);
	}
	return lines;
}

export type SettingsRow = {
	key: 'provider' | 'model' | 'roleModel' | 'effort' | 'theme' | 'colors' | 'glyphs' | 'motion' | 'mouse' | 'maxParallelRoles';
	label: string;
	value: string;
	note?: string;
};

const MODEL_LABELS: Record<ModelSetting, string> = {sonnet: 'Sonnet (khuyến nghị)', opus: 'Opus', fable: 'Fable', haiku: 'Haiku', default: 'Theo Claude Code'};
const ROLE_MODEL_LABELS: Record<RoleModelSetting, string> = {inherit: 'Giống coordinator', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', haiku: 'Haiku'};
const MOUSE_LABELS: Record<MouseSetting, string> = {select: 'Bôi đen tự do', wheel: 'Con lăn của PIRL', off: 'Tắt'};
const MOUSE_NOTES: Record<MouseSetting, string> = {
	select:
		'Kéo chuột bôi đen như bình thường. Con lăn cuộn hội thoại vì terminal gửi nó thành phím ↑/↓, nên ↑/↓ cuộn hội thoại và Ctrl+P/Ctrl+N gọi lại lệnh đã gõ. Cần terminal hỗ trợ: Windows Terminal, VS Code, iTerm2, Terminal của macOS, GNOME, kitty, WezTerm',
	wheel: 'PIRL nhận con lăn trực tiếp, chạy trên mọi terminal có chuột. Bôi đen chữ phải giữ Shift khi kéo (iTerm2: Option); ↑/↓ gọi lại lệnh đã gõ',
	off: 'PIRL không dùng chuột. Cuộn bằng PageUp/PageDown; ↑/↓ gọi lại lệnh đã gõ',
};
const EFFORT_LABELS: Record<EffortSetting, string> = {default: 'Theo Claude Code', low: 'Thấp', medium: 'Vừa', high: 'Cao', xhigh: 'Rất cao', max: 'Tối đa'};

export function settingsRows(config: Config): SettingsRow[] {
	const provider = PROVIDERS.find(p => p.id === config.provider);
	const later = PROVIDERS.filter(p => !p.available).map(p => p.label);
	return [
		{key: 'provider', label: 'Provider', value: provider?.label ?? config.provider, note: later.length ? `Giai đoạn sau: ${later.join(', ')}` : undefined},
		{
			key: 'model',
			label: 'Model coordinator',
			value: MODEL_LABELS[config.model],
			note: 'Model điều phối run. Theo giá API, Opus tốn quota khoảng gấp đôi Sonnet, Fable khoảng gấp năm; Haiku rẻ nhất nhưng điều phối kém hơn',
		},
		{
			key: 'roleModel',
			label: 'Model các role',
			value: ROLE_MODEL_LABELS[config.roleModel],
			note: 'Model của các role chạy như subagent (code-analyst, process-auditor…)',
		},
		{
			key: 'effort',
			label: 'Mức suy luận',
			value: EFFORT_LABELS[config.effort],
			note: 'Áp dụng cho coordinator và mọi role. Phần suy luận tính như token ra, loại token đắt nhất: mức thấp hơn rẻ hơn nhưng phân tích kém kỹ hơn. Claude Code chuyển mức này thành một con số nội bộ, khác nhau theo model và phiên bản (Sonnet: low 4, medium 5, high 10, xhigh 30, max). Con số đó không phải thang điểm, nên hỏi model "đang ở mức nào" không cho biết mức. "Theo Claude Code" hiện là medium',
		},
		{key: 'theme', label: 'Giao diện', value: {auto: 'Tự nhận theo terminal', dark: 'Nền tối', light: 'Nền sáng'}[config.theme]},
		{key: 'colors', label: 'Bảng màu', value: COLOR_SCHEMES[config.colors].label, note: 'Đổi màu nhấn, màu lời nhập và màu viền; màu báo thành công, cảnh báo, lỗi giữ nguyên'},
		{key: 'glyphs', label: 'Ký hiệu', value: {auto: 'Tự nhận theo terminal', unicode: 'Unicode', ascii: 'ASCII'}[config.glyphs]},
		{
			key: 'mouse',
			label: 'Chuột',
			value: MOUSE_LABELS[config.mouse],
			note: MOUSE_NOTES[config.mouse],
		},
		{key: 'motion', label: 'Hiệu ứng chuyển động', value: config.motion ? 'Bật' : 'Tắt', note: 'Spinner khi run đang chạy; tắt nếu terminal chậm hoặc bạn không thích chuyển động'},
		{
			key: 'maxParallelRoles',
			label: 'Role chạy song song',
			value: String(config.maxParallelRoles),
			note: `${PARALLEL_LIMITS.min}–${PARALLEL_LIMITS.max}; càng nhiều càng nhanh nhưng tốn quota nhanh hơn`,
		},
	];
}

/** Cycles one setting forward (+1) or back (-1). The provider only cycles among providers whose adapter exists. */
export function cycleSetting(config: Config, key: SettingsRow['key'], step: 1 | -1): Config {
	const cycle = <T>(values: readonly T[], current: T): T =>
		values[(values.indexOf(current) + step + values.length) % values.length] as T;
	switch (key) {
		case 'provider':
			return {...config, provider: cycle(PROVIDERS.filter(p => p.available).map(p => p.id), config.provider)};
		case 'model':
			return {...config, model: cycle(MODEL_IDS, config.model)};
		case 'roleModel':
			return {...config, roleModel: cycle(ROLE_MODEL_IDS, config.roleModel)};
		case 'effort':
			return {...config, effort: cycle(EFFORT_IDS, config.effort)};
		case 'theme':
			return {...config, theme: cycle(['auto', 'dark', 'light'] as const, config.theme)};
		case 'colors':
			return {...config, colors: cycle(COLOR_SCHEME_IDS, config.colors)};
		case 'glyphs':
			return {...config, glyphs: cycle(['auto', 'unicode', 'ascii'] as const, config.glyphs)};
		case 'motion':
			return {...config, motion: !config.motion};
		case 'mouse':
			return {...config, mouse: cycle(MOUSE_IDS, config.mouse)};
		case 'maxParallelRoles': {
			const next = config.maxParallelRoles + step;
			return {...config, maxParallelRoles: Math.min(PARALLEL_LIMITS.max, Math.max(PARALLEL_LIMITS.min, next))};
		}
	}
}

export function settingsLines(config: Config, selected: number, columns: number, theme: Theme): Line[] {
	const rows = settingsRows(config);
	const labelWidth = Math.max(...rows.map(row => width(row.label))) + 2;
	const stacked = columns - 2 - labelWidth < 20;
	const lines: Line[] = [];
	rows.forEach((row, index) => {
		const active = index === selected;
		const pointer: Span = {text: active ? `${theme.glyphs.pointer} ` : '  ', color: 'accent'};
		const value: Span = {text: `‹ ${row.value} ›`, color: active || row.key === 'colors' ? 'accent' : undefined, bold: active};
		if (!theme.unicode) value.text = `< ${row.value} >`;
		if (stacked) {
			lines.push([pointer, {text: row.label, bold: active}]);
			lines.push([{text: '    '}, value]);
		} else {
			lines.push([pointer, {text: padEnd(row.label, labelWidth), bold: active}, value]);
		}
		if (row.note && active) lines.push(...hanging([{text: '    '}], row.note, columns, {dim: true}));
	});
	lines.push(blank);
	const g = theme.glyphs;
	lines.push(...hanging([], `${g.upDown} chọn mục ${g.sep} ${g.leftRight} đổi giá trị ${g.sep} thay đổi được lưu ngay`, columns, {dim: true}));
	return lines;
}

// ---------- /plans and /records ----------

