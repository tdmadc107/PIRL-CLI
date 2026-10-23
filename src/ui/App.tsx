import {Box, useApp, useInput, usePaste, useWindowSize} from 'ink';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {dispatch, type OverlayKind} from '../commands/dispatch.js';
import {parseInput, suggestCommands} from '../commands/registry.js';
import type {Config} from '../core/config.js';
import type {DoctorReport} from '../doctor/doctor.js';
import {getProvider} from '../providers/index.js';
import {cycleSetting, doctorLines, frameworkLines, helpLines, settingsLines, settingsRows, transcriptLines} from './content.js';
import {Header, type ProviderBadge} from './components/Header.js';
import {InputBox, inputHeight, paletteLines} from './components/Input.js';
import {bottomWindow, Lines} from './components/Lines.js';
import {Frame, SidePanel, statusLine, TooSmall} from './components/Panels.js';
import {backspace, emptyEditor, insert, move, setValue, type EditorState} from './inputEditor.js';
import {computeLayout} from './layout.js';
import type {Line} from './lines.js';
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
};

/** One line after a clean start: the provider is signed in, plus the Python and Git versions found. */
function readySummary(report: DoctorReport): string {
	const provider = report.checks.find(check => check.id === 'provider');
	const git = report.checks.find(check => check.id === 'git');
	const parts = [provider ? `${provider.label} đã đăng nhập` : null, report.python ? `Python ${report.python.version}` : null, git ? `Git ${git.detail}` : null];
	return `Sẵn sàng: ${parts.filter(Boolean).join(' · ')}.`;
}

export function App(props: AppProps) {
	const {exit} = useApp();
	const {columns, rows} = useWindowSize();
	const [config, setConfig] = useState(props.initialConfig);
	const theme = useMemo(
		() => createTheme(config, props.env ?? process.env, props.platform ?? process.platform),
		[config.theme, config.glyphs, props.env, props.platform],
	);
	const nextId = useRef(0);
	const newId = () => nextId.current++;
	const [messages, setMessages] = useState<Message[]>(() => [
		{id: newId(), kind: 'welcome'},
		...(props.startupNotes ?? []).map(note => ({id: newId(), kind: 'note' as const, ...note})),
	]);
	const [editor, setEditor] = useState<EditorState>(emptyEditor);
	const [history, setHistory] = useState<string[]>([]);
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const [paletteIndex, setPaletteIndex] = useState(0);
	const [scroll, setScroll] = useState(0);
	const [overlay, setOverlay] = useState<OverlayKind | null>(null);
	const [overlayTop, setOverlayTop] = useState(0);
	const [settingsIndex, setSettingsIndex] = useState(0);
	const [doctor, setDoctor] = useState<DoctorState>({state: 'idle'});

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

	const suggestions = overlay ? [] : suggestCommands(editor.value);
	useEffect(() => setPaletteIndex(0), [editor.value]);

	const providerCheck = doctor.state === 'done' ? doctor.report.checks : doctor.state === 'running' ? doctor.previous?.checks : undefined;
	const providerState = providerCheck?.find(check => check.id === 'provider')?.state;
	const provider: ProviderBadge = {label: getProvider(config.provider).label, state: providerState ?? 'checking'};

	const layout = computeLayout(columns, rows);
	const bodyWidth = layout.kind === 'ok' ? columns - layout.sidePanel : columns;
	const chatWidth = Math.max(1, bodyWidth - 2);
	const transcript = useMemo(() => transcriptLines(messages, chatWidth, theme), [messages, chatWidth, theme]);

	const overlayLines = (): Line[] => {
		const inner = bodyWidth - 4;
		switch (overlay) {
			case 'help':
				return helpLines(inner, theme);
			case 'doctor':
				return doctorLines(doctor, inner, theme);
			case 'framework':
				return frameworkLines(props.info, inner, theme);
			case 'settings':
				return settingsLines(config, settingsIndex, inner, theme);
			default:
				return [];
		}
	};

	// ---------- heights ----------
	const headerHeight = layout.kind === 'ok' && layout.header !== 'hidden' ? 1 : 0;
	const inputLinesShown = layout.kind === 'ok' ? inputHeight(editor, columns - 4, layout.inputMaxLines, theme) : 1;
	const inputBoxHeight = inputLinesShown + 2;
	const statusHeight = 1;
	const room = rows - headerHeight - inputBoxHeight - statusHeight;
	const paletteShown = layout.kind === 'ok' ? Math.max(0, Math.min(suggestions.length, layout.paletteMax, room - 3)) : 0;
	const bodyHeight = Math.max(1, room - paletteShown);
	const overlayPage = Math.max(1, bodyHeight - 4);

	const submit = (raw: string) => {
		const parsed = parseInput(raw);
		if (parsed.kind === 'empty') return;
		setHistory(current => (current.at(-1) === raw ? current : [...current, raw]));
		setHistoryIndex(null);
		setEditor(emptyEditor);
		const effects = dispatch(parsed, {target: props.info.target});
		if (effects.some(effect => effect.type === 'clear')) {
			setMessages([{id: newId(), kind: 'welcome'}]);
			setScroll(0);
			return;
		}
		const added: NewMessage[] = [{kind: 'user', text: raw.trim()}];
		for (const effect of effects) {
			if (effect.type === 'note') added.push({kind: 'note', tone: effect.tone, text: effect.text, hint: effect.hint});
			if (effect.type === 'overlay') {
				setOverlay(effect.overlay);
				setOverlayTop(0);
				setSettingsIndex(0);
			}
			if (effect.type === 'doctor') startDoctor(false);
			if (effect.type === 'exit') exit();
		}
		addMessages(added);
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

	const complete = (index: number): string | null => {
		const spec = suggestions[index];
		if (!spec) return null;
		const text = `/${spec.name}${spec.takesRequest ? ' ' : ''}`;
		setEditor(setValue(text));
		return text;
	};

	useInput((input, key) => {
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
			if (key.upArrow) setOverlayTop(top => Math.max(0, top - 1));
			else if (key.downArrow) setOverlayTop(top => top + 1);
			else if (key.pageUp) setOverlayTop(top => Math.max(0, top - overlayPage));
			else if (key.pageDown) setOverlayTop(top => top + overlayPage);
			return;
		}

		const paletteOpen = suggestions.length > 0;
		if (key.upArrow || key.downArrow) {
			if (paletteOpen) {
				const step = key.upArrow ? -1 : 1;
				setPaletteIndex(index => (index + step + suggestions.length) % suggestions.length);
				return;
			}
			if (editor.value.includes('\n')) return;
			if (key.upArrow && history.length > 0) {
				const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
				setHistoryIndex(index);
				setEditor(setValue(history[index]!));
			} else if (key.downArrow && historyIndex !== null) {
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
			setEditor(emptyEditor);
			setHistoryIndex(null);
			return;
		}
		if (key.pageUp) {
			setScroll(current => Math.min(current + Math.max(1, bodyHeight - 2), Math.max(0, transcript.length - bodyHeight + 1)));
			return;
		}
		if (key.pageDown) {
			setScroll(current => Math.max(0, current - Math.max(1, bodyHeight - 2)));
			return;
		}
		if (key.backspace || key.delete) setEditor(backspace(editor));
		else if (key.leftArrow) setEditor(move(editor, 'left'));
		else if (key.rightArrow) setEditor(move(editor, 'right'));
		else if (key.home || (key.ctrl && input === 'a')) setEditor(move(editor, 'home'));
		else if (key.end || (key.ctrl && input === 'e')) setEditor(move(editor, 'end'));
		else if (key.ctrl && input === 'u') setEditor(emptyEditor);
		else if (input && !key.ctrl && !key.meta) setEditor(insert(editor, input));
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
	const hints = (
		overlay
			? overlay === 'settings'
				? [`${g.upDown} chọn`, `${g.leftRight} đổi`, 'Esc đóng']
				: [`${g.upDown} PgUp/PgDn cuộn`, 'Esc đóng']
			: suggestions.length > 0
				? [`${g.upDown} chọn`, 'Tab hoàn thành', 'Enter chạy']
				: ['Enter gửi', 'PgUp/PgDn cuộn', '/help']
	).join(` ${g.sep} `);
	const status = statusLine(
		{usage: '0 lượt gọi', run: doctor.state === 'running' ? 'đang kiểm tra môi trường' : 'không có run', hints},
		layout.status,
		columns,
		theme,
	);

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			{layout.header !== 'hidden' && <Header info={props.info} provider={provider} mode={layout.header} columns={columns} theme={theme} />}
			<Box flexDirection="row" height={bodyHeight}>
				{overlay ? (
					<Frame
						title={OVERLAY_TITLES[overlay]}
						hint="Esc đóng"
						lines={overlayLines()}
						width={bodyWidth}
						height={bodyHeight}
						top={overlayTop}
						theme={theme}
						active
					/>
				) : (
					<Box width={bodyWidth} height={bodyHeight} paddingX={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
						<Lines lines={chatLines} theme={theme} />
					</Box>
				)}
				{layout.sidePanel > 0 && <SidePanel info={props.info} provider={provider} width={layout.sidePanel} height={bodyHeight} theme={theme} />}
			</Box>
			<InputBox editor={editor} columns={columns} maxLines={layout.inputMaxLines} theme={theme} focused={!overlay} />
			{paletteShown > 0 && <Lines lines={paletteLines(suggestions, paletteIndex, paletteShown, columns, theme)} theme={theme} />}
			<Lines lines={[status]} theme={theme} />
		</Box>
	);
}
