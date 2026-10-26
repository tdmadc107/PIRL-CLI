import {COMMANDS, commandUsage, groupLabel, type CommandSpec} from '../commands/registry.js';
import type {Tone} from '../commands/dispatch.js';
import {COLOR_SCHEME_IDS, EFFORT_IDS, MOUSE_IDS, MODEL_IDS, PARALLEL_LIMITS, ROLE_MODEL_IDS, type Config, type MouseSetting} from '../core/config.js';
import {LANGUAGE_IDS, plural, t, type Language} from '../core/i18n.js';
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

const commandItems = (commands: readonly CommandSpec[]) => commands.map(spec => ({term: commandUsage(spec), description: spec.summary()}));

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
				...hanging([], t('Gõ / để xem lệnh, hoặc nhập yêu cầu. Gõ @ để đính kèm file hoặc thư mục.', 'Type / for commands, or type a request. Type @ to attach a file or folder.'), columns),
				blank,
				...definitionList(commandItems(COMMANDS.filter(spec => spec.group === 'layer' || spec.name === 'help')), columns),
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
		{term: 'Enter', description: t('Gửi', 'Send')},
		{term: 'Shift+Enter', description: t('Xuống dòng trong ô nhập (cũng được: \\ rồi Enter, Ctrl+J, Alt+Enter)', 'New line in the input box (also: \\ then Enter, Ctrl+J, Alt+Enter)')},
		{term: 'Ctrl+V', description: t('Dán từ clipboard (chuột phải hoặc phím dán của terminal cũng được)', 'Paste from the clipboard (the right button or the terminal\'s paste key also work)')},
		{term: 'Tab', description: t('Hoàn thành tên lệnh đang chọn', 'Complete the highlighted command')},
		{
			term: theme.glyphs.upDown,
			description: t(
				'Chọn lệnh gợi ý hoặc đáp án; ngoài ra xem lại nội dung đã gửi (chuột "Để terminal xử lý": cuộn khung chat)',
				'Choose a suggested command or answer; otherwise recall what you sent (mouse "Leave it to the terminal": scroll the chat)',
			),
		},
		{term: 'Ctrl+P / Ctrl+N', description: t('Xem lại nội dung đã gửi', 'Recall what you sent')},
		{
			term: '@',
			description: t(
				'Đính kèm file hoặc thư mục: Tab/Enter chọn, Enter lần nữa trên thư mục đang mở để đính kèm cả thư mục, Esc ẩn danh sách',
				'Attach a file or folder: Tab/Enter pick, Enter again on an open folder attaches the whole folder, Esc hides the list',
			),
		},
		{term: 'PgUp / PgDn', description: t('Cuộn khung chat', 'Scroll the chat')},
		{term: 'Esc', description: t('Xoá ô nhập, đóng bảng đang mở, hoặc dừng run đang chạy', 'Clear the input, close the open panel, or stop the running run')},
		{term: 'Ctrl+C', description: t('Dừng run đang chạy; khi không có run thì thoát', 'Stop the running run; with no run, quit')},
	];
	const lines: Line[] = [];
	for (const group of groups) {
		lines.push(heading(groupLabel(group)));
		lines.push(...definitionList(commandItems(COMMANDS.filter(spec => spec.group === group)), columns));
		lines.push(blank);
	}
	lines.push(heading(t('Phím tắt', 'Shortcuts')));
	lines.push(...definitionList(keys, columns));
	lines.push(blank);
	lines.push(
		...hanging(
			[],
			t(
				'Nhập không có dấu / là câu hỏi, standalone task hoặc bảo trì framework. Muốn copy một đoạn: kéo chuột bôi đen, đang giữ chuột thì lăn để bôi đen tiếp, thả chuột là copy; /copy copy nguyên câu trả lời gần nhất.',
				'Input without a / is a question, a standalone task or framework maintenance. To copy a passage: drag to select, turn the wheel while holding to select more, release to copy; /copy copies the whole latest reply.',
			),
			columns,
			{dim: true},
		),
	);
	lines.push(
		...hanging(
			[],
			t(
				'Windows Terminal trước bản 1.25 không phân biệt Shift+Enter với Enter: dùng Ctrl+J, hoặc thêm phím tắt sendInput "\\n" cho shift+enter trong settings.json.',
				'Windows Terminal before 1.25 does not tell Shift+Enter from Enter: use Ctrl+J, or add a sendInput "\\n" shortcut for shift+enter in settings.json.',
			),
			columns,
			{dim: true},
		),
	);
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
	if (doctor.state === 'idle') return [[{text: t('Chưa kiểm tra.', 'Not checked yet.'), dim: true}]];
	const report = doctor.state === 'done' ? doctor.report : doctor.previous;
	const lines: Line[] = [];
	if (doctor.state === 'running') lines.push([{text: `${theme.glyphs.running} ${t('Đang kiểm tra…', 'Checking…')}`, color: 'accent'}], blank);
	for (const check of report?.checks ?? []) lines.push(...checkLines(check, columns, theme));
	if (report) {
		const failed = report.checks.filter(check => check.state === 'fail').length;
		lines.push(blank);
		lines.push(
			failed === 0
				? [{text: t('Môi trường sẵn sàng cho PIRL.', 'The environment is ready for PIRL.'), color: 'success'}]
				: [{text: t(`${failed} mục cần xử lý trước khi chạy layer.`, `${failed} ${plural(failed, 'item')} to fix before running a layer.`), color: 'danger'}],
		);
	}
	return lines;
}

export type SettingsRow = {
	key: 'language' | 'provider' | 'model' | 'roleModel' | 'effort' | 'theme' | 'colors' | 'glyphs' | 'motion' | 'mouse' | 'maxParallelRoles';
	label: string;
	value: string;
	note?: string;
};

/** Each language under its own name, so a reader of either language finds theirs. */
const LANGUAGE_LABELS: Record<Language, string> = {vi: 'Tiếng Việt', en: 'English'};

const mouseNote = (mouse: MouseSetting) =>
	({
		select: t(
			'Kéo chuột để bôi đen, không cần Shift; đang giữ chuột thì lăn con lăn hoặc kéo chạm mép để cuộn tiếp và bôi đen thêm. Thả chuột là copy. Chuột phải dán. Con lăn cuộn hội thoại; ↑/↓ gọi lại lệnh đã gõ',
			'Drag to select, no Shift needed; while holding the button, turn the wheel or drag to the edge to scroll on and select more. Releasing copies. The right button pastes. The wheel scrolls the chat; ↑/↓ recall typed commands',
		),
		terminal: t(
			'Terminal tự bôi đen như bình thường nhưng chỉ trong phạm vi màn hình. Con lăn đến PIRL thành phím ↑/↓, nên ↑/↓ cuộn hội thoại và Ctrl+P/Ctrl+N gọi lại lệnh đã gõ',
			'The terminal selects as usual, but only within the screen. The wheel reaches PIRL as ↑/↓, so ↑/↓ scroll the chat and Ctrl+P/Ctrl+N recall typed commands',
		),
		off: t('PIRL không dùng chuột. Cuộn bằng PageUp/PageDown; ↑/↓ gọi lại lệnh đã gõ', 'PIRL does not use the mouse. Scroll with PageUp/PageDown; ↑/↓ recall typed commands'),
	})[mouse];

export function settingsRows(config: Config): SettingsRow[] {
	const provider = PROVIDERS.find(p => p.id === config.provider);
	const later = PROVIDERS.filter(p => !p.available).map(p => p.label);
	const auto = t('Tự nhận theo terminal', 'Detect from the terminal');
	const byClaude = t('Theo Claude Code', 'Claude Code default');
	return [
		{key: 'language', label: t('Ngôn ngữ (Language)', 'Language (Ngôn ngữ)'), value: LANGUAGE_LABELS[config.language], note: t('Ngôn ngữ của giao diện PIRL; agent trả lời theo ngôn ngữ của yêu cầu', 'Language of the PIRL interface; agents reply in the language of the request')},
		{key: 'provider', label: 'Provider', value: provider?.label ?? config.provider, note: later.length ? t(`Giai đoạn sau: ${later.join(', ')}`, `Coming later: ${later.join(', ')}`) : undefined},
		{
			key: 'model',
			label: t('Model coordinator', 'Coordinator model'),
			value: {sonnet: t('Sonnet (khuyến nghị)', 'Sonnet (recommended)'), opus: 'Opus', fable: 'Fable', haiku: 'Haiku', default: byClaude}[config.model],
			note: t(
				'Model điều phối run. Theo giá API, Opus tốn quota khoảng gấp đôi Sonnet, Fable khoảng gấp năm; Haiku rẻ nhất nhưng điều phối kém hơn',
				'The model that coordinates the run. At API prices, Opus uses about twice the quota of Sonnet and Fable about five times; Haiku is the cheapest but coordinates less well',
			),
		},
		{
			key: 'roleModel',
			label: t('Model các role', 'Role model'),
			value: {inherit: t('Giống coordinator', 'Same as the coordinator'), sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', haiku: 'Haiku'}[config.roleModel],
			note: t('Model của các role chạy như subagent (code-analyst, process-auditor…)', 'Model of the roles that run as subagents (code-analyst, process-auditor…)'),
		},
		{
			key: 'effort',
			label: t('Mức suy luận', 'Reasoning effort'),
			value: {default: byClaude, low: t('Thấp', 'Low'), medium: t('Vừa', 'Medium'), high: t('Cao', 'High'), xhigh: t('Rất cao', 'Very high'), max: t('Tối đa', 'Maximum')}[config.effort],
			note: t(
				'Áp dụng cho coordinator và mọi role. Phần suy luận tính như token ra, loại token đắt nhất: mức thấp hơn rẻ hơn nhưng phân tích kém kỹ hơn. Claude Code chuyển mức này thành một con số nội bộ, khác nhau theo model và phiên bản (Sonnet: low 4, medium 5, high 10, xhigh 30, max). Con số đó không phải thang điểm, nên hỏi model "đang ở mức nào" không cho biết mức. "Theo Claude Code" hiện là medium',
				'Applies to the coordinator and every role. Reasoning counts as output tokens, the most expensive kind: a lower level costs less but analyzes less thoroughly. Claude Code turns this level into an internal number that differs by model and version (Sonnet: low 4, medium 5, high 10, xhigh 30, max). That number is not a scale, so asking the model "which level" does not tell the level. "Claude Code default" is currently medium',
			),
		},
		{key: 'theme', label: t('Giao diện', 'Theme'), value: {auto, dark: t('Nền tối', 'Dark'), light: t('Nền sáng', 'Light')}[config.theme]},
		{
			key: 'colors',
			label: t('Bảng màu', 'Color scheme'),
			value: COLOR_SCHEMES[config.colors].label(),
			note: t('Đổi màu nhấn, màu lời nhập và màu viền; màu báo thành công, cảnh báo, lỗi giữ nguyên', 'Changes the accent, input and border colors; success, warning and error colors stay the same'),
		},
		{key: 'glyphs', label: t('Ký hiệu', 'Glyphs'), value: {auto, unicode: 'Unicode', ascii: 'ASCII'}[config.glyphs]},
		{
			key: 'mouse',
			label: t('Chuột', 'Mouse'),
			value: {select: t('Bôi đen tự do', 'Free selection'), terminal: t('Để terminal xử lý', 'Leave it to the terminal'), off: t('Tắt', 'Off')}[config.mouse],
			note: mouseNote(config.mouse),
		},
		{
			key: 'motion',
			label: t('Hiệu ứng chuyển động', 'Motion'),
			value: config.motion ? t('Bật', 'On') : t('Tắt', 'Off'),
			note: t('Spinner khi run đang chạy; tắt nếu terminal chậm hoặc bạn không thích chuyển động', 'The spinner while a run works; turn it off if the terminal is slow or you prefer no motion'),
		},
		{
			key: 'maxParallelRoles',
			label: t('Role chạy song song', 'Parallel roles'),
			value: String(config.maxParallelRoles),
			note: t(`${PARALLEL_LIMITS.min}–${PARALLEL_LIMITS.max}; càng nhiều càng nhanh nhưng tốn quota nhanh hơn`, `${PARALLEL_LIMITS.min}–${PARALLEL_LIMITS.max}; more is faster but uses quota faster`),
		},
	];
}

/** Cycles one setting forward (+1) or back (-1). The provider only cycles among providers whose adapter exists. */
export function cycleSetting(config: Config, key: SettingsRow['key'], step: 1 | -1): Config {
	const cycle = <T>(values: readonly T[], current: T): T =>
		values[(values.indexOf(current) + step + values.length) % values.length] as T;
	switch (key) {
		case 'language':
			return {...config, language: cycle(LANGUAGE_IDS, config.language)};
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
	lines.push(...hanging([], t(`${g.upDown} chọn mục ${g.sep} ${g.leftRight} đổi giá trị ${g.sep} thay đổi được lưu ngay`, `${g.upDown} choose ${g.sep} ${g.leftRight} change ${g.sep} changes are saved at once`), columns, {dim: true}));
	return lines;
}

// ---------- /plans and /records ----------

