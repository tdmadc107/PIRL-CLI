import type {ProviderId} from '../core/config.js';
import type {Exec} from '../core/exec.js';

export type ProviderDetection = {
	installed: boolean;
	version?: string;
	/** null when the provider offers no way to check sign-in without running a prompt. */
	loggedIn: boolean | null;
	/** How the user signed in, as the provider reports it (for example a subscription or an API key). */
	authMethod?: string;
	/** Installed, but older than the version PIRL needs. */
	outdated?: boolean;
	/** Plain-language next step when something is missing. */
	fix?: string;
};

/**
 * A provider is an agent CLI the user installed and signed in to themselves.
 * PIRL CLI only runs that CLI; it never reads, stores or forwards its credentials.
 * Detection lives here; running the coordinator is the job of the provider's runner (src/engine/claudeRunner.ts).
 */
export type Provider = {
	id: ProviderId;
	label: string;
	/** False until the provider's adapter is built; /settings shows it but cannot select it. */
	available: boolean;
	detect(exec: Exec): Promise<ProviderDetection>;
};
