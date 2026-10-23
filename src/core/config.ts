import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'copilot'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ThemeSetting = 'auto' | 'dark' | 'light';
export type GlyphSetting = 'auto' | 'unicode' | 'ascii';

export type Config = {
	provider: ProviderId;
	theme: ThemeSetting;
	glyphs: GlyphSetting;
	/** How many independent roles of one layer run may call the provider at the same time. */
	maxParallelRoles: number;
};

export const DEFAULT_CONFIG: Config = {
	provider: 'claude',
	theme: 'auto',
	glyphs: 'auto',
	maxParallelRoles: 2,
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
		glyphs: oneOf(data['glyphs'], ['auto', 'unicode', 'ascii'] as const, DEFAULT_CONFIG.glyphs),
		maxParallelRoles:
			typeof parallel === 'number' && Number.isInteger(parallel) && parallel >= PARALLEL_LIMITS.min && parallel <= PARALLEL_LIMITS.max
				? parallel
				: DEFAULT_CONFIG.maxParallelRoles,
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
