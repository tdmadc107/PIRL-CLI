import {Box, useApp, useInput, usePaste, useWindowSize, type Key} from 'ink';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {dispatch, type Effect, type OverlayKind} from '../commands/dispatch.js';
import {parseInput, suggestCommands} from '../commands/registry.js';
import type {Config} from '../core/config.js';
import type {DoctorReport} from '../doctor/doctor.js';
import type {PersistedRun, RunController, RunState} from '../engine/run.js';
import {resumable} from '../engine/runStore.js';
import {LAYER_LABELS, totalTokens, type QuotaRow, type RunKind} from '../engine/types.js';
import {getProvider} from '../providers/index.js';
import {
	cycleSetting,
	doctorLines,
	helpLines,
	settingsLines,
	settingsRows,
	transcriptLines,
} from './content.js';
import {Header, type ProviderBadge} from './components/Header.js';
import {InputBox, inputHeight, paletteLines} from './components/Input.js';
import {bottomWindow, Lines} from './components/Lines.js';
import {Frame, SidePanel, statusLine, TooSmall} from './components/Panels.js';
import {displayPath} from '../core/paths.js';
import {planEntries, recordEntries, resumeEntries} from './browse.js';
import {useFrameworkConsole} from './frameworkConsole.js';
import {blank, hanging} from './lines.js';
import {useListOverlay, type ListEntry} from './listOverlay.js';
import {backspace, emptyEditor, insert, move, setValue, type EditorState} from './inputEditor.js';
import {computeLayout} from './layout.js';
import type {Line} from './lines.js';
import {clockSpan, compactTokens, costText, IMPROVEMENT_CHOICES, isActive, spinnerSpan, STATUS_LABELS, type Interaction, type Live} from './runView.js';
import {parseTerminalInput} from './terminalInput.js';
import {SPINNER_MS, setTickInterval} from './ticker.js';
import type {DoctorState, Message, NewMessage, Services, SessionInfo, StartupNote} from './session.js';
import {createTheme} from './theme.js';

export type AppProps = {
	info: SessionInfo;
	initialConfig: Config;
	startupNotes?: StartupNote[];
	services: Services;
	/** Run /doctor's checks once at start and post a one-line summary (on by default). */
	checkOnStart?: boolean;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
};

const OVERLAY_TITLES: Record<OverlayKind, string> = {
	help: 'Trợ giúp',
	doctor: 'Kiểm tra môi trường',
	settings: 'Cài đặt',
	framework: 'Framework',
	plans: 'Plan của repo này',
	records: 'Record tự cải tiến',
	resume: 'Chạy tiếp run',
};

/** One line after a clean start: the provider is signed in, plus the Python and Git versions found. */
function readySummary(report: DoctorReport): string {
	const provider = report.checks.find(check => check.id === 'provider');
	const git = report.checks.find(check => check.id === 'git');
	const parts = [provider ? `${provider.label} đã đăng nhập` : null, report.python ? `Python ${report.python.version}` : null, git ? `Git ${git.detail}` : null];
	return `Sẵn sàng: ${parts.filter(Boolean).join(' · ')}.`;
}

const ACTIVE: RunState['status'][] = ['running', 'checking'];

/** The run's model settings in one line: "sonnet · effort high", with the roles' model when it differs. */
export function modelText(config: Config): string {
	const model = config.model === 'default' ? 'theo Claude Code' : config.model;
	const roles = config.roleModel === 'inherit' ? '' : ` · role ${config.roleModel}`;
	// Claude Code's default effort is medium.
	const effort = config.effort === 'default' ? 'medium' : config.effort;
	return `${model}${roles} · effort ${effort}`;
}
/** Longest wait before a run's new state is drawn. */
const FLUSH_MS = 100;
/** Shift+Enter as xterm's modifyOtherKeys reports it, which Ink does not parse: ESC [27;<mod>;13~ */
const MODIFIED_ENTER = /^\[27;\d+;13~$/;

export function App(props: AppProps) {
	const {exit} = useApp();
	const {columns, rows} = useWindowSize();
	const [config, setConfig] = useState(props.initialConfig);
	const theme = useMemo(
		() => createTheme(config, props.env ?? process.env, props.platform ?? process.platform),
		[config.theme, config.glyphs, config.colors, props.env, props.platform],
	);
	const nextId = useRef(0);
	const newId = () => nextId.current++;
	const [messages, setMessages] = useState<Message[]>(() => [
		{id: newId(), kind: 'welcome'},
		...(props.startupNotes ?? []).map(note => ({id: newId(), kind: 'note' as const, ...note})),
	]);
	const [editor, setEditorState] = useState<EditorState>(emptyEditor);
	// Key events of one burst (fast typing, or a Vietnamese input method sending backspaces and the accented
	// letters together) are handled before React renders again; each must start from the result of the previous
	// one, so the latest editor state lives in a ref that every update writes synchronously.
	const editorRef = useRef(editor);
	const setEditor = (next: EditorState | ((current: EditorState) => EditorState)) => {
		editorRef.current = typeof next === 'function' ? next(editorRef.current) : next;
		setEditorState(editorRef.current);
	};
	const [history, setHistory] = useState<string[]>([]);
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const [paletteIndex, setPaletteIndex] = useState(0);
	const [scroll, setScroll] = useState(0);
	const [overlay, setOverlay] = useState<OverlayKind | null>(null);
	const [overlayTop, setOverlayTop] = useState(0);
	const [settingsIndex, setSettingsIndex] = useState(0);
	const [doctor, setDoctor] = useState<DoctorState>({state: 'idle'});
	// The Hub changes under the session (committed improvements, /framework): its status is kept fresh here.
	const [hub, setHub] = useState(props.info.hub);
	const info = useMemo(() => ({...props.info, hub}), [props.info, hub]);
	const refreshHub = () => void props.services.framework?.status().then(setHub, () => {});
	// The plan's usage windows: read once at start, then as each run reports them.
	const [quota, setQuota] = useState<QuotaRow[] | null>(null);
	useEffect(() => {
		props.services.quota?.().then(rows => rows && setQuota(current => current ?? rows), () => {});
	}, []);

	// Runs: their state for drawing, their controllers for acting, and the answers being collected.
	const [runs, setRuns] = useState<Record<number, RunState>>({});
	const controllers = useRef(new Map<number, RunController>());
	const [activeRunId, setActiveRunId] = useState<number | null>(null);
	const [lastRunId, setLastRunId] = useState<number | null>(null);
	const chatSession = useRef<string | null>(null);
	const [answers, setAnswers] = useState<string[]>([]);
	// The option the pointer is on, remembered per question; a new question starts at its recommended option.
	const [choiceState, setChoiceState] = useState<{key: string; index: number}>({key: '', index: 0});

	const addMessages = useCallback((added: NewMessage[]) => {
		setMessages(current => [...current, ...added.map(message => ({...message, id: nextId.current++}) as Message)]);
		setScroll(0);
	}, []);

	const startDoctor = useCallback(
		(announce: boolean) => {
			setDoctor(previous => ({state: 'running', previous: previous.state === 'done' ? previous.report : previous.state === 'running' ? previous.previous : undefined}));
			props.services.runDoctor(config).then(
				report => {
					setDoctor({state: 'done', report});
					if (!announce) return;
					// The target repo is already announced by a startup note; repeating it here adds nothing.
					const problems = report.checks.filter(check => check.state !== 'ok' && check.id !== 'target');
					addMessages([
						problems.length === 0
							? {kind: 'note', tone: 'success', text: readySummary(report)}
							: {
									kind: 'note',
									tone: problems.some(check => check.state === 'fail') ? 'error' : 'warning',
									text: `Cần chú ý: ${problems.map(check => `${check.label} (${check.detail})`).join('; ')}.`,
									hint: 'Gõ /doctor để xem cách xử lý.',
								},
					]);
				},
				(error: unknown) => {
					setDoctor({state: 'idle'});
					addMessages([{kind: 'note', tone: 'error', text: `Không chạy được bước kiểm tra: ${String(error)}`}]);
				},
			);
		},
		[addMessages, config, props.services],
	);

	useEffect(() => {
		if (props.checkOnStart ?? true) startDoctor(true);
		// Only at start; later checks come from /doctor.
	}, []);

	// Stop a running provider process when the TUI closes, so it does not keep working unseen.
	useEffect(() => () => controllers.current.forEach(controller => controller.stop()), []);

	const report = doctor.state === 'done' ? doctor.report : doctor.state === 'running' ? doctor.previous : undefined;
	const framework = useFrameworkConsole({
		services: props.services.framework,
		hub,
		hubError: props.info.hubError,
		config,
		python: report?.python ?? null,
		runActive: activeRunId !== null,
		onHubChanged: setHub,
	});
	const providerState = report?.checks.find(check => check.id === 'provider')?.state;
	const provider: ProviderBadge = {label: getProvider(config.provider).label, state: providerState ?? 'checking'};

	const activeRun = activeRunId === null ? null : runs[activeRunId] ?? null;
	const panelRun = activeRun ?? (lastRunId === null ? null : runs[lastRunId] ?? null);

	// What the TUI waits for from the user, if anything: the next unanswered question, or the improvements decision.
	const pending = (() => {
		if (!activeRun) return null;
		if (activeRun.status === 'waiting' && activeRun.questions.length > 0) {
			const index = Math.min(answers.length, activeRun.questions.length - 1);
			const question = activeRun.questions[index]!;
			return {kind: 'question' as const, key: `q-${activeRun.id}-${index}`, index, question, count: question.options.length, initial: question.recommended ?? 0};
		}
		if (activeRun.status === 'improvements' && activeRun.improvements?.state === 'pending') {
			return {kind: 'improvements' as const, key: `i-${activeRun.id}`, count: IMPROVEMENT_CHOICES.length, initial: activeRun.improvements?.tests?.state === 'fail' ? 2 : 0};
		}
		return null;
	})();
	const choice = pending ? (choiceState.key === pending.key ? choiceState.index : pending.initial) : 0;
	const moveChoice = (step: 1 | -1) => {
		if (!pending || pending.count === 0) return;
		setChoiceState(previous => {
			const current = previous.key === pending.key ? previous.index : pending.initial;
			return {key: pending.key, index: (current + step + pending.count) % pending.count};
		});
	};
	const interaction: Interaction | null = !pending
		? null
		: pending.kind === 'question'
			? {kind: 'question', runId: activeRun!.id, index: pending.index, total: activeRun!.questions.length, question: pending.question, selected: choice}
			: {kind: 'improvements', runId: activeRun!.id, selected: choice};

	const layout = computeLayout(columns, rows);
	const bodyWidth = layout.kind === 'ok' ? columns - layout.sidePanel : columns;
	const chatWidth = Math.max(1, bodyWidth - 2);
	// The spinner and the clock are cells that redraw themselves from the shared ticker (src/ui/ticker.ts);
	// a tick never re-renders the App. With motion off only the clock moves, once a second.
	useEffect(() => setTickInterval(config.motion ? SPINNER_MS : 1000), [config.motion]);
	useEffect(() => props.services.setMouse?.(config.mouse), [config.mouse]);
	const live: Live = {motion: config.motion};


	// Each message is laid out once per change of what it shows: a finished run or a note is not laid out again
	// when the spinner moves or another run streams events. Only the working run's block is redone.
	const lineCache = useRef(new Map<number, {key: unknown[]; lines: Line[]}>());
	const transcript = (() => {
		const lines: Line[] = [];
		const seen = new Set<number>();
		for (const message of messages) {
			seen.add(message.id);
			const run = message.kind === 'run' ? runs[message.runId] : undefined;
			const ownInteraction = run && interaction?.runId === run.id ? interaction : null;
			const key: unknown[] = [chatWidth, theme, run, ownInteraction?.kind, ownInteraction?.selected, ownInteraction?.kind === 'question' ? ownInteraction.index : null];
			if (run && isActive(run)) key.push(live.motion);
			const cached = lineCache.current.get(message.id);
			let messageLines = cached && cached.key.length === key.length && cached.key.every((value, index) => value === key[index]) ? cached.lines : null;
			if (!messageLines) {
				messageLines = transcriptLines([message], chatWidth, theme, {runs, interaction: ownInteraction, live});
				lineCache.current.set(message.id, {key, lines: messageLines});
			}
			if (lines.length > 0) lines.push([]);
			lines.push(...messageLines);
		}
		for (const id of lineCache.current.keys()) if (!seen.has(id)) lineCache.current.delete(id);
		return lines;
	})();

	const overlayLines = (frameworkView: {lines: Line[]}, listView: {lines: Line[]}): Line[] => {
		const inner = bodyWidth - 4;
		switch (overlay) {
			case 'help':
				return helpLines(inner, theme);
			case 'doctor':
				return doctorLines(doctor, inner, theme);
			case 'framework':
				return frameworkView.lines;
			case 'settings':
				return settingsLines(config, settingsIndex, inner, theme);
			case 'plans':
			case 'records':
			case 'resume':
				return listView.lines;
			default:
				return [];
		}
	};

	// ---------- runs ----------

	const pendingRuns = useRef(new Map<number, RunState>());
	const flushTimer = useRef<NodeJS.Timeout | null>(null);
	const flushRuns = () => {
		if (flushTimer.current) clearTimeout(flushTimer.current);
		flushTimer.current = null;
		if (pendingRuns.current.size === 0) return;
		const updates = Object.fromEntries(pendingRuns.current);
		pendingRuns.current.clear();
		setRuns(current => ({...current, ...updates}));
	};
	useEffect(() => () => void (flushTimer.current && clearTimeout(flushTimer.current)), []);

	const watch = (controller: RunController) => {
		const id = controller.state.id;
		controllers.current.set(id, controller);
		setRuns(current => ({...current, [id]: controller.state}));
		setActiveRunId(id);
		setLastRunId(id);
		setAnswers([]);
		let savedAs = '';
		let lastStatus = controller.state.status;
		controller.subscribe(state => {
			// Busy runs report many events per second; drawing each one would keep a CPU core busy for nothing.
			// The state is handed to React at most every FLUSH_MS, and at once when the status changes.
			pendingRuns.current.set(id, state);
			if (state.status !== lastStatus) {
				lastStatus = state.status;
				flushRuns();
			} else if (!flushTimer.current) {
				flushTimer.current = setTimeout(flushRuns, FLUSH_MS);
			}
			if (state.quota.after) setQuota(state.quota.after);
			if (state.kind === 'chat') {
				if (state.sessionId) chatSession.current = state.sessionId;
				if (state.suggestion && state.status !== 'running') setEditor(setValue(state.suggestion));
			} else {
				// Saved for /resume whenever the session or the status changes, not on every tool call.
				const key = `${state.sessionId}|${state.status}|${state.questions.length}`;
				if (state.sessionId && key !== savedAs) {
					savedAs = key;
					props.services.saveRun?.(controller.persisted());
				}
			}
			if (state.status === 'done' || state.status === 'failed' || state.status === 'stopped') {
				setActiveRunId(current => (current === id ? null : current));
				refreshHub();
			}
		});
		addMessages([{kind: 'run', runId: id}]);
		void controller.start();
	};

	/** Python and a ready provider are required before anything is sent; the user gets the reason otherwise. */
	const runBlocker = (kind: RunKind): string | null => {
		if (!props.services.startRun) return 'Bản này chưa nối với provider.';
		if (activeRunId !== null) return 'Đang có run chưa xong. Đợi run xong, trả lời câu hỏi của run, hoặc nhấn Esc để dừng.';
		if (!hub) return `Không có Hub: ${props.info.hubError ?? 'lỗi không rõ'}.`;
		if (!report) return 'Đang kiểm tra môi trường; thử lại sau giây lát.';
		const providerCheck = report?.checks.find(check => check.id === 'provider');
		if (providerCheck?.state === 'fail') return `${providerCheck.label} chưa sẵn sàng (${providerCheck.detail}). Gõ /doctor để xem cách xử lý.`;
		if (kind !== 'chat' && report && !report.python) return 'Không tìm thấy Python 3.9+; các công cụ của framework cần Python. Gõ /doctor để xem cách xử lý.';
		return null;
	};

	const recentOutputs = () =>
		Object.values(runs)
			.filter(run => run.kind !== 'chat' && run.status === 'done')
			.flatMap(run => [run.outputs.planSet, run.outputs.planFile, run.outputs.report].filter((path): path is string => !!path))
			.slice(-6);

	const startRun = (kind: RunKind, request: string): string | null => {
		const blocker = runBlocker(kind);
		if (blocker) return blocker;
		const controller = props.services.startRun!({
			id: newId(),
			kind,
			request,
			config,
			python: report?.python ?? null,
			// Chat messages continue one provider session, so the coordinator keeps the conversation's context.
			resume: kind === 'chat' && chatSession.current ? {sessionId: chatSession.current, prompt: request} : undefined,
			recentOutputs: kind === 'chat' ? recentOutputs() : undefined,
		});
		watch(controller);
		return null;
	};

	/** The runs /resume offers: stopped, failed or waiting ones that have a provider session. */
	const resumableRuns = () => (props.services.runs?.() ?? []).filter(run => resumable(run));

	const resumeRun = (last: PersistedRun): NewMessage => {
		const blocker = runBlocker(last.kind);
		if (blocker) return {kind: 'note', tone: 'error', text: blocker};
		const controller = props.services.startRun!({
			id: newId(),
			kind: last.kind,
			request: last.request,
			config,
			python: report?.python ?? null,
			resume: {
				sessionId: last.sessionId!,
				status: last.status,
				questions: last.questions,
				before: last.before,
				providerTotals: last.providerTotals,
				key: last.key,
				startedAt: last.startedAt,
			},
		});
		watch(controller);
		return {kind: 'note', tone: 'info', text: `Chạy tiếp ${LAYER_LABELS[last.kind]}: ${last.request}`};
	};

	const copyLatest = async () => {
		const run = [...Object.values(runs)].reverse().find(item => item.reply);
		if (!run?.reply) {
			addMessages([{kind: 'note', tone: 'info', text: 'Chưa có câu trả lời nào để copy.'}]);
			return;
		}
		const how = props.services.clipboard ? await props.services.clipboard.copy(run.reply) : 'failed';
		addMessages([
			how === 'failed'
				? {kind: 'note', tone: 'error', text: 'Không copy được: không tìm thấy công cụ clipboard của hệ thống.'}
				: {kind: 'note', tone: 'success', text: how === 'native' ? 'Đã copy câu trả lời gần nhất vào clipboard.' : 'Đã gửi câu trả lời gần nhất tới clipboard qua terminal.'},
		]);
	};

	const pasteClipboard = async () => {
		const text = props.services.clipboard ? await props.services.clipboard.paste() : null;
		if (text) setEditor(current => insert(current, text));
		else addMessages([{kind: 'note', tone: 'warning', text: 'Không đọc được clipboard. Dùng phím dán của terminal (chuột phải, Ctrl+Shift+V).'}]);
	};

	const list = useListOverlay();
	// What /plans, /records and /resume list: read once when the panel opens, not on every frame.
	const listContent = useMemo((): {entries: ListEntry[]; header: Line[]} | null => {
		const target = props.info.target.kind === 'git' ? props.info.target.root : null;
		const width = Math.max(20, bodyWidth - 4);
		const intro = (text: string) => hanging([], text, width, {dim: true});
		const unreadable = () => hanging([{text: `${theme.glyphs.fail} `, color: 'danger'}], 'Không đọc được Hub.', width);
		switch (overlay) {
			case 'plans': {
				if (!target || !props.services.plans) return {entries: [], header: unreadable()};
				const packages = props.services.plans();
				const header = intro(`Đọc trong Hub${hub ? ` (${displayPath(hub.path)})` : ''}: các Plan package có target_repo là repo hiện tại. Enter để xem một Plan hoặc report.`);
				if (packages.length === 0) header.push(blank, ...hanging([{text: `${theme.glyphs.pending} `, dim: true}], 'Chưa có Plan nào cho repo này. Gõ /pirl-plan <request> để tạo.', width));
				return {entries: planEntries(packages, theme), header};
			}
			case 'records': {
				const records = props.services.records?.() ?? null;
				if (!records) return {entries: [], header: unreadable()};
				const header = intro('Record tự đánh giá của các run trên repo này, mới nhất trước (đọc trong Hub, .agents/evals/records/). Enter để xem chi tiết.');
				if (records.length === 0) header.push(blank, ...hanging([{text: `${theme.glyphs.pending} `, dim: true}], 'Chưa có record nào.', width));
				return {entries: recordEntries(records, theme), header};
			}
			case 'resume':
				return {
					entries: resumeEntries(resumableRuns(), theme, run => {
						setOverlay(null);
						addMessages([{kind: 'user', text: `/resume ${LAYER_LABELS[run.kind]}: ${run.request.split('\n')[0]!.slice(0, 80)}`}, resumeRun(run)]);
					}),
					header: intro('Chọn run muốn chạy tiếp, mới nhất trước. Run chạy tiếp đúng session của provider mà nó đã dừng.'),
				};
			default:
				return null;
		}
		// Read again when the panel opens or the window width changes.
	}, [overlay, bodyWidth, theme]);

	// ---------- heights ----------
	const suggestions = overlay || interaction ? [] : suggestCommands(editor.value);
	useEffect(() => setPaletteIndex(0), [editor.value]);
	const headerHeight = layout.kind === 'ok' && layout.header !== 'hidden' ? 1 : 0;
	const inputLinesShown = layout.kind === 'ok' ? inputHeight(editor, columns - 4, layout.inputMaxLines, theme) : 1;
	const inputBoxHeight = inputLinesShown + 2;
	const statusHeight = 1;
	const room = rows - headerHeight - inputBoxHeight - statusHeight;
	const paletteShown = layout.kind === 'ok' ? Math.max(0, Math.min(suggestions.length, layout.paletteMax, room - 3)) : 0;
	const bodyHeight = Math.max(1, room - paletteShown);
	const overlayPage = Math.max(1, bodyHeight - 4);
	const frameworkView = overlay === 'framework' ? framework.view(bodyWidth - 4, bodyHeight - 3, theme) : {lines: [], top: 0};
	const listView = listContent ? list.view(listContent.entries, listContent.header, bodyWidth - 4, bodyHeight - 3, theme) : {lines: [], top: 0};
	const overlayContent = overlay ? overlayLines(frameworkView, listView) : [];
	// The first line of the last page: scrolling further down stops there, so one PgUp always moves back.
	const overlayMaxTop = Math.max(0, overlayContent.length - Math.max(1, bodyHeight - 3 - 1));

	const applyEffects = (effects: Effect[], echo: string) => {
		if (effects.some(effect => effect.type === 'clear')) {
			setMessages([{id: newId(), kind: 'welcome'}]);
			setScroll(0);
			return;
		}
		const added: NewMessage[] = [{kind: 'user', text: echo}];
		let afterwards: (() => void) | null = null;
		for (const effect of effects) {
			if (effect.type === 'note') added.push({kind: 'note', tone: effect.tone, text: effect.text, hint: effect.hint});
			if (effect.type === 'overlay') {
				setOverlay(effect.overlay);
				setOverlayTop(0);
				setSettingsIndex(0);
				if (effect.overlay === 'framework') framework.open();
				list.reset();
			}
			if (effect.type === 'doctor') startDoctor(false);
			if (effect.type === 'exit') exit();
			if (effect.type === 'copy') afterwards = () => void copyLatest();
			if (effect.type === 'resume') {
				afterwards = () => {
					if (resumableRuns().length === 0) addMessages([{kind: 'note', tone: 'info', text: 'Không có run nào đang dở.'}]);
					else if (activeRunId !== null) addMessages([{kind: 'note', tone: 'error', text: runBlocker('plan') ?? ''}]);
					else {
						list.reset();
						setOverlay('resume');
					}
				};
			}
			if (effect.type === 'run') {
				const kind = effect.kind;
				const request = effect.request;
				afterwards = () => {
					const blocker = startRun(kind, request);
					if (blocker) addMessages([{kind: 'note', tone: 'error', text: blocker}]);
				};
			}
		}
		addMessages(added);
		(afterwards as (() => void) | null)?.();
	};

	const submit = (raw: string) => {
		const parsed = parseInput(raw);
		if (parsed.kind === 'empty') return;
		setHistory(current => (current.at(-1) === raw ? current : [...current, raw]));
		setHistoryIndex(null);
		setEditor(emptyEditor);
		applyEffects(dispatch(parsed, {target: props.info.target}), raw.trim());
	};

	/** Enter while a run waits on the user: picks an option, or sends typed text as the answer. */
	const answerInteraction = (current: Interaction, typed: string) => {
		const controller = controllers.current.get(current.runId);
		if (!controller) return;
		setEditor(emptyEditor);
		if (current.kind === 'improvements') {
			const number = Number(typed);
			const index = typed && Number.isInteger(number) && number >= 1 && number <= IMPROVEMENT_CHOICES.length ? number - 1 : typed ? -1 : current.selected;
			if (index < 0) {
				addMessages([{kind: 'note', tone: 'warning', text: 'Chọn 1, 2 hoặc 3.'}]);
				return;
			}
			void controller.resolveImprovements(IMPROVEMENT_CHOICES[index]!.id);
			return;
		}
		const options = current.question.options;
		const number = Number(typed);
		const answer =
			typed === ''
				? options[current.selected] ?? ''
				: Number.isInteger(number) && number >= 1 && number <= options.length
					? options[number - 1]!
					: typed;
		if (!answer) return;
		const collected = [...answers, answer];
		addMessages([{kind: 'user', text: `${current.question.id}: ${answer}`}]);
		if (collected.length >= current.total) {
			setAnswers([]);
			void controller.answer(collected);
		} else {
			setAnswers(collected);
		}
	};

	const changeSetting = (step: 1 | -1) => {
		const key = settingsRows(config)[settingsIndex]!.key;
		const next = cycleSetting(config, key, step);
		setConfig(next);
		try {
			props.services.saveConfig(next);
		} catch (error) {
			addMessages([{kind: 'note', tone: 'error', text: `Không lưu được cài đặt: ${String(error)}`}]);
		}
	};

	const complete = (index: number) => {
		const spec = suggestCommands(editorRef.current.value)[index];
		if (spec) setEditor(setValue(`/${spec.name}${spec.takesRequest ? ' ' : ''}`));
	};

	// The run Ctrl+C has already asked to stop; a second Ctrl+C while it is still stopping closes the TUI.
	const stopRequested = useRef<number | null>(null);
	const stopActive = () => {
		if (activeRunId === null || stopRequested.current === activeRunId) return false;
		stopRequested.current = activeRunId;
		controllers.current.get(activeRunId)?.stop();
		return true;
	};

	const handleKey = (input: string, key: Key) => {
		const editor = editorRef.current;
		if (key.ctrl && input === 'c') {
			if (!stopActive()) exit();
			return;
		}
		if (overlay === 'framework') {
			if (!framework.handleKey(input, key, overlayPage)) setOverlay(null);
			return;
		}
		if (overlay && listContent) {
			if (!list.handleKey(input, key, overlayPage, listContent.entries)) setOverlay(null);
			return;
		}
		if (overlay) {
			if (key.escape) {
				setOverlay(null);
				return;
			}
			if (overlay === 'settings') {
				const count = settingsRows(config).length;
				if (key.upArrow) setSettingsIndex(index => (index - 1 + count) % count);
				else if (key.downArrow) setSettingsIndex(index => (index + 1) % count);
				else if (key.rightArrow || key.return || input === ' ') changeSetting(1);
				else if (key.leftArrow) changeSetting(-1);
				return;
			}
			if (key.upArrow) setOverlayTop(top => Math.max(0, Math.min(top, overlayMaxTop) - 1));
			else if (key.downArrow) setOverlayTop(top => Math.min(overlayMaxTop, top + 1));
			else if (key.pageUp) setOverlayTop(top => Math.max(0, Math.min(top, overlayMaxTop) - overlayPage));
			else if (key.pageDown) setOverlayTop(top => Math.min(overlayMaxTop, top + overlayPage));
			return;
		}

		const newline = (key.return && (key.shift || key.meta)) || (key.ctrl && input === 'j') || input === '\n' || MODIFIED_ENTER.test(input);
		if (newline) {
			setEditor(insert(editor, '\n'));
			return;
		}
		if (key.ctrl && input === 'v') {
			void pasteClipboard();
			return;
		}

		const suggestions = interaction ? [] : suggestCommands(editor.value);
		const paletteOpen = suggestions.length > 0;
		const recall = key.ctrl && (input === 'p' || input === 'n');
		if (key.upArrow || key.downArrow || recall) {
			const up = key.upArrow || input === 'p';
			const step = up ? -1 : 1;
			if (!recall && interaction && editor.value === '') {
				moveChoice(step);
				return;
			}
			if (!recall && paletteOpen) {
				setPaletteIndex(index => (index + step + suggestions.length) % suggestions.length);
				return;
			}
			// With the mouse left to the terminal its wheel arrives as ↑/↓, so they scroll the chat and
			// Ctrl+P/Ctrl+N recall what was typed.
			if (!recall && config.mouse === 'select') {
				scrollChat(up ? 1 : -1);
				return;
			}
			if (editor.value.includes('\n')) return;
			if (up && history.length > 0) {
				const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
				setHistoryIndex(index);
				setEditor(setValue(history[index]!));
			} else if (!up && historyIndex !== null) {
				const index = historyIndex + 1;
				setHistoryIndex(index >= history.length ? null : index);
				setEditor(index >= history.length ? emptyEditor : setValue(history[index]!));
			}
			return;
		}
		if (key.tab) {
			if (paletteOpen) complete(paletteIndex);
			return;
		}
		if (key.return) {
			if (editor.value.endsWith('\\')) {
				setEditor(insert(backspace(move(editor, 'end')), '\n'));
				return;
			}
			if (interaction && !editor.value.startsWith('/')) {
				answerInteraction(interaction, editor.value.trim());
				return;
			}
			if (paletteOpen) {
				const spec = suggestions[paletteIndex]!;
				if (spec.takesRequest) complete(paletteIndex);
				else submit(`/${spec.name}`);
				return;
			}
			submit(editor.value);
			return;
		}
		if (key.escape) {
			if (editor.value === '' && activeRun && ACTIVE.includes(activeRun.status)) {
				stopActive();
				return;
			}
			setEditor(emptyEditor);
			setHistoryIndex(null);
			return;
		}
		if (key.pageUp || key.pageDown) {
			scrollChat((key.pageUp ? 1 : -1) * Math.max(1, bodyHeight - 2));
			return;
		}
		if (key.backspace || key.delete) setEditor(backspace(editor));
		else if (key.leftArrow) setEditor(move(editor, 'left'));
		else if (key.rightArrow) setEditor(move(editor, 'right'));
		else if (key.home || (key.ctrl && input === 'a')) setEditor(move(editor, 'home'));
		else if (key.end || (key.ctrl && input === 'e')) setEditor(move(editor, 'end'));
		else if (key.ctrl && input === 'u') setEditor(emptyEditor);
		else if (input && !key.ctrl && !key.meta) setEditor(insert(editor, input));
	};

	/** Mouse wheel: three lines per notch in the chat or the open panel. */
	const WHEEL_LINES = 3;
	/** Scrolls the chat by `lines`: positive toward older lines. */
	const scrollChat = (lines: number) => setScroll(current => Math.max(0, Math.min(current + lines, Math.max(0, transcript.length - bodyHeight + 1))));
	const scrollByWheel = (notches: number) => {
		const lines = notches * WHEEL_LINES;
		if (overlay === 'framework') framework.wheel(lines);
		else if (overlay && listContent) list.wheel(lines, listContent.entries);
		else if (overlay === 'settings') return;
		else if (overlay) setOverlayTop(top => Math.max(0, Math.min(overlayMaxTop, Math.min(top, overlayMaxTop) - lines)));
		else scrollChat(lines);
	};

	useInput((raw, key) => {
		// Terminal replies and mouse reports are not typed text (src/ui/terminalInput.ts).
		const parsed = parseTerminalInput(raw);
		if (parsed.wheel !== 0) scrollByWheel(parsed.wheel);
		if (parsed.filtered && parsed.text === '') return;
		const input = parsed.text;
		// Typed text and Enter can reach the TUI in one chunk (fast typing, an input method, SSH). Ink passes such a
		// chunk on as text, which would turn Enter into a new line; split it so each Enter acts as the key.
		if (input.length > 1 && input.includes('\r') && !key.ctrl && !key.meta) {
			input.split('\r').forEach((part, index) => {
				if (index > 0) handleKey('\r', {...key, return: true});
				if (part) handleKey(part, key);
			});
			return;
		}
		handleKey(input, key);
	});

	usePaste(text => {
		if (!overlay) setEditor(current => insert(current, text));
	});

	if (layout.kind === 'too-small') return <TooSmall columns={columns} rows={rows} theme={theme} />;

	const chat = bottomWindow(transcript, bodyHeight, scroll);
	const chatLines: Line[] = [
		...(chat.above > 0 ? [[{text: `${theme.glyphs.up} ${chat.above} dòng cũ hơn (PgUp)`, dim: true}]] : []),
		...chat.lines,
		...(chat.below > 0 ? [[{text: `${theme.glyphs.down} ${chat.below} dòng mới hơn (PgDn)`, color: 'accent' as const}]] : []),
	];

	const g = theme.glyphs;
	const running = activeRun && ACTIVE.includes(activeRun.status);
	const hints = (
		overlay
			? overlay === 'settings'
				? [`${g.upDown} chọn`, `${g.leftRight} đổi`, 'Esc đóng']
				: overlay === 'framework'
					? framework.hints(theme)
					: listContent
						? list.hints(theme, overlay === 'resume' ? 'chạy tiếp' : 'xem')
					: [`${g.upDown} PgUp/PgDn cuộn`, 'Esc đóng']
			: interaction
				? [`${g.upDown} chọn`, 'Enter xác nhận']
				: running
					? ['Esc dừng run', 'PgUp/PgDn cuộn']
					: suggestions.length > 0
						? [`${g.upDown} chọn`, 'Tab hoàn thành', 'Enter chạy']
						: ['Enter gửi', 'Shift+Enter xuống dòng', '/help']
	).join(` ${g.sep} `);
	const totals = Object.values(runs).reduce(
		(sum, run) => ({
			calls: sum.calls + run.usage.calls,
			tokens: sum.tokens + totalTokens(run.usage),
			cost: sum.cost === null || run.usage.costUsd === null ? null : sum.cost + run.usage.costUsd,
		}),
		{calls: 0, tokens: 0, cost: 0 as number | null},
	);
	const cost = totals.tokens > 0 ? costText(totals.cost) : null;
	// Without the side panel, the usage windows go to the status line.
	const quotaShort = layout.kind === 'ok' && layout.sidePanel === 0 && quota ? quota.map(row => `${row.label} ${Math.round(row.percent)}%`).join(` ${g.sep} `) : null;
	const usage = [`${totals.calls} lượt gọi`, totals.tokens > 0 && `${compactTokens(totals.tokens)} token`, cost, quotaShort].filter(Boolean).join(` ${g.sep} `);
	const runText = activeRun ? `${LAYER_LABELS[activeRun.kind]}: ${STATUS_LABELS[activeRun.status]}` : doctor.state === 'running' ? 'đang kiểm tra môi trường' : 'không có run';
	const runWorking = activeRun !== null && isActive(activeRun);
	const status = statusLine(
		{usage, run: runText, hints, spinner: runWorking ? spinnerSpan(theme, config.motion, {color: 'accent'}) : undefined, clock: runWorking ? clockSpan(activeRun!.startedAt) : undefined},
		layout.status,
		columns,
		theme,
	);

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			{layout.header !== 'hidden' && <Header info={info} provider={provider} mode={layout.header} columns={columns} theme={theme} />}
			<Box flexDirection="row" height={bodyHeight}>
				{overlay ? (
					<Frame
						title={OVERLAY_TITLES[overlay]}
						hint="Esc đóng"
						lines={overlayContent}
						width={bodyWidth}
						height={bodyHeight}
						top={overlay === 'framework' ? frameworkView.top : listContent ? listView.top : overlayTop}
						theme={theme}
						active
					/>
				) : (
					<Box width={bodyWidth} height={bodyHeight} paddingX={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
						<Lines lines={chatLines} theme={theme} />
					</Box>
				)}
				{layout.sidePanel > 0 && (
					<SidePanel info={info} provider={provider} run={panelRun} live={live} extras={{model: modelText(config), quota}} width={layout.sidePanel} height={bodyHeight} theme={theme} />
				)}
			</Box>
			<InputBox editor={editor} columns={columns} maxLines={layout.inputMaxLines} theme={theme} focused={!overlay} placeholder={interaction ? (interaction.kind === 'question' ? 'Nhập câu trả lời, hoặc Enter để chọn mục đang trỏ' : 'Enter để chọn mục đang trỏ, hoặc gõ 1–3') : undefined} />
			{paletteShown > 0 && <Lines lines={paletteLines(suggestions, paletteIndex, paletteShown, columns, theme)} theme={theme} />}
			<Lines lines={[status]} theme={theme} />
		</Box>
	);
}
