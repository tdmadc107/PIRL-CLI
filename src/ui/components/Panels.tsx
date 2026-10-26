import {Box} from 'ink';
import {blank, hanging, type Line, type Span} from '../lines.js';
import {displayPath} from '../../core/paths.js';
import type {RunState} from '../../engine/run.js';
import type {QuotaRow} from '../../engine/types.js';
import {quotaPanelLines, runPanelLines, type Live} from '../runView.js';
import type {SessionInfo} from '../session.js';
import {padEnd, truncateEnd, truncateMiddle, width} from '../text.js';
import type {Theme} from '../theme.js';
import type {ProviderBadge} from './Header.js';
import {Lines, topWindow} from './Lines.js';
import {plural, t} from '../../core/i18n.js';

/** A bordered panel with a title row; content beyond its height scrolls and shows how much is hidden. */
export function Frame(props: {
	title: string;
	hint?: string;
	lines: Line[];
	width: number;
	height: number;
	/** First content line shown; content scrolls from the top. */
	top?: number;
	theme: Theme;
	active?: boolean;
}) {
	const {theme} = props;
	const inner = props.width - 4;
	const contentHeight = Math.max(0, props.height - 3);
	const window = topWindow(props.lines, contentHeight, props.top ?? 0);
	const title: Line = [{text: truncateEnd(props.title, Math.max(1, inner - (props.hint ? width(props.hint) + 2 : 0)), theme.glyphs.ellipsis), bold: true, color: 'accent'}];
	if (props.hint && width(props.title) + width(props.hint) + 2 <= inner) {
		title.push({text: ' '.repeat(inner - width(props.title) - width(props.hint))}, {text: props.hint, dim: true});
	}
	const body: Line[] = [
		...(window.above > 0 ? [[{text: `${theme.glyphs.up} ` + t(`còn ${window.above} dòng (PgUp)`, `${window.above} more ${plural(window.above, 'line')} (PgUp)`), dim: true}]] : []),
		...window.lines,
		...(window.below > 0 ? [[{text: `${theme.glyphs.down} ` + t(`còn ${window.below} dòng (PgDn)`, `${window.below} more ${plural(window.below, 'line')} (PgDn)`), dim: true}]] : []),
	];
	return (
		<Box
			borderStyle={theme.border}
			borderColor={theme.fg(props.active ? 'accent' : 'border')}
			paddingX={1}
			width={props.width}
			height={props.height}
			flexDirection="column"
			overflow="hidden"
		>
			<Lines lines={[title]} theme={theme} />
			<Lines lines={body} theme={theme} />
		</Box>
	);
}

/** What the side panel shows besides the session: the model settings and the plan's usage windows. */
export type PanelExtras = {model?: string; quota?: QuotaRow[] | null};

export function sidePanelLines(info: SessionInfo, provider: ProviderBadge, columns: number, theme: Theme, run: RunState | null = null, live?: Live, extras: PanelExtras = {}): Line[] {
	const g = theme.glyphs;
	const labelWidth = 11;
	const row = (label: string, value: string, extra: Partial<Span> = {}): Line[] => {
		const room = Math.max(4, columns - labelWidth);
		return [[{text: padEnd(label, labelWidth), dim: true}, {text: truncateMiddle(value, room, g.ellipsis), ...extra}]];
	};
	const target = info.target;
	const providerTone = {ok: 'success', warn: 'warning', fail: 'danger', checking: 'muted'} as const;
	const providerText = {ok: t('sẵn sàng', 'ready'), warn: t('cần kiểm tra', 'needs a check'), fail: t('chưa sẵn sàng', 'not ready'), checking: t('đang kiểm tra', 'checking')}[provider.state];
	const head: Line[] = [
		...(target.kind === 'git'
			? [...row('Repo', displayPath(target.root)), ...row(t('Nhánh', 'Branch'), target.branch ?? '—')]
			: row('Repo', target.reason, {color: 'warning'})),
		...row('Provider', `${provider.label} · ${providerText}`, {color: providerTone[provider.state]}),
		...(extras.model ? row('Model', extras.model) : []),
		...row('Framework', info.hub ? `${info.hub.upstreamTag ?? '—'} · ${t(`${info.hub.localImprovements} cải tiến`, `${info.hub.localImprovements} ${plural(info.hub.localImprovements, 'improvement')}`)}` : t('Hub lỗi', 'Hub error'), info.hub ? {} : {color: 'danger'}),
		blank,
		[{text: 'Run', bold: true}],
	];
	return [...head, ...runPanelLines(run, columns, theme, live), blank, [{text: t('Hạn mức', 'Usage limits'), bold: true}], ...quotaPanelLines(extras.quota ?? null, columns, theme)];
}

export function SidePanel(props: {info: SessionInfo; provider: ProviderBadge; run: RunState | null; live?: Live; extras?: PanelExtras; width: number; height: number; theme: Theme}) {
	return (
		<Frame
			title={t('Phiên làm việc', 'Session')}
			lines={sidePanelLines(props.info, props.provider, props.width - 4, props.theme, props.run, props.live, props.extras)}
			width={props.width}
			height={props.height}
			theme={props.theme}
		/>
	);
}

export type StatusParts = {usage: string; run: string; hints: string; spinner?: Span; clock?: Span};

export function statusLine(parts: StatusParts, mode: 'full' | 'usage' | 'single', columns: number, theme: Theme): Line {
	const sep = ` ${theme.glyphs.sep} `;
	if (mode === 'single') return [{text: truncateEnd(parts.usage, columns, theme.glyphs.ellipsis), dim: true}];
	const left: Span[] =
		mode === 'full'
			? [
					{text: `${parts.usage}${sep}`, dim: true},
					...(parts.spinner ? [parts.spinner, {text: ' '}] : []),
					{text: parts.run, dim: true},
					...(parts.clock ? [{text: sep, dim: true}, parts.clock] : []),
				]
			: [{text: parts.usage, dim: true}];
	const leftWidth = left.reduce((sum, span) => sum + width(span.text), 0);
	if (mode === 'usage' || leftWidth + width(parts.hints) + 2 > columns) {
		if (leftWidth <= columns) return left;
		return [{text: truncateEnd(mode === 'full' ? `${parts.usage}${sep}${parts.run}` : parts.usage, columns, theme.glyphs.ellipsis), dim: true}];
	}
	return [...left, {text: ' '.repeat(columns - leftWidth - width(parts.hints))}, {text: parts.hints, dim: true}];
}

export function TooSmall({columns, rows, theme}: {columns: number; rows: number; theme: Theme}) {
	const text =
		columns < 40
			? t(`Cửa sổ quá hẹp (${columns} cột). Hãy mở rộng tới ít nhất 40 cột.`, `The window is too narrow (${columns} columns). Widen it to at least 40 columns.`)
			: t(`Cửa sổ quá thấp (${rows} dòng). Hãy kéo cao tới ít nhất 10 dòng.`, `The window is too short (${rows} rows). Make it at least 10 rows tall.`);
	return (
		<Box width={columns} height={rows} flexDirection="column" justifyContent="center">
			<Lines lines={hanging([{text: `${theme.glyphs.warn} `, color: 'warning'}], text, Math.max(1, columns)).slice(0, rows)} theme={theme} />
		</Box>
	);
}
