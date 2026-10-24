/** What a run does: one of the three layers, or a chat message (question, standalone task, framework maintenance). */
export type LayerKind = 'plan' | 'implement' | 'review';
export type RunKind = LayerKind | 'chat';

export const LAYER_LABELS: Record<RunKind, string> = {plan: 'Plan', implement: 'Implement', review: 'Review', chat: 'Chat'};

/** Tokens of the model requests a run made, the coordinator's and every role's. */
export type TokenUsage = {
	/** Input the model processed fresh, outside the prompt cache. */
	inputTokens: number;
	/** Input written to the prompt cache: new context such as files read and tool results. */
	cacheWriteTokens: number;
	/** Input read back from the prompt cache: the whole context again on every request. */
	cacheReadTokens: number;
	/** Text, tool calls and thinking the model generated. */
	outputTokens: number;
};
export type Usage = TokenUsage & {
	/** Provider processes started (a run, each answer to its questions, each repair). */
	calls: number;
	/** Model requests seen in the stream; some role requests never show there, so it can fall short. */
	requests: number;
	/** The tokens priced at the Claude API list price, in USD; null when a model has no known price. */
	costUsd: number | null;
	models: string[];
};
/** One model's totals for a provider session, as the result reports them; `costUsd` is Claude Code's list-price estimate. */
export type ModelTotals = TokenUsage & {costUsd: number | null};

/** One usage window of the plan: `percent` of it used, 0-100. */
export type QuotaRow = {kind: string; label: string; percent: number; resetsAt: string | null};

export const emptyUsage = (): Usage => ({calls: 0, requests: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, models: []});
export const totalTokens = (usage: TokenUsage) => usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens;

/** Events a provider reports while it runs; the provider adapter turns its own output into these. */
export type RunEvent =
	| {type: 'session'; sessionId: string}
	| {type: 'role-start'; toolUseId: string; role: string; description: string}
	| {type: 'role-end'; toolUseId: string; ok: boolean}
	/** A tool call; `agent` is the role's toolUseId, or null for the coordinator. */
	| {type: 'activity'; agent: string | null; text: string}
	| {type: 'text'; text: string}
	| {type: 'retry'; attempt: number; error: string}
	/** Tokens of one model request, or the rest of a request already reported; `request` is true for its first report. */
	| ({type: 'usage'; model: string; request: boolean; costUsd: number | null} & TokenUsage)
	/** Totals per model of the whole provider session when a provider call ends; they include earlier calls of a resumed session. */
	| {type: 'usage-totals'; models: Record<string, ModelTotals>}
	/** The plan's usage windows, as the provider reported them during the call. */
	| {type: 'quota'; rows: QuotaRow[]}
	/** A refused tool call; `id` is its tool_use_id when known, so the same refusal reported twice counts once. */
	| {type: 'denied'; id: string | null; detail: string}
	| {
			type: 'result';
			text: string;
			isError: boolean;
			sessionId: string | null;
	  };

/** A subagent the coordinator can delegate to: one per PIRL role. */
export type AgentDefinition = {description: string; prompt: string; tools: string[]; model?: string; effort?: string};

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
	/** Model alias or ID of the coordinator; the provider's default when left out. */
	model?: string;
	effort?: string;
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
