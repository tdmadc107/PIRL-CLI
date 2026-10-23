import type {GlyphSetting, ThemeSetting} from '../core/config.js';

/**
 * Design tokens (proposal 5.7). Components take every color and symbol from here and never write a color directly.
 * Colors are hex; Ink's color library lowers them to 256 or 16 colors when the terminal supports no more.
 */
export type ColorToken = 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'border' | 'user';

export const ROLE_IDS = [
	'business-analyst',
	'solution-architect',
	'code-analyst',
	'ux-designer',
	'backend-developer',
	'frontend-developer',
	'technical-writer',
	'code-reviewer',
	'process-auditor',
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

type Palette = Record<ColorToken, string> & {roles: Record<RoleId, string>};

const DARK: Palette = {
	accent: '#7aa2f7',
	success: '#9ece6a',
	warning: '#e0af68',
	danger: '#f7768e',
	muted: '#7f849c',
	border: '#565f89',
	user: '#bb9af7',
	roles: {
		'business-analyst': '#e0af68',
		'solution-architect': '#7dcfff',
		'code-analyst': '#7aa2f7',
		'ux-designer': '#ff9e64',
		'backend-developer': '#9ece6a',
		'frontend-developer': '#73daca',
		'technical-writer': '#c0caf5',
		'code-reviewer': '#f7768e',
		'process-auditor': '#bb9af7',
	},
};

const LIGHT: Palette = {
	accent: '#2e5bd8',
	success: '#2f7d32',
	warning: '#9a6700',
	danger: '#c62828',
	muted: '#6b7280',
	border: '#9ca3af',
	user: '#7c3aed',
	roles: {
		'business-analyst': '#9a6700',
		'solution-architect': '#0e7490',
		'code-analyst': '#2e5bd8',
		'ux-designer': '#c2410c',
		'backend-developer': '#2f7d32',
		'frontend-developer': '#0f766e',
		'technical-writer': '#4b5563',
		'code-reviewer': '#c62828',
		'process-auditor': '#7c3aed',
	},
};

export type Glyphs = {
	ok: string;
	warn: string;
	fail: string;
	info: string;
	running: string;
	pending: string;
	prompt: string;
	bullet: string;
	sep: string;
	ellipsis: string;
	pointer: string;
	up: string;
	down: string;
	/** Key names as the status bar and help show them. */
	upDown: string;
	leftRight: string;
};

const UNICODE_GLYPHS: Glyphs = {
	ok: '✔',
	warn: '▲',
	fail: '✖',
	info: 'ℹ',
	running: '▸',
	pending: '○',
	prompt: '›',
	bullet: '•',
	sep: '·',
	ellipsis: '…',
	pointer: '❯',
	up: '↑',
	down: '↓',
	upDown: '↑↓',
	leftRight: '←→',
};

const ASCII_GLYPHS: Glyphs = {
	ok: 'v',
	warn: '!',
	fail: 'x',
	info: 'i',
	running: '>',
	pending: 'o',
	prompt: '>',
	bullet: '-',
	sep: '|',
	ellipsis: '...',
	pointer: '>',
	up: '^',
	down: 'v',
	upDown: 'Up/Down',
	leftRight: 'Left/Right',
};

export type BorderStyle = 'round' | 'classic';

export type Theme = {
	mode: 'dark' | 'light';
	/** False under NO_COLOR: status still reads through glyphs and words. */
	color: boolean;
	unicode: boolean;
	glyphs: Glyphs;
	border: BorderStyle;
	/** Resolved color of a token, or undefined when colors are off. */
	fg(token: ColorToken): string | undefined;
	role(id: RoleId): string | undefined;
};

/** COLORFGBG is "foreground;background" with ANSI color numbers; backgrounds 7 and 9–15 are light. */
export function detectMode(env: NodeJS.ProcessEnv): 'dark' | 'light' {
	const background = Number(env['COLORFGBG']?.split(';').pop());
	if (!Number.isInteger(background)) return 'dark';
	return background === 7 || (background >= 9 && background <= 15) ? 'light' : 'dark';
}

/** Same decisions as the widely used is-unicode-supported: legacy Windows consoles get ASCII. */
export function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	if (platform !== 'win32') return env['TERM'] !== 'linux';
	return (
		Boolean(env['WT_SESSION']) ||
		Boolean(env['TERMINUS_SUBLIME']) ||
		env['ConEmuTask'] === '{cmd::Cmder}' ||
		env['TERM_PROGRAM'] === 'Terminus-Sublime' ||
		env['TERM_PROGRAM'] === 'vscode' ||
		env['TERM'] === 'xterm-256color' ||
		env['TERM'] === 'alacritty' ||
		env['TERM'] === 'rxvt-unicode' ||
		env['TERM'] === 'rxvt-unicode-256color' ||
		env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm'
	);
}

export function createTheme(
	settings: {theme: ThemeSetting; glyphs: GlyphSetting},
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Theme {
	const mode = settings.theme === 'auto' ? detectMode(env) : settings.theme;
	const color = !env['NO_COLOR'];
	const unicode = settings.glyphs === 'auto' ? detectUnicode(env, platform) : settings.glyphs === 'unicode';
	const palette = mode === 'light' ? LIGHT : DARK;
	return {
		mode,
		color,
		unicode,
		glyphs: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS,
		border: unicode ? 'round' : 'classic',
		fg: token => (color ? palette[token] : undefined),
		role: id => (color ? palette.roles[id] : undefined),
	};
}
