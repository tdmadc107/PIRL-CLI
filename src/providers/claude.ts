import {succeeded, type Exec} from '../core/exec.js';
import type {Provider, ProviderDetection} from './types.js';

const AUTH_LABELS: Record<string, string> = {
	oauth_token: 'tài khoản Claude (subscription)',
	claude_ai: 'tài khoản Claude (subscription)',
	api_key: 'API key',
};

export function parseAuthStatus(stdout: string): Pick<ProviderDetection, 'loggedIn' | 'authMethod'> {
	try {
		const data = JSON.parse(stdout) as {loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown};
		const method = typeof data.authMethod === 'string' ? data.authMethod : undefined;
		const viaCloud = typeof data.apiProvider === 'string' && data.apiProvider !== 'firstParty' ? data.apiProvider : undefined;
		return {
			loggedIn: data.loggedIn === true,
			authMethod: viaCloud ?? (method ? (AUTH_LABELS[method] ?? method) : undefined),
		};
	} catch {
		return {loggedIn: null};
	}
}

export const claudeProvider: Provider = {
	id: 'claude',
	label: 'Claude Code',
	available: true,
	async detect(exec: Exec): Promise<ProviderDetection> {
		const version = await exec('claude', ['--version'], {timeoutMs: 15_000});
		if (!succeeded(version)) {
			return {
				installed: false,
				loggedIn: null,
				fix: 'Cài Claude Code theo hướng dẫn tại https://code.claude.com/docs, rồi chạy `claude` một lần để đăng nhập.',
			};
		}
		// `claude auth status` reports sign-in state as JSON without exposing any credential.
		const status = await exec('claude', ['auth', 'status', '--json'], {timeoutMs: 15_000});
		const auth = succeeded(status) || status.stdout.trim() ? parseAuthStatus(status.stdout) : {loggedIn: null};
		return {
			installed: true,
			version: version.stdout.trim().split(/\s+/)[0],
			...auth,
			fix: auth.loggedIn === false ? 'Chạy `claude` (hoặc `claude auth login`) để đăng nhập bằng tài khoản của bạn.' : undefined,
		};
	},
};
