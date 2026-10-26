import {Text} from 'ink';
import {plural, t} from '../../core/i18n.js';
import type {Line, Span} from '../lines.js';
import {lineWidth} from '../lines.js';
import type {SessionInfo} from '../session.js';
import {truncateEnd, truncateMiddle} from '../text.js';
import type {Theme} from '../theme.js';
import {Lines} from './Lines.js';

export type ProviderBadge = {label: string; state: 'ok' | 'warn' | 'fail' | 'checking'};

/**
 * One header row. When it does not fit, the update notice goes first, then the framework version;
 * then the repository name is shortened in the middle; the provider goes only when even that is not enough.
 */
export function headerLine(info: SessionInfo, provider: ProviderBadge, mode: 'full' | 'short', columns: number, theme: Theme): Line {
	const g = theme.glyphs;
	const sep: Span = {text: ` ${g.sep} `, color: 'border'};
	const target = info.target;
	const repoName = target.kind === 'git' ? target.name : t('không có git repo', 'no git repository');
	const branch = target.kind === 'git' && target.branch && mode === 'full' ? ` (${target.branch})` : '';
	const repoStyle: Partial<Span> = {bold: true, color: target.kind === 'git' ? undefined : 'warning'};
	const repo = (name: string, withBranch: boolean): Span[] => [{text: name, ...repoStyle}, ...(withBranch && branch ? [{text: branch, dim: true}] : [])];
	const glyph = {ok: g.ok, warn: g.warn, fail: g.fail, checking: g.pending}[provider.state];
	const tone = {ok: 'success', warn: 'warning', fail: 'danger', checking: 'muted'} as const;
	const providerSpans: Span[] = [{text: `${glyph} `, color: tone[provider.state]}, {text: provider.label}];
	const improvements = info.hub && info.hub.localImprovements > 0 ? t(` (+${info.hub.localImprovements} cải tiến)`, ` (+${info.hub.localImprovements} ${plural(info.hub.localImprovements, 'improvement')})`) : '';
	const framework: Span[] | null = mode === 'full' && info.hub ? [{text: `${info.hub.upstreamTag ?? 'framework'}${improvements}`, dim: true}] : null;
	// A newer CLI comes first: it brings its own framework, which /framework then offers.
	const update: Span[] | null = info.cliUpdate
		? [{text: `${g.warn} ` + t(`Có PIRL ${info.cliUpdate}`, `PIRL ${info.cliUpdate} is out`), color: 'warning'}]
		: info.hub?.updateAvailable
			? [{text: `${g.warn} ` + t('Có framework mới', 'New framework available'), color: 'warning'}]
			: null;
	const brand: Span[] = [{text: 'PIRL', color: 'accent', bold: true}];

	const join = (...parts: Array<Span[] | null>): Line => parts.filter((part): part is Span[] => part !== null).flatMap((part, index) => (index === 0 ? part : [sep, ...part]));
	const withRight = (left: Line, right: Span[]): Line => {
		const gap = columns - lineWidth(left) - lineWidth(right);
		return gap >= 2 ? [...left, {text: ' '.repeat(gap)}, ...right] : [];
	};
	const MIN_REPO = 8;
	const candidates: Array<() => Line> = [
		() => (update ? withRight(join(brand, repo(repoName, true), providerSpans, framework), update) : []),
		() => join(brand, repo(repoName, true), providerSpans, framework),
		() => join(brand, repo(repoName, true), providerSpans),
		() => join(brand, repo(repoName, false), providerSpans),
		() => {
			const room = columns - lineWidth(join(brand, [{text: ''}], providerSpans));
			return room >= MIN_REPO ? join(brand, repo(truncateMiddle(repoName, room, g.ellipsis), false), providerSpans) : [];
		},
		() => {
			const room = columns - lineWidth(join(brand, [{text: ''}]));
			return join(brand, repo(truncateMiddle(repoName, Math.max(1, room), g.ellipsis), false));
		},
	];
	for (const candidate of candidates) {
		const line = candidate();
		if (line.length > 0 && lineWidth(line) <= columns) return line;
	}
	return [{text: truncateEnd('PIRL', columns, g.ellipsis), color: 'accent', bold: true}];
}

export function Header(props: {info: SessionInfo; provider: ProviderBadge; mode: 'full' | 'short'; columns: number; theme: Theme}) {
	return props.columns > 0 ? <Lines lines={[headerLine(props.info, props.provider, props.mode, props.columns, props.theme)]} theme={props.theme} /> : <Text />;
}
