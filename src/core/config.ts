import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'copilot'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ThemeSetting = 'auto' | 'dark' | 'light';
export type GlyphSetting = 'auto' | 'unicode' | 'ascii';
export const COLOR_SCHEME_IDS = ['pirl', 'ocean', 'forest', 'sunset', 'grape', 'mono'] as const;
export type ColorScheme = (typeof COLOR_SCHEME_IDS)[number];
/** Model aliases the provider resolves to its newest version; `default` leaves the choice to the provider. */
export const MODEL_IDS = ['sonnet', 'opus', 'fable', 'haiku', 'default'] as const;
export type ModelSetting = (typeof MODEL_IDS)[number];
/** `inherit` runs the roles on the coordinator's model. */
export const ROLE_MODEL_IDS = ['inherit', 'sonnet', 'opus', 'fable', 'haiku'] as const;
export type RoleModelSetting = (typeof ROLE_MODEL_IDS)[number];
/**
 * What the mouse does in the TUI:
 * - `select`: the terminal keeps the mouse, so dragging selects text as usual; the wheel reaches the TUI as the
 *   arrow keys (alternate scroll mode), which scroll the chat.
 * - `wheel`: the TUI receives the wheel itself; selecting text then needs Shift held while dragging.
 * - `off`: the TUI asks nothing of the mouse.
 */
export const MOUSE_IDS = ['select', 'wheel', 'off'] as const;
export type MouseSetting = (typeof MOUSE_IDS)[number];
export const EFFORT_IDS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortSetting = (typeof EFFORT_IDS)[number];

export type Config = {
	provider: ProviderId;
	theme: ThemeSetting;
	/** Accent, prompt and border colors (src/ui/theme.ts, COLOR_SCHEMES). */
	colors: ColorScheme;
	glyphs: GlyphSetting;
	/** Spinner while a run works; off leaves a still glyph and updates the clock once a second. */
	motion: boolean;
	mouse: MouseSetting;
	/** How many independent roles of one layer run may call the provider at the same time. */
	maxParallelRoles: number;
	/** Model of the coordinator, the main conversation of a run. */
	model: ModelSetting;
	/** Model of the role subagents. */
	roleModel: RoleModelSetting;
	/** Reasoning effort of the run; thinking counts as output tokens, the most expensive kind. */
	effort: EffortSetting;
};

export const DEFAULT_CONFIG: Config = {
	provider: 'claude',
	theme: 'auto',
	colors: 'pirl',
	glyphs: 'auto',
	motion: true,
	mouse: 'select',
	maxParallelRoles: 2,
	model: 'sonnet',
	roleModel: 'inherit',
	effort: 'default',
};

export const PARALLEL_LIMITS = {min: 1, max: 4} as const;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Keeps every valid field of a stored config and falls back to the default for the rest. */
export function normalizeConfig(raw: unknown): Config {
	const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const parallel = data['maxParallelRoles'];
	return {
		provider: oneOf(data['provider'], PROVIDER_IDS, DEFAULT_CONFIG.provider),
		theme: oneOf(data['theme'], ['auto', 'dark', 'light'] as const, DEFAULT_CONFIG.theme),
		colors: oneOf(data['colors'], COLOR_SCHEME_IDS, DEFAULT_CONFIG.colors),
		glyphs: oneOf(data['glyphs'], ['auto', 'unicode', 'ascii'] as const, DEFAULT_CONFIG.glyphs),
		motion: typeof data['motion'] === 'boolean' ? data['motion'] : DEFAULT_CONFIG.motion,
		// Earlier versions stored on or off.
		mouse: data['mouse'] === false ? 'off' : oneOf(data['mouse'], MOUSE_IDS, DEFAULT_CONFIG.mouse),
		maxParallelRoles:
			typeof parallel === 'number' && Number.isInteger(parallel) && parallel >= PARALLEL_LIMITS.min && parallel <= PARALLEL_LIMITS.max
				? parallel
				: DEFAULT_CONFIG.maxParallelRoles,
		model: oneOf(data['model'], MODEL_IDS, DEFAULT_CONFIG.model),
		roleModel: oneOf(data['roleModel'], ROLE_MODEL_IDS, DEFAULT_CONFIG.roleModel),
		effort: oneOf(data['effort'], EFFORT_IDS, DEFAULT_CONFIG.effort),
	};
}

export type LoadedConfig = {config: Config; warning?: string};

export function loadConfig(file: string): LoadedConfig {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return {config: {...DEFAULT_CONFIG}};
	}
	try {
		return {config: normalizeConfig(JSON.parse(text))};
	} catch {
		return {config: {...DEFAULT_CONFIG}, warning: `Không đọc được ${file}; đang dùng cài đặt mặc định`};
	}
}

/** Writes through a temporary file so an interrupted write never leaves a broken config. */
export function saveConfig(file: string, config: Config): void {
	mkdirSync(dirname(file), {recursive: true});
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', 'utf8');
	renameSync(temporary, file);
}
