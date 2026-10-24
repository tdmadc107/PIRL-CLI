/** What a run does: one of the three layers, or a chat message (question, standalone task, framework maintenance). */
export type LayerKind = 'plan' | 'implement' | 'review';
export type RunKind = LayerKind | 'chat';

export const LAYER_LABELS: Record<RunKind, string> = {plan: 'Plan', implement: 'Implement', review: 'Review', chat: 'Chat'};

export type Usage = {calls: number; inputTokens: number; outputTokens: number};
export const emptyUsage = (): Usage => ({calls: 0, inputTokens: 0, outputTokens: 0});

/** Events a provider reports while it runs; the provider adapter turns its own output into these. */
export type RunEvent =
	| {type: 'session'; sessionId: string}
	| {type: 'role-start'; toolUseId: string; role: string; description: string}
	| {type: 'role-end'; toolUseId: string; ok: boolean}
	/** A tool call; `agent` is the role's toolUseId, or null for the coordinator. */
	| {type: 'activity'; agent: string | null; text: string}
	| {type: 'text'; text: string}
	| {type: 'retry'; attempt: number; error: string}
	| {type: 'denied'; detail: string}
	| {
			type: 'result';
			text: string;
			isError: boolean;
			sessionId: string | null;
			usage: {inputTokens: number; outputTokens: number};
	  };

/** A subagent the coordinator can delegate to: one per PIRL role. */
export type AgentDefinition = {description: string; prompt: string; tools: string[]};

export type Permissions = {allow: string[]; deny: string[]};

export type AgentRunRequest = {
	/** Working directory of the coordinator: the Hub. */
	cwd: string;
	/** Directories the run may also read (the target repository). */
	addDirs: string[];
	prompt: string;
	systemPrompt: string;
	agents: Record<string, AgentDefinition>;
	permissions: Permissions;
	/** Continue this provider session instead of starting a new one. */
	resumeSessionId?: string;
	model?: string;
};

export type RunHandle = {
	/** Resolves when the provider process ends; `code` is its exit code. */
	done: Promise<{code: number | null; stderr: string}>;
	stop(): void;
};

export type AgentRunner = {
	start(request: AgentRunRequest, onEvent: (event: RunEvent) => void): RunHandle;
};

/** A decision the coordinator needs from the user, sent in a `pirl-questions` block. */
export type Question = {id: string; question: string; options: string[]; recommended?: number};
