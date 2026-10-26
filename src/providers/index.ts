import type {ProviderId} from '../core/config.js';
import {t} from '../core/i18n.js';
import {claudeProvider} from './claude.js';
import type {Provider} from './types.js';

const planned = (id: ProviderId, label: string): Provider => ({
	id,
	label,
	available: false,
	detect: async () => ({installed: false, loggedIn: null, fix: t(`${label} sẽ được hỗ trợ ở giai đoạn sau.`, `${label} will be supported later.`)}),
});

/** Claude Code is the pilot provider; the others are listed so /settings can show what is coming. */
export const PROVIDERS: readonly Provider[] = [
	claudeProvider,
	planned('codex', 'Codex CLI'),
	planned('gemini', 'Gemini CLI'),
	planned('copilot', 'Copilot CLI'),
];

export function getProvider(id: ProviderId): Provider {
	return PROVIDERS.find(provider => provider.id === id) ?? claudeProvider;
}
