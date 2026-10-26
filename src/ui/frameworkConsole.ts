import type {Key} from 'ink';
import {useRef, useState} from 'react';
import type {Config} from '../core/config.js';
import {plural, t} from '../core/i18n.js';
import {displayPath} from '../core/paths.js';
import type {HubStatus} from '../hub/hub.js';
import type {Conflict, Draft, HistoryEntry, LastUpdate, LocalChange} from '../hub/update.js';
import {definitionList} from './content.js';
import {blank, hanging, type Line, type Span} from './lines.js';
import type {FrameworkServices} from './session.js';
import {truncateMiddle} from './text.js';
import type {Theme} from './theme.js';

/**
 * The `/framework` console (proposal section 9): status, local improvements and their diffs, history, restoring a
 * file, updating to the framework bundled with the CLI through a checked draft, and undoing the last update.
 * Every change to the Hub asks first and is refused while a run is working.
 */

type Resolution = 'mine' | 'theirs' | 'merged' | 'edited';
type UpdateState = {draft: Draft; resolved: Record<string, Resolution>};

type Screen =
	| {name: 'home'; selected: number}
	| {name: 'busy'; label: string}
	| {name: 'changes'; items: LocalChange[]; selected: number}
	| {name: 'diff'; path: string; text: string}
	| {name: 'history'; items: HistoryEntry[]}
	| {
			name: 'confirm';
			title: string;
			body: string[];
			yes: string;
			action: () => Promise<Screen>;
			/** A second way to proceed, offered between `yes` and "No". */
			alt?: {label: string; action: () => Promise<Screen>};
			back: Screen;
			selected: number;
	  }
	| ({name: 'update'; selected: number} & UpdateState)
	| ({name: 'conflict'; conflict: Conflict; theirsDiff: string; mineDiff: string; selected: number; note?: string} & UpdateState)
	| ({name: 'proposal'; conflict: Conflict; content: string; explanation: string; diff: string; selected: number} & UpdateState)
	| ({name: 'manual'; conflict: Conflict; selected: number; note?: string} & UpdateState)
	| {name: 'result'; tone: 'success' | 'error'; text: string; detail?: string[]};

type HomeAction = {id: 'update' | 'changes' | 'history' | 'uncommitted' | 'undo'; label: string};

const resolutionLabel = (resolution: Resolution) =>
	({mine: t('giữ bản của bạn', 'keep yours'), theirs: t('lấy bản gốc mới', 'take the new original'), merged: t('dùng bản gộp của agent', 'use the agent\'s merge'), edited: t('đã sửa tay', 'edited by hand')})[resolution];
const conflictChoices = () => [t('Giữ bản của bạn', 'Keep yours'), t('Lấy bản gốc mới', 'Take the new original'), t('Để agent gộp hai bản', 'Let the agent merge both'), t('Tự sửa trong bản nháp', 'Edit the draft yourself')];
/** Files holding the core and safety rules: a conflict there gets no recommended choice; the user reads and decides. */
const SAFETY_FILES = new Set(['AGENTS.md']);

export type FrameworkConsoleProps = {
	services: FrameworkServices | undefined;
	hub: HubStatus | null;
	hubError: string | null;
	config: Config;
	python: {command: string; args: string[]} | null;
	/** A run is working or waiting: nothing may change the Hub under it. */
	runActive: boolean;
	onHubChanged(status: HubStatus): void;
};

export function useFrameworkConsole(props: FrameworkConsoleProps) {
	const [screen, setScreenState] = useState<Screen>({name: 'home', selected: 0});
	const [scroll, setScroll] = useState(0);
	const [undo, setUndo] = useState<LastUpdate | null>(null);
	const screenRef = useRef(screen);
	/** The last scroll position that still shows a full page, from the latest draw. */
	const maxTopRef = useRef(0);
	const setScreen = (next: Screen) => {
		screenRef.current = next;
		setScreenState(next);
		setScroll(0);
	};
	const services = props.services;
	const hub = props.hub;

	const homeActions = (): HomeAction[] => {
		if (!hub) return [];
		const actions: HomeAction[] = [];
		if (hub.uncommitted.length > 0) actions.push({id: 'uncommitted', label: t(`${hub.uncommitted.length} file chưa commit: commit hoặc bỏ`, `${hub.uncommitted.length} uncommitted ${plural(hub.uncommitted.length, 'file')}: commit or discard`)});
		if (hub.updateAvailable) actions.push({id: 'update', label: t(`Cập nhật lên fw-${hub.bundledVersion}`, `Update to fw-${hub.bundledVersion}`)});
		actions.push({id: 'changes', label: t('Xem cải tiến cục bộ (khác bản gốc)', 'Local improvements (differences from the original)')});
		actions.push({id: 'history', label: t('Lịch sử cải tiến', 'Improvement history')});
		if (undo) actions.push({id: 'undo', label: t(`Hoàn tác lần cập nhật lên ${undo.version}`, `Undo the update to ${undo.version}`)});
		return actions;
	};

	const refresh = async () => {
		if (!services) return;
		try {
			props.onHubChanged(await services.status());
			setUndo(await services.lastUpdate());
		} catch {}
	};

	const open = () => {
		setScreen({name: 'home', selected: 0});
		void refresh();
	};

	/** Runs one step against the Hub with a busy screen; an error ends on the result screen. */
	const step = (label: string, work: () => Promise<Screen>) => {
		setScreen({name: 'busy', label});
		work().then(
			next => {
				setScreen(next);
				void refresh();
			},
			(error: unknown) => {
				setScreen({name: 'result', tone: 'error', text: error instanceof Error ? error.message : String(error)});
				void refresh();
			},
		);
	};

	const blocked = (): string | null => (props.runActive ? t('Đang có run: đợi run xong rồi mới thay đổi Hub, vì run đã ghim phiên bản framework.', 'A run is going: wait for it before changing the Hub, because the run pinned the framework version.') : null);

	const openConflict = ({draft, resolved}: UpdateState, conflict: Conflict) =>
		step(t('Đang so sánh các bản', 'Comparing the versions'), async () => ({
			name: 'conflict',
			draft,
			resolved,
			conflict,
			theirsDiff: await services!.textDiff(conflict.base, conflict.theirs),
			mineDiff: await services!.textDiff(conflict.base, conflict.mine),
			selected: SAFETY_FILES.has(conflict.path) ? 0 : 2,
		}));

	const chooseHome = (action: HomeAction) => {
		if (!services || !hub) return;
		const home: Screen = {name: 'home', selected: (screenRef.current as {selected?: number}).selected ?? 0};
		switch (action.id) {
			case 'changes':
				step(t('Đang đọc khác biệt', 'Reading the difference'), async () => ({name: 'changes', items: await services.changes(), selected: 0}));
				return;
			case 'history':
				step(t('Đang đọc lịch sử', 'Reading the history'), async () => ({name: 'history', items: await services.history()}));
				return;
			case 'uncommitted': {
				const reason = blocked();
				if (reason) return setScreen({name: 'result', tone: 'error', text: reason});
				const files = hub.uncommitted;
				setScreen({
					name: 'confirm',
					title: t(`${files.length} file trong Hub chưa commit`, `${files.length} uncommitted ${plural(files.length, 'file')} in the Hub`),
					body: [
						...files.slice(0, 12),
						...(files.length > 12 ? [t(`… và ${files.length - 12} file khác`, `… and ${files.length - 12} more ${plural(files.length - 12, 'file')}`)] : []),
						'',
						t(
							'Cập nhật và khôi phục cần Hub sạch. Commit giữ các thay đổi này như cải tiến của bạn; bỏ thì chúng mất hẳn.',
							'Updating and restoring need a clean Hub. Committing keeps these changes as your improvements; discarding loses them for good.',
						),
					],
					yes: t('Commit các file này', 'Commit these files'),
					action: async () => {
						await services.commitUncommitted(files);
						return {name: 'result', tone: 'success', text: t(`Đã commit ${files.length} file vào Hub.`, `Committed ${files.length} ${plural(files.length, 'file')} to the Hub.`)};
					},
					alt: {
						label: t('Bỏ các file này', 'Discard these files'),
						action: async () => {
							await services.discardUncommitted(files);
							return {name: 'result', tone: 'success', text: t(`Đã bỏ thay đổi của ${files.length} file.`, `Discarded the changes of ${files.length} ${plural(files.length, 'file')}.`)};
						},
					},
					back: home,
					selected: 0,
				});
				return;
			}
			case 'update': {
				const reason = blocked();
				if (reason) return setScreen({name: 'result', tone: 'error', text: reason});
				step(t(`Đang gộp fw-${hub.bundledVersion} vào bản nháp`, `Merging fw-${hub.bundledVersion} into a draft`), async () => {
					const draft = await services.startUpdate();
					return {name: 'update', draft, resolved: {}, selected: 0};
				});
				return;
			}
			case 'undo': {
				const reason = blocked();
				if (reason) return setScreen({name: 'result', tone: 'error', text: reason});
				if (!undo) return;
				const later = undo.commits.slice(0, -1);
				setScreen({
					name: 'confirm',
					title: t(`Hoàn tác lần cập nhật lên ${undo.version}`, `Undo the update to ${undo.version}`),
					body: [
						t('Hub quay về đúng như trước lần cập nhật đó.', 'The Hub goes back to exactly how it was before that update.'),
						...(later.length > 0
							? ['', t(`${later.length} commit làm sau lần cập nhật cũng sẽ mất:`, `Also lost: ${later.length} ${plural(later.length, 'commit')} made after the update:`), ...later.slice(0, 8).map(commit => `- ${commit.subject}`)]
							: []),
						'',
						t(`Bản fw-${hub.bundledVersion} vẫn còn để cập nhật lại khi bạn muốn.`, `fw-${hub.bundledVersion} stays available to update again when you want.`),
					],
					yes: t('Hoàn tác', 'Undo'),
					action: async () => {
						await services.undo(undo.tag);
						return {name: 'result', tone: 'success', text: t(`Đã hoàn tác lần cập nhật lên ${undo.version}.`, `Undid the update to ${undo.version}.`)};
					},
					back: home,
					selected: 1,
				});
				return;
			}
		}
	};

	const conflictChoice = (current: Extract<Screen, {name: 'conflict'}>, index: number) => {
		const state: UpdateState = {draft: current.draft, resolved: current.resolved};
		const settle = (resolution: Resolution, choice: 'mine' | 'theirs' | {content: string | null}) =>
			step(t('Đang ghi lựa chọn vào bản nháp', 'Writing the choice into the draft'), async () => {
				await services!.resolve(current.draft, current.conflict.path, choice);
				return {name: 'update', draft: current.draft, resolved: {...current.resolved, [current.conflict.path]: resolution}, selected: 0};
			});
		if (index === 0) settle('mine', 'mine');
		else if (index === 1) settle('theirs', 'theirs');
		else if (index === 2) {
			step(t('Agent đang gộp hai bản', 'The agent is merging both versions'), async () => {
				const proposal = await services!.proposeMerge(current.draft, current.conflict, props.config);
				if (!proposal.ok) return {...current, note: t(`Agent không gộp được: ${proposal.error}`, `The agent could not merge: ${proposal.error}`)};
				return {
					name: 'proposal',
					...state,
					conflict: current.conflict,
					content: proposal.content,
					explanation: proposal.explanation,
					diff: await services!.textDiff(current.conflict.mine, proposal.content),
					selected: 0,
				};
			});
		} else setScreen({name: 'manual', ...state, conflict: current.conflict, selected: 0});
	};

	const apply = (current: Extract<Screen, {name: 'update'}>) =>
		step(t('Đang chạy test của framework trên bản nháp', 'Running the framework tests on the draft'), async () => {
			const result = await services!.finishUpdate(current.draft, props.python);
			if (result.ok) {
				return {
					name: 'result',
					tone: 'success',
					text: t(
						`Đã cập nhật lên ${result.tag}. Test của framework PASS trên bản nháp trước khi áp dụng. Có thể hoàn tác trong /framework.`,
						`Updated to ${result.tag}. The framework tests passed on the draft before it was applied. You can undo it in /framework.`,
					),
				};
			}
			if (result.unresolved) return {...current, selected: 0};
			return {name: 'result', tone: 'error', text: result.error, detail: result.output?.split('\n').filter(Boolean).slice(-8)};
		});

	const abort = (back: Screen) =>
		setScreen({
			name: 'confirm',
			title: t('Huỷ cập nhật?', 'Cancel the update?'),
			body: [t('Bản nháp bị xoá; Hub giữ nguyên như trước khi cập nhật.', 'The draft is deleted; the Hub stays as it was before the update.')],
			yes: t('Huỷ cập nhật', 'Cancel the update'),
			action: async () => {
				await services!.abortUpdate();
				return {name: 'home', selected: 0};
			},
			back,
			selected: 1,
		});

	/** Lines of the current screen, and the line to keep in view. */
	const content = (columns: number, theme: Theme): {lines: Line[]; focus: number | null} => {
		const g = theme.glyphs;
		const current = screen;
		if (!hub) return {lines: hanging([{text: `${g.fail} `, color: 'danger'}], props.hubError ?? t('Chưa có Hub.', 'No Hub yet.'), columns), focus: null};
		const menu = (labels: string[], selected: number, recommended?: number): {lines: Line[]; focus: number} => {
			let focus = 0;
			const lines: Line[] = [];
			labels.forEach((label, index) => {
				const active = index === selected;
				if (active) focus = lines.length;
				const text = index === recommended ? `${label} ${t('(khuyến nghị)', '(recommended)')}` : label;
				lines.push(...hanging([{text: active ? `${g.pointer} ` : '  ', color: 'accent'}, {text: `${index + 1}. `, color: active ? 'accent' : undefined, bold: active}], text, columns, active ? {color: 'accent', bold: true} : {}));
			});
			return {lines, focus};
		};
		const withMenu = (head: Line[], labels: string[], selected: number, recommended?: number) => {
			const choices = menu(labels, selected, recommended);
			return {lines: [...head, ...choices.lines], focus: head.length + choices.focus};
		};
		switch (current.name) {
			case 'home': {
				const rows = [
					{term: 'Hub', description: truncateMiddle(displayPath(hub.path), Math.max(12, columns - 22), g.ellipsis)},
					{term: t('Bản gốc đang dùng', 'Original in use'), description: hub.upstreamTag ?? t('không rõ', 'unknown')},
					{term: t('Cải tiến cục bộ', 'Local improvements'), description: t(`${hub.localImprovements} commit`, `${hub.localImprovements} ${plural(hub.localImprovements, 'commit')}`)},
					{term: t('Chưa commit', 'Uncommitted'), description: hub.uncommitted.length === 0 ? t('không có', 'none') : t(`${hub.uncommitted.length} file`, `${hub.uncommitted.length} ${plural(hub.uncommitted.length, 'file')}`)},
					{term: t('Bản đi kèm CLI', 'Bundled with the CLI'), description: `fw-${hub.bundledVersion}, ` + (hub.updateAvailable ? t('chưa có trong Hub', 'not in the Hub yet') : t('đang dùng', 'in use'))},
				];
				const head: Line[] = [...definitionList(rows, columns, 0), blank];
				if (hub.updateAvailable) {
					head.push(...hanging([{text: `${g.warn} `, color: 'warning'}], t(
							`Có framework fw-${hub.bundledVersion} đi kèm CLI. Cập nhật làm trên bản nháp, giữ cải tiến của bạn, và chỉ áp dụng khi test của framework PASS.`,
							`The CLI brings framework fw-${hub.bundledVersion}. The update works on a draft, keeps your improvements, and applies only when the framework tests pass.`,
						), columns), blank);
				}
				return withMenu(head, homeActions().map(action => action.label), current.selected);
			}
			case 'busy':
				return {lines: [[{text: `${g.running} ${current.label}…`, color: 'accent'}]], focus: null};
			case 'changes': {
				if (current.items.length === 0) return {lines: hanging([], t('Hub trùng bản gốc: không có cải tiến cục bộ.', 'The Hub matches the original: no local improvements.'), columns, {dim: true}), focus: null};
				const head = hanging([], t(`${current.items.length} file khác bản gốc ${hub.upstreamTag ?? ''}. Enter xem khác biệt.`, `Different from the original ${hub.upstreamTag ?? ''}: ${current.items.length} ${plural(current.items.length, 'file')}. Enter shows the difference.`), columns, {dim: true});
				const status = {modified: t('sửa', 'modified'), added: t('thêm', 'added'), deleted: t('xoá', 'deleted')};
				return withMenu([...head, blank], current.items.map(item => `${item.path}  (${status[item.status]}, +${item.added} −${item.removed})`), current.selected);
			}
			case 'diff':
				return {
					lines: [...hanging([], t(`${current.path}: bản gốc → bản của bạn. Nhấn r để khôi phục file này về bản gốc.`, `${current.path}: original → yours. Press r to restore this file to the original.`), columns, {dim: true}), blank, ...diffLines(current.text, columns)],
					focus: null,
				};
			case 'history':
				if (current.items.length === 0) return {lines: hanging([], t('Chưa có cải tiến nào ngoài bản gốc.', 'No improvements beyond the original yet.'), columns, {dim: true}), focus: null};
				return {
					lines: current.items.flatMap(item => [
						...hanging([{text: `${shortDate(item.date)}  `, color: 'accent'}], item.subject, columns, {bold: true}),
						...hanging([{text: '    '}], [item.source && `${t('nguồn', 'source')}: ${item.source}`, item.record && `record: ${item.record}`, item.hash.slice(0, 8)].filter(Boolean).join(' · '), columns, {dim: true}),
					]),
					focus: null,
				};
			case 'confirm':
				return withMenu(
					[...hanging([], current.title, columns, {bold: true}), blank, ...current.body.flatMap(line => (line ? hanging([], line, columns) : [blank])), blank],
					[current.yes, ...(current.alt ? [current.alt.label] : []), t('Không', 'No')],
					current.selected,
				);
			case 'update': {
				const {draft, resolved} = current;
				const auto = draft.changed.filter(path => !draft.conflicts.some(conflict => conflict.path === path));
				const head: Line[] = hanging([], t(`Bản nháp: ${draft.tag} gộp vào framework của bạn. Hub chưa thay đổi gì.`, `Draft: ${draft.tag} merged into your framework. The Hub has not changed.`), columns, {bold: true});
				head.push(blank, ...hanging([], t(`${auto.length} file bản gốc mới thay đổi, nhận tự động`, `${auto.length} ${plural(auto.length, 'file')} changed in the new original, taken as they are`) + (auto.length ? ':' : '.'), columns, {dim: true}));
				for (const path of auto.slice(0, 8)) head.push(...hanging([{text: '  '}], path, columns, {dim: true}));
				if (auto.length > 8) head.push(...hanging([{text: '  '}], t(`… và ${auto.length - 8} file khác`, `… and ${auto.length - 8} more ${plural(auto.length - 8, 'file')}`), columns, {dim: true}));
				const open = draft.conflicts.filter(conflict => !resolved[conflict.path]).length;
				if (draft.conflicts.length > 0) {
					head.push(...hanging([], t(
							`${draft.conflicts.length} file xung đột: cả bản gốc mới và cải tiến của bạn cùng sửa một đoạn. Chọn cách xử lý từng file:`,
							`Conflicts in ${draft.conflicts.length} ${plural(draft.conflicts.length, 'file')}: the new original and your improvements change the same passage. Choose how to handle each file:`,
						), columns), blank);
				}
				const labels = [
					...draft.conflicts.map(conflict => `${conflict.path}: ${resolved[conflict.path] ? resolutionLabel(resolved[conflict.path]!) : t('chưa chọn', 'not chosen')}`),
					open === 0 ? t('Chạy test của framework và áp dụng', 'Run the framework tests and apply') : t(`Chạy test và áp dụng (còn ${open} xung đột)`, `Run the tests and apply (${open} ${plural(open, 'conflict')} open)`),
					t('Huỷ cập nhật', 'Cancel the update'),
				];
				return withMenu([...head, blank], labels, current.selected);
			}
			case 'conflict': {
				const {conflict} = current;
				const head: Line[] = hanging([], t(`Xung đột: ${conflict.path}`, `Conflict: ${conflict.path}`), columns, {bold: true});
				head.push(blank, [{text: t('Bản gốc mới đổi:', 'The new original changes:'), color: 'accent'}], ...diffLines(current.theirsDiff, columns, 14));
				head.push(blank, [{text: t('Bản của bạn đổi:', 'Your version changes:'), color: 'accent'}], ...diffLines(current.mineDiff, columns, 14));
				for (const commit of conflict.myCommits.slice(0, 3)) {
					head.push(...hanging([{text: '  '}], `${t('từ', 'from')}: ${commit.subject}${commit.record ? ` (record ${commit.record})` : ''}`, columns, {dim: true}));
				}
				if (SAFETY_FILES.has(conflict.path)) head.push(blank, ...hanging([{text: `${g.warn} `, color: 'warning'}], t('File này chứa quy tắc lõi và quy tắc an toàn: đọc kỹ rồi tự chọn, không có lựa chọn khuyến nghị.', 'This file holds the core and safety rules: read carefully and choose yourself; there is no recommended choice.'), columns, {color: 'warning'}));
				if (current.note) head.push(blank, ...hanging([{text: `${g.fail} `, color: 'danger'}], current.note, columns, {color: 'danger'}));
				return withMenu([...head, blank], conflictChoices(), current.selected, SAFETY_FILES.has(conflict.path) ? undefined : 2);
			}
			case 'proposal': {
				const head: Line[] = hanging([], t(`Bản gộp của agent cho ${current.conflict.path}`, `The agent's merge of ${current.conflict.path}`), columns, {bold: true});
				if (current.explanation) head.push(blank, ...hanging([], current.explanation, columns));
				head.push(blank, [{text: t('So với bản của bạn:', 'Compared with yours:'), color: 'accent'}], ...diffLines(current.diff, columns, 30), blank);
				return withMenu(head, [t('Dùng bản gộp này', 'Use this merge'), t('Chọn cách khác', 'Choose another way')], current.selected);
			}
			case 'manual': {
				const path = displayPath(`${current.draft.dir}/${current.conflict.path}`);
				const head: Line[] = [
					...hanging([], t(`Sửa tay ${current.conflict.path}`, `Edit ${current.conflict.path} by hand`), columns, {bold: true}),
					blank,
					...hanging([], t(
						`Mở file trong bản nháp: ${path}. Sửa hết các đoạn giữa <<<<<<< và >>>>>>> (đoạn giữa ||||||| là bản gốc cũ), lưu file, rồi chọn "Đã sửa xong".`,
						`Open the file in the draft: ${path}. Resolve every passage between <<<<<<< and >>>>>>> (the part after ||||||| is the old original), save the file, then choose "Done editing".`,
					), columns),
				];
				if (current.note) head.push(blank, ...hanging([{text: `${g.fail} `, color: 'danger'}], current.note, columns, {color: 'danger'}));
				return withMenu([...head, blank], [t('Đã sửa xong', 'Done editing'), t('Chọn cách khác', 'Choose another way')], current.selected);
			}
			case 'result': {
				const lines = hanging([{text: `${current.tone === 'success' ? g.ok : g.fail} `, color: current.tone === 'success' ? 'success' : 'danger'}], current.text, columns);
				for (const line of current.detail ?? []) lines.push(...hanging([{text: '  '}], line, columns, {dim: true}));
				lines.push(blank, [{text: t('Enter hoặc Esc để quay lại.', 'Enter or Esc to go back.'), dim: true}]);
				return {lines, focus: null};
			}
		}
	};

	/** The current screen sized to the frame: `height` is the frame's content height. */
	const view = (columns: number, height: number, theme: Theme): {lines: Line[]; top: number} => {
		const {lines, focus} = content(columns, theme);
		const rows = Math.max(1, height - 2);
		const maxTop = Math.max(0, lines.length - rows);
		maxTopRef.current = maxTop;
		if (focus === null) return {lines, top: Math.min(scroll, maxTop)};
		// Keep the selected option in view, with the lines above it when they fit.
		const top = Math.min(maxTop, Math.max(0, focus - rows + 2));
		return {lines, top};
	};

	/** Keys while the console is open; returns false when Esc on the home screen closes it. */
	const handleKey = (input: string, key: Key, page: number): boolean => {
		const current = screenRef.current;
		if (current.name === 'busy') return true;
		const count = current.name === 'home' ? homeActions().length : optionCount(current);
		const select = (selected: number) => setScreen({...current, selected} as Screen);
		if (key.escape) {
			switch (current.name) {
				case 'home':
					return false;
				case 'changes':
				case 'history':
				case 'result':
					setScreen({name: 'home', selected: 0});
					return true;
				case 'diff':
					step(t('Đang đọc khác biệt', 'Reading the difference'), async () => ({name: 'changes', items: await services!.changes(), selected: 0}));
					return true;
				case 'confirm':
					setScreen(current.back);
					return true;
				case 'update':
					abort(current);
					return true;
				case 'conflict':
				case 'proposal':
				case 'manual':
					setScreen({name: 'update', draft: current.draft, resolved: current.resolved, selected: 0});
					return true;
			}
		}
		if (count > 0 && 'selected' in current) {
			if (key.upArrow) return select((current.selected - 1 + count) % count), true;
			if (key.downArrow) return select((current.selected + 1) % count), true;
			const number = Number(input);
			if (Number.isInteger(number) && number >= 1 && number <= count) return select(number - 1), true;
		} else {
			const clamp = (top: number) => Math.max(0, Math.min(maxTopRef.current, top));
			if (key.upArrow) setScroll(top => clamp(top - 1));
			else if (key.downArrow) setScroll(top => clamp(top + 1));
			else if (key.pageUp) setScroll(top => clamp(top - page));
			else if (key.pageDown) setScroll(top => clamp(top + page));
		}
		if (current.name === 'diff' && input === 'r') {
			const reason = blocked();
			if (reason) return setScreen({name: 'result', tone: 'error', text: reason}), true;
			setScreen({
				name: 'confirm',
				title: t(`Khôi phục ${current.path} về bản gốc?`, `Restore ${current.path} to the original?`),
				body: [t('Cải tiến cục bộ của file này được thay bằng bản gốc, trong một commit mới. Lịch sử vẫn giữ commit cũ.', 'The local improvements of this file are replaced by the original in a new commit. The history keeps the old commits.')],
				yes: t('Khôi phục', 'Restore'),
				action: async () => {
					await services!.restore(current.path);
					return {name: 'result', tone: 'success', text: t(`Đã khôi phục ${current.path} về bản gốc.`, `Restored ${current.path} to the original.`)};
				},
				back: current,
				selected: 1,
			});
			return true;
		}
		if (!key.return) return true;
		switch (current.name) {
			case 'home': {
				const action = homeActions()[current.selected];
				if (action) chooseHome(action);
				return true;
			}
			case 'changes': {
				const item = current.items[current.selected];
				if (item) step(t('Đang đọc khác biệt', 'Reading the difference'), async () => ({name: 'diff', path: item.path, text: await services!.diff(item.path)}));
				return true;
			}
			case 'result':
				setScreen({name: 'home', selected: 0});
				return true;
			case 'confirm':
				if (current.selected === 0) step(t('Đang thực hiện', 'Working'), current.action);
				else if (current.alt && current.selected === 1) step(t('Đang thực hiện', 'Working'), current.alt.action);
				else setScreen(current.back);
				return true;
			case 'update': {
				const conflicts = current.draft.conflicts;
				if (current.selected < conflicts.length) openConflict(current, conflicts[current.selected]!);
				else if (current.selected === conflicts.length) apply(current);
				else abort(current);
				return true;
			}
			case 'conflict':
				conflictChoice(current, current.selected);
				return true;
			case 'proposal':
				if (current.selected === 0) {
					step(t('Đang ghi bản gộp vào bản nháp', 'Writing the merge into the draft'), async () => {
						await services!.resolve(current.draft, current.conflict.path, {content: current.content});
						return {name: 'update', draft: current.draft, resolved: {...current.resolved, [current.conflict.path]: 'merged'}, selected: 0};
					});
				} else openConflict(current, current.conflict);
				return true;
			case 'manual': {
				if (current.selected === 1) {
					openConflict(current, current.conflict);
					return true;
				}
				const text = services!.readDraft(current.draft, current.conflict.path);
				step(t('Đang ghi bản đã sửa', 'Writing the edited version'), async () => {
					try {
						await services!.resolve(current.draft, current.conflict.path, {content: text});
					} catch (error) {
						return {...current, note: error instanceof Error ? error.message : String(error)};
					}
					return {name: 'update', draft: current.draft, resolved: {...current.resolved, [current.conflict.path]: 'edited'}, selected: 0};
				});
				return true;
			}
			default:
				return true;
		}
	};

	/** Mouse wheel: scrolls the screens that scroll; on a list the arrow keys choose instead. */
	const wheel = (lines: number) => {
		if ('selected' in screenRef.current) return;
		setScroll(top => Math.max(0, Math.min(maxTopRef.current, top - lines)));
	};

	const hints = (theme: Theme): string[] => {
		const g = theme.glyphs;
		switch (screen.name) {
			case 'busy':
				return [t('Đang làm…', 'Working…')];
			case 'diff':
				return [`${g.upDown} PgUp/PgDn ${t('cuộn', 'scroll')}`, t('r khôi phục', 'r restore'), t('Esc quay lại', 'Esc back')];
			case 'history':
				return [`${g.upDown} PgUp/PgDn ${t('cuộn', 'scroll')}`, t('Esc quay lại', 'Esc back')];
			case 'result':
				return [t('Enter quay lại', 'Enter back')];
			default:
				return [`${g.upDown} ${t('chọn', 'choose')}`, t('Enter mở', 'Enter open'), screen.name === 'home' ? t('Esc đóng', 'Esc close') : t('Esc quay lại', 'Esc back')];
		}
	};

	return {open, view, handleKey, hints, wheel};
}

function optionCount(screen: Screen): number {
	switch (screen.name) {
		case 'changes':
			return screen.items.length;
		case 'confirm':
			return screen.alt ? 3 : 2;
		case 'proposal':
		case 'manual':
			return 2;
		case 'update':
			return screen.draft.conflicts.length + 2;
		case 'conflict':
			return conflictChoices().length;
		default:
			return 0;
	}
}

/** A unified diff as styled lines, without Git's file headers; long diffs are cut at `limit` lines. */
export function diffLines(text: string, columns: number, limit = Infinity): Line[] {
	const body = text.split('\n').filter(line => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line));
	while (body.length > 0 && body.at(-1) === '') body.pop();
	if (body.length === 0) return [[{text: `  ${t('(không đổi gì)', '(no change)')}`, dim: true}]];
	const lines: Line[] = [];
	for (const line of body.slice(0, limit)) {
		const span: Span =
			line.startsWith('+') ? {text: line, color: 'success'} : line.startsWith('-') ? {text: line, color: 'danger'} : line.startsWith('@@') ? {text: line, color: 'accent'} : {text: line, dim: true};
		lines.push(...hanging([{text: '  '}], span.text, columns, {color: span.color, dim: span.dim}));
	}
	if (body.length > limit) lines.push([{text: `  ${t(`… còn ${body.length - limit} dòng`, `… ${body.length - limit} more ${plural(body.length - limit, 'line')}`)}`, dim: true}]);
	return lines;
}

const shortDate = (iso: string) => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const two = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};
