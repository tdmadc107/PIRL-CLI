import {createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream} from 'node:fs';
import {dirname, isAbsolute, join, relative} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';
import {plural, t} from '../core/i18n.js';
import {roleAgents} from './agents.js';
import {
	allowedPaths,
	changedPaths,
	commitImprovements,
	countRecords,
	discardImprovements,
	listPlanSets,
	outsideAllowed,
	readFrontmatter,
} from './hubData.js';
import {permissionsFor} from './permissions.js';
import {answersMessage, hostInstructions, parseOutputs, parseQuestions, parseSuggestion, stripBlocks, type RunOutputs} from './protocol.js';
import type {QuotaRow} from './claudeQuota.js';
import {emptyUsage, type ModelTotals, LAYER_LABELS, type AgentRunner, type LayerKind, type Question, type RunEvent, type RunHandle, type RunKind, type Usage} from './types.js';

export type RoleRun = {toolUseId: string; role: string; description: string; state: 'running' | 'done' | 'failed'; activity: string | null};

export type CheckResult = {state: 'pass' | 'fail' | 'skipped'; detail?: string};

export type RunStatus = 'running' | 'waiting' | 'checking' | 'improvements' | 'done' | 'failed' | 'stopped';

/** One line of the run's log; `at` is milliseconds since the run started, `who` a role, `coordinator` or `pirl`. */
export type LogEntry = {at: number; who: string; text: string; tone?: 'success' | 'warning' | 'error'};

export type RunState = {
	id: number;
	kind: RunKind;
	request: string;
	status: RunStatus;
	sessionId: string | null;
	roles: RoleRun[];
	/** Latest tool call of the coordinator itself. */
	activity: string | null;
	questions: Question[];
	answers: string[];
	/** The coordinator's final reply, without the machine-readable blocks. */
	reply: string | null;
	outputs: RunOutputs;
	checks: {validator?: CheckResult; record?: CheckResult; paths?: CheckResult};
	/** Framework files the run changed; `tests` is the framework's own test suite run on them before any commit. */
	improvements: {files: string[]; state: 'pending' | 'committed' | 'kept' | 'discarded'; tests?: CheckResult; error?: string} | null;
	suggestion: string | null;
	denials: string[];
	usage: Usage;
	/** The plan's usage meters when the run started and after its latest provider call; null when unknown. */
	quota: {before: QuotaRow[] | null; after: QuotaRow[] | null};
	error: string | null;
	/** When the run started (epoch ms), for the elapsed time. */
	startedAt: number;
	/** Milliseconds from the start to the latest log entry: how long the run took, once it ended. */
	lastAt: number;
	/** Where the whole log is written, when the run has a log directory. */
	logFile: string | null;
};

/** The Hub and target before a run started; changes after it are this run's. */
export type RunSnapshot = {hubChanges: string[]; records: number; planSets: string[]; targetChanges: string[]};

export type PersistedRun = {
	/** Names the run's file in ~/.pirl/sessions/; a resumed run keeps it, so it updates the same entry. */
	key: string;
	/** When the run first started and when it was saved last (ISO). */
	startedAt?: string;
	savedAt?: string;
	kind: RunKind;
	request: string;
	sessionId: string | null;
	status: RunStatus;
	questions: Question[];
	before: RunSnapshot;
	/** The provider session's token totals so far; a resumed session reports them again in its totals. */
	providerTotals?: Record<string, ModelTotals>;
};

export type RunDeps = {
	runner: AgentRunner;
	hub: string;
	target: string | null;
	python: {command: string; args: string[]} | null;
	maxParallelRoles: number;
	exec?: Exec;
	/** Roles offered as subagents; read from the Hub's role catalog when left out. */
	agents?: ReturnType<typeof roleAgents>;
	recentOutputs?: string[];
	/** Times the coordinator is sent back to fix a failed validator or a missing record. */
	maxRepairs?: number;
	/** Model alias of the coordinator and of the roles; the provider's default, and the coordinator's, when left out. */
	model?: string;
	roleModel?: string;
	effort?: string;
	/** Files and folders the user attached with `@` (src/engine/attachments.ts): sent with the request. */
	attachments?: {text: string; dirs: string[]};
	/** Reads the plan's usage meters (src/engine/claudeQuota.ts); the run shows no quota when left out. */
	quota?: () => Promise<QuotaRow[] | null>;
	/** Directory for the run's full log file (~/.pirl/logs); no file when left out. */
	logDir?: string;
	now?: () => number;
};

const MAX_REPAIRS = 2;

/** One line for the log: the run's tokens so far by kind, and their price at the Claude API list price. */
function usageDetail(usage: Usage): string | null {
	if (usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens + usage.outputTokens === 0) return null;
	const cost = usage.costUsd === null ? '' : `, ≈ $${usage.costUsd.toFixed(3)} ${t('theo giá API', 'at API prices')}`;
	return t(
		`Token đến giờ: ${usage.cacheReadTokens} đọc cache, ${usage.cacheWriteTokens} ghi cache, ${usage.outputTokens} ra, ${usage.inputTokens} vào mới${cost} (${usage.models.join(', ')})`,
		`Tokens so far: ${usage.cacheReadTokens} cache read, ${usage.cacheWriteTokens} cache write, ${usage.outputTokens} out, ${usage.inputTokens} new in${cost} (${usage.models.join(', ')})`,
	);
}

/**
 * One layer run, or one chat message, from start to the user's decision on framework improvements.
 * The provider does the reasoning; this class does every deterministic step around it: the permission rules,
 * the validator gate, the check that process-auditor wrote exactly one record, the Allowed paths check
 * after Implement, and the commit question for improvements.
 */
export class RunController {
	state: RunState;
	private listeners = new Set<(state: RunState) => void>();
	private handle: RunHandle | null = null;
	private exec: Exec;
	private repairs = 0;
	private before: RunSnapshot = {hubChanges: [], records: 0, planSets: [], targetChanges: []};
	private resumedBefore: RunSnapshot | undefined;
	private stopped = false;
	/** The usage before the current provider call, and the provider session's totals reported so far. */
	private callBase: Usage | null = null;
	private readonly key: string;
	private readonly firstStartedAt: string;
	private providerTotals: Record<string, ModelTotals> = {};
	private deniedIds = new Set<string>();
	/** Why the layer has no result after its checks (no Plan package, Plan file or report); null once it has one. */
	private missingResult: string | null = null;
	private logStream: WriteStream | null = null;
	private now: () => number;

	constructor(
		readonly deps: RunDeps,
		id: number,
		kind: RunKind,
		request: string,
		resume?: {
			sessionId: string;
			status?: RunStatus;
			questions?: Question[];
			before?: RunSnapshot;
			prompt?: string;
			providerTotals?: Record<string, ModelTotals>;
			key?: string;
			startedAt?: string;
		},
	) {
		this.exec = deps.exec ?? defaultExec;
		this.now = deps.now ?? Date.now;
		const startedAt = this.now();
		this.key = resume?.key ?? `${logStamp(new Date(startedAt))}-${kind}-${id}`;
		this.firstStartedAt = resume?.startedAt ?? new Date(startedAt).toISOString();
		const logFile = deps.logDir ? join(deps.logDir, `${logStamp(new Date(startedAt))}-${kind}-${id}.log`) : null;
		this.state = {
			id,
			kind,
			request,
			status: 'running',
			sessionId: resume?.sessionId ?? null,
			roles: [],
			activity: null,
			questions: resume?.questions ?? [],
			answers: [],
			reply: null,
			outputs: {planSet: null, planFile: null, report: null, recordId: null},
			checks: {},
			improvements: null,
			suggestion: null,
			denials: [],
			usage: emptyUsage(),
			quota: {before: null, after: null},
			error: null,
			startedAt,
			lastAt: 0,
			logFile,
		};
		if (resume?.status === 'waiting' && resume.questions?.length) this.state.status = 'waiting';
		this.resumedBefore = resume?.before;
		this.providerTotals = resume?.providerTotals ?? {};
		this.firstPrompt = resume ? resume.prompt ?? t('Tiếp tục run bị dừng từ chỗ đã dừng.', 'Continue the stopped run from where it stopped.') : request;
		// What the user typed to continue a layer run from /resume; a chat message is already the request.
		this.resumePrompt = resume?.prompt && resume.prompt !== request ? resume.prompt : null;
		// Attachments go with the user's own words: a new request or a chat message, not a "continue".
		if (deps.attachments?.text && (!resume || resume.prompt)) this.firstPrompt = `${this.firstPrompt}\n\n${deps.attachments.text}`;
	}

	/** What the first call sends: the request, a chat message into an existing session, or "continue". */
	private firstPrompt: string;
	private resumePrompt: string | null;

	/** What /resume needs to continue this run after PIRL CLI was closed. */
	persisted(): PersistedRun {
		return {
			key: this.key,
			startedAt: this.firstStartedAt,
			savedAt: new Date(this.now()).toISOString(),
			kind: this.state.kind,
			request: this.state.request,
			sessionId: this.state.sessionId,
			status: this.state.status,
			questions: this.state.questions,
			before: this.before,
			providerTotals: this.providerTotals,
		};
	}

	subscribe(listener: (state: RunState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private update(patch: Partial<RunState>, entry?: Omit<LogEntry, 'at'>) {
		if (entry) {
			const line: LogEntry = {at: this.now() - this.state.startedAt, ...entry};
			patch = {...patch, lastAt: line.at};
			this.writeLog(line);
		}
		this.state = {...this.state, ...patch};
		if (patch.status && TERMINAL.includes(patch.status)) this.closeLog();
		for (const listener of this.listeners) listener(this.state);
	}

	/** Appends to the log file; a log that cannot be written never stops the run. */
	private writeLog(entry: LogEntry) {
		if (!this.state.logFile) return;
		try {
			if (!this.logStream) {
				mkdirSync(dirname(this.state.logFile), {recursive: true});
				this.logStream = createWriteStream(this.state.logFile, {flags: 'a', encoding: 'utf8'});
				this.logStream.on('error', () => {
					this.logStream = null;
				});
			}
			this.logStream.write(`${formatElapsed(entry.at)} ${entry.who.padEnd(18)} ${entry.text}\n`);
		} catch {
			this.logStream = null;
		}
	}

	private closeLog() {
		this.logStream?.end();
		this.logStream = null;
	}

	private get layer(): LayerKind | null {
		return this.state.kind === 'chat' ? null : this.state.kind;
	}

	/** Records what is in the Hub and the target before the provider runs, to tell this run's changes apart. */
	private async snapshot() {
		if (this.resumedBefore) {
			// A resumed run compares against the state before it first started, not before the resume.
			this.before = this.resumedBefore;
			return;
		}
		const layer = this.layer;
		this.before = {
			hubChanges: await changedPaths(this.deps.hub, this.exec),
			records: layer ? countRecords(this.deps.hub, layer) : 0,
			planSets: listPlanSets(this.deps.hub),
			targetChanges: this.deps.target && this.deps.target !== this.deps.hub ? await changedPaths(this.deps.target, this.exec) : [],
		};
	}

	async start(): Promise<void> {
		this.update({}, {who: 'pirl', text: `${this.state.sessionId ? t('Chạy tiếp', 'Resuming') : t('Bắt đầu', 'Starting')} ${LAYER_LABELS[this.state.kind]}: ${this.state.request.split('\n')[0]!.slice(0, 120)}`});
		if (this.resumePrompt) this.update({}, {who: 'pirl', text: t(`Yêu cầu khi chạy tiếp: ${this.resumePrompt.split('\n')[0]!.slice(0, 200)}`, `Request on resume: ${this.resumePrompt.split('\n')[0]!.slice(0, 200)}`)});
		await this.guard(async () => {
			await this.snapshot();
			if (this.state.status === 'waiting') return; // resumed with unanswered questions: wait for the user
			await this.send(this.firstPrompt);
		});
	}

	/** Any unexpected error ends the run as failed with its message, instead of leaving it running forever. */
	private async guard(work: () => Promise<void>) {
		try {
			await work();
		} catch (error) {
			this.handle = null;
			const message = error instanceof Error ? error.message : String(error);
			this.update({status: 'failed', error: message}, {who: 'pirl', text: t(`Lỗi: ${message}`, `Error: ${message}`), tone: 'error'});
		}
	}

	/** Answers to the questions, in order; resumes the provider session once all are given. */
	async answer(answers: string[]): Promise<void> {
		if (this.state.status !== 'waiting') return;
		const questions = this.state.questions;
		this.update({answers, status: 'running', questions: []});
		await this.guard(() => this.send(answersMessage(questions, answers)));
	}

	/**
	 * Stops the run. With a provider working, the first call asks it to stop and each later one forces it
	 * (src/engine/claudeRunner.ts); the run ends once the process does. Otherwise (preparing, waiting for answers,
	 * running the checks) it ends at once, and the steps still under way see `stopped` and change nothing.
	 */
	stop() {
		if (TERMINAL.includes(this.state.status)) return;
		const again = this.stopped;
		this.stopped = true;
		if (this.handle) {
			const text = again ? t('Buộc dừng provider', 'Forcing the provider to stop') : t('Đang dừng provider…', 'Stopping the provider…');
			this.update({}, {who: 'pirl', text, tone: 'warning'});
			this.handle.stop();
			return;
		}
		this.update({status: 'stopped'}, {who: 'pirl', text: t('Đã dừng', 'Stopped')});
	}

	private async send(prompt: string): Promise<void> {
		// Stopped while the run was still preparing (the snapshot can take a moment): start no provider at all.
		if (this.stopped) {
			if (this.state.status !== 'stopped') this.update({status: 'stopped'}, {who: 'pirl', text: t('Đã dừng', 'Stopped')});
			return;
		}
		const deps = this.deps;
		const request = {
			cwd: deps.hub,
			addDirs: [...(deps.target && deps.target !== deps.hub ? [deps.target] : []), ...(deps.attachments?.dirs ?? [])],
			prompt,
			systemPrompt: hostInstructions({
				kind: this.state.kind,
				hub: deps.hub,
				target: deps.target,
				python: deps.python,
				maxParallelRoles: deps.maxParallelRoles,
				recentOutputs: deps.recentOutputs,
			}),
			agents: deps.agents ?? roleAgents(deps.hub, undefined, deps.roleModel, deps.target && deps.target !== deps.hub ? deps.target : null, deps.effort),
			permissions: permissionsFor(this.state.kind, {hub: deps.hub, target: deps.target}, deps.python),
			resumeSessionId: this.state.sessionId ?? undefined,
			model: deps.model,
			effort: deps.effort,
		};
		let result: Extract<RunEvent, {type: 'result'}> | null = null;
		// The first meters are read while the provider starts up, before its first model request.
		if (this.state.usage.calls === 0) void this.readQuota('before');
		this.update({status: 'running', error: null, usage: {...this.state.usage, calls: this.state.usage.calls + 1}});
		this.callBase = this.state.usage;
		this.handle = deps.runner.start(request, event => {
			if (event.type === 'result') result = event;
			this.apply(event);
		});
		const exit = await this.handle.done;
		this.handle = null;
		void this.readQuota('after');
		const spent = usageDetail(this.state.usage);
		if (spent) this.update({}, {who: 'pirl', text: spent});
		if (this.stopped) {
			this.update({status: 'stopped', roles: this.state.roles.map(role => (role.state === 'running' ? {...role, state: 'failed'} : role))}, {who: 'pirl', text: t('Đã dừng theo yêu cầu', 'Stopped on request'), tone: 'warning'});
			return;
		}
		const final = result as Extract<RunEvent, {type: 'result'}> | null;
		if (!final || final.isError) {
			const detail = final?.text || exit.stderr.trim().split('\n').slice(-3).join(' ') || t(`mã thoát ${exit.code}`, `exit code ${exit.code}`);
			this.update({status: 'failed', error: detail, reply: final?.text ? stripBlocks(final.text) : this.state.reply}, {who: 'pirl', text: t(`Lỗi: ${detail.slice(0, 200)}`, `Error: ${detail.slice(0, 200)}`), tone: 'error'});
			return;
		}
		await this.afterReply(final.text);
	}

	/**
	 * Replaces the live count of the provider call with its exact totals. They cover the whole provider session,
	 * so the totals reported by its earlier calls are taken off. The request count stays the live one.
	 */
	private applyTotals(models: Record<string, ModelTotals>) {
		const base = this.callBase ?? this.state.usage;
		const usage: Usage = {...base, requests: this.state.usage.requests, models: [...base.models]};
		const keys = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'] as const;
		for (const [model, total] of Object.entries(models)) {
			const before = this.providerTotals[model];
			for (const key of keys) usage[key] += Math.max(0, total[key] - (before?.[key] ?? 0));
			const cost = total.costUsd === null ? null : Math.max(0, total.costUsd - (before?.costUsd ?? 0));
			usage.costUsd = usage.costUsd === null || cost === null ? null : usage.costUsd + cost;
			if (!usage.models.includes(model)) usage.models.push(model);
		}
		this.providerTotals = models;
		this.update({usage});
	}

	private async readQuota(when: 'before' | 'after') {
		if (!this.deps.quota) return;
		let rows: QuotaRow[] | null = null;
		try {
			rows = await this.deps.quota();
		} catch {}
		if (rows) this.update({quota: {...this.state.quota, [when]: rows}});
	}

	private roleName(toolUseId: string | null): string | null {
		return toolUseId ? this.state.roles.find(role => role.toolUseId === toolUseId)?.role ?? null : null;
	}

	private apply(event: RunEvent) {
		switch (event.type) {
			case 'session':
				// A new provider session starts its totals from zero.
				if (this.state.sessionId && event.sessionId !== this.state.sessionId) this.providerTotals = {};
				if (event.sessionId !== this.state.sessionId) this.update({sessionId: event.sessionId}, {who: 'pirl', text: `Session ${event.sessionId.slice(0, 8)}`});
				break;
			case 'role-start':
				this.update(
					{roles: [...this.state.roles, {toolUseId: event.toolUseId, role: event.role, description: event.description, state: 'running', activity: null}]},
					{who: event.role, text: t(`bắt đầu: ${event.description}`, `started: ${event.description}`)},
				);
				break;
			case 'role-end': {
				const role = this.roleName(event.toolUseId);
				if (role) {
					this.update(
						{roles: this.state.roles.map(item => (item.toolUseId === event.toolUseId ? {...item, state: event.ok ? 'done' : 'failed'} : item))},
						{who: role, text: event.ok ? t('xong', 'done') : t('kết thúc với lỗi', 'ended with an error'), tone: event.ok ? 'success' : 'error'},
					);
				}
				break;
			}
			case 'activity': {
				const role = this.roleName(event.agent);
				if (role) {
					this.update({roles: this.state.roles.map(item => (item.toolUseId === event.agent ? {...item, activity: event.text} : item))}, {who: role, text: event.text});
				} else {
					this.update({activity: event.text}, {who: 'coordinator', text: event.text});
				}
				break;
			}
			case 'retry': {
				const text = t(`Provider lỗi tạm thời (${event.error}), thử lại lần ${event.attempt}`, `Temporary provider error (${event.error}), retry ${event.attempt}`);
				this.update({activity: text}, {who: 'pirl', text, tone: 'warning'});
				break;
			}
			case 'denied':
				// Claude Code reports a refusal while it happens and again in the result: count it once.
				if (event.id ? this.deniedIds.has(event.id) : this.state.denials.includes(event.detail)) break;
				if (event.id) this.deniedIds.add(event.id);
				this.update({denials: [...this.state.denials, event.detail]}, {who: 'pirl', text: t(`Chặn (ngoài quyền của run): ${event.detail}`, `Blocked (outside the run's permissions): ${event.detail}`), tone: 'warning'});
				break;
			case 'usage': {
				const usage = this.state.usage;
				this.update({
					usage: {
						calls: usage.calls,
						requests: usage.requests + (event.request ? 1 : 0),
						inputTokens: usage.inputTokens + event.inputTokens,
						cacheWriteTokens: usage.cacheWriteTokens + event.cacheWriteTokens,
						cacheReadTokens: usage.cacheReadTokens + event.cacheReadTokens,
						outputTokens: usage.outputTokens + event.outputTokens,
						costUsd: usage.costUsd === null || event.costUsd === null ? null : usage.costUsd + event.costUsd,
						models: usage.models.includes(event.model) ? usage.models : [...usage.models, event.model],
					},
				});
				break;
			}
			case 'usage-totals':
				this.applyTotals(event.models);
				break;
			case 'quota':
				// The windows as they stand now; the level before the run comes only from the reading taken before it.
				this.update({quota: {...this.state.quota, after: event.rows}});
				break;
			case 'result':
				this.update({sessionId: event.sessionId ?? this.state.sessionId});
				break;
			case 'text':
				break;
		}
	}

	private async afterReply(text: string) {
		const questions = parseQuestions(text);
		const outputs = parseOutputs(text);
		this.update({
			reply: stripBlocks(text),
			outputs: {
				planSet: outputs.planSet ?? this.state.outputs.planSet,
				planFile: outputs.planFile ?? this.state.outputs.planFile,
				report: outputs.report ?? this.state.outputs.report,
				recordId: outputs.recordId ?? this.state.outputs.recordId,
			},
			suggestion: this.state.kind === 'chat' ? parseSuggestion(text) : null,
			roles: this.state.roles.map(role => (role.state === 'running' ? {...role, state: 'done'} : role)),
		});
		if (questions.length > 0) {
			this.update({status: 'waiting', questions, answers: []}, {who: 'pirl', text: t(`Chờ bạn trả lời ${questions.length} câu hỏi`, `Waiting for your answers to ${questions.length} ${plural(questions.length, 'question')}`), tone: 'warning'});
			return;
		}
		if (this.layer) {
			this.update({status: 'checking'}, {who: 'pirl', text: t('Coordinator xong; kiểm tra kết quả', 'Coordinator done; checking the results')});
			const repair = await this.checkLayer();
			if (this.stopped) return;
			if (repair && this.repairs < (this.deps.maxRepairs ?? MAX_REPAIRS)) {
				this.repairs += 1;
				this.update({}, {who: 'pirl', text: t(`Gửi coordinator sửa (lần ${this.repairs})`, `Sent back to the coordinator to fix (attempt ${this.repairs})`), tone: 'warning'});
				await this.send(repair);
				return;
			}
		}
		await this.findImprovements();
	}

	private resolveHubPath(path: string | null): string | null {
		if (!path) return null;
		const full = isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) ? path : join(this.deps.hub, path);
		return existsSync(full) ? full : null;
	}

	private async python(args: string[]) {
		const python = this.deps.python;
		if (!python) return {code: null, stdout: '', stderr: '', error: t('Không tìm thấy Python', 'Python not found')};
		return this.exec(python.command, [...python.args, '-B', ...args], {cwd: this.deps.hub, timeoutMs: 120_000});
	}

	/** The checks the layer's skill ends with, done by the CLI itself. Returns a repair message, or null. */
	private async checkLayer(): Promise<string | null> {
		const layer = this.layer!;
		const checks: RunState['checks'] = {};
		const repairs: string[] = [];

		// Validator: the Plan package after Plan, the Plan file after Implement, the report after Review.
		const newPlanSets = listPlanSets(this.deps.hub).filter(name => !this.before.planSets.includes(name));
		const target =
			layer === 'plan'
				? this.resolveHubPath(this.state.outputs.planSet) ?? (newPlanSets.length === 1 ? join(this.deps.hub, newPlanSets[0]!) : null)
				: layer === 'implement'
					? this.resolveHubPath(this.state.outputs.planFile)
					: this.resolveHubPath(this.state.outputs.report);
		this.missingResult = null;
		if (!target) {
			this.missingResult = t(`Run kết thúc mà không có ${RESULT[layer]} và không hỏi bạn câu nào.`, `The run ended without a ${RESULT[layer]} and asked you nothing.`);
			checks.validator = {state: 'fail', detail: this.missingResult};
			repairs.push(
				t(
					`Run chưa có kết quả: không tìm thấy ${RESULT[layer]} nào. Hoàn tất nó theo skill của layer và ghi đường dẫn vào khối pirl-result. Nếu còn thiếu quyết định hoặc nội dung mà chỉ người dùng đưa được, kết thúc bằng khối pirl-questions để hỏi.`,
					`The run has no result: no ${RESULT[layer]} was found. Complete it per the layer's skill and give its path in the pirl-result block. If a decision or content only the user can give is missing, end with a pirl-questions block that asks for it.`,
				),
			);
		} else {
			const result = await this.python(['.agents/evals/validate_layer_artifact.py', '--kind', layer === 'review' ? 'review' : 'plan', '--path', target]);
			if (succeeded(result)) checks.validator = {state: 'pass', detail: relative(this.deps.hub, target) || target};
			else {
				const detail = (result.stdout || result.stderr || result.error || '').trim().slice(0, 1500);
				checks.validator = {state: 'fail', detail};
				repairs.push(t(`Validator báo lỗi cho ${target}:\n${detail}\nSửa các lỗi này rồi chạy lại validator cho tới khi PASS.`, `The validator reports errors for ${target}:\n${detail}\nFix these errors, then run the validator again until it passes.`));
			}
			if (layer === 'plan' && !this.state.outputs.planSet) this.update({outputs: {...this.state.outputs, planSet: target}});
		}

		// Self-evaluation: exactly one new record for this layer, and the records still pass `check`.
		const added = countRecords(this.deps.hub, layer) - this.before.records;
		const check = await this.python(['.agents/evals/layer_record.py', 'check']);
		if (added < 1) {
			checks.record = {state: 'fail', detail: t('process-auditor chưa ghi record cho run này', 'process-auditor has not written a record for this run')};
			repairs.push(t('Bước tự đánh giá chưa xong: process-auditor chưa ghi record nào cho run này. Hoàn tất bước đó theo skill của layer.', 'The self-evaluation step is not finished: process-auditor has not written a record for this run. Complete that step per the layer\'s skill.'));
		} else if (!succeeded(check)) {
			checks.record = {state: 'fail', detail: (check.stdout || check.stderr).trim().slice(0, 800)};
			repairs.push(t(`\`layer_record.py check\` báo lỗi:\n${checks.record.detail}\nSửa record cho đúng.`, `\`layer_record.py check\` reports errors:\n${checks.record.detail}\nCorrect the record.`));
		} else {
			checks.record = {state: 'pass', detail: t(`${added} record mới`, added > 1 ? `${added} new records` : '1 new record')};
		}

		// Implement may change only the Plan's Allowed paths in the target repository.
		if (layer === 'implement' && this.deps.target && this.deps.target !== this.deps.hub) {
			const planFile = this.resolveHubPath(this.state.outputs.planFile);
			const allowed = planFile ? allowedPaths(readFileSync(planFile, 'utf8')) : [];
			const changed = (await changedPaths(this.deps.target, this.exec)).filter(path => !this.before.targetChanges.includes(path));
			const outside = outsideAllowed(changed, allowed);
			checks.paths =
				allowed.length === 0
					? {state: 'skipped', detail: t('Plan không có dòng Allowed paths', 'the Plan has no Allowed paths line')}
					: outside.length === 0
						? {state: 'pass', detail: t(`${changed.length} file thay đổi, đều trong Allowed paths`, `${changed.length} ${plural(changed.length, 'file')} changed, all within Allowed paths`)}
						: {state: 'fail', detail: t(`Ngoài Allowed paths: ${outside.join(', ')}`, `Outside Allowed paths: ${outside.join(', ')}`)};
		}

		const labels: Record<string, string> = {validator: 'Validator', record: 'Record', paths: 'Allowed paths'};
		for (const [key, check] of Object.entries(checks)) {
			const verdict = check.state === 'pass' ? 'PASS' : check.state === 'fail' ? 'FAIL' : t('bỏ qua', 'skipped');
			this.update({}, {who: 'pirl', text: `${labels[key]}: ${verdict}${check.detail ? ` (${check.detail.split('\n')[0]!.slice(0, 120)})` : ''}`, tone: check.state === 'pass' ? 'success' : check.state === 'fail' ? 'error' : undefined});
		}
		this.update({checks});
		return repairs.length > 0 ? repairs.join('\n\n') : null;
	}

	/** Framework files this run changed in the Hub; files already changed before the run are left alone. */
	private async findImprovements() {
		// The run's temporary files (.tmp/pirl-run/) are removed here, as the host instructions promise the coordinator.
		rmSync(join(this.deps.hub, '.tmp', 'pirl-run'), {recursive: true, force: true});
		const now = await changedPaths(this.deps.hub, this.exec);
		if (this.stopped) return;
		const files = now.filter(path => !this.before.hubChanges.includes(path));
		if (files.length === 0) {
			this.finish({}, null);
			return;
		}
		this.update({status: 'checking', activity: t('Chạy test của framework trên các cải tiến', 'Running the framework tests on the improvements')}, {who: 'pirl', text: t(`${files.length} file framework thay đổi; chạy test của framework`, `${files.length} framework ${plural(files.length, 'file')} changed; running the framework tests`)});
		const tests = await this.frameworkTests();
		if (this.stopped) return;
		const firstLine = tests.detail?.split('\n')[0]?.slice(0, 120) ?? '';
		this.update(
			{status: 'improvements', improvements: {files, state: 'pending', tests}},
			tests.state === 'fail'
				? {who: 'pirl', text: t(`Test framework: FAIL; cải tiến này không được commit (${firstLine})`, `Framework tests: FAIL; these improvements cannot be committed (${firstLine})`), tone: 'error'}
				: {who: 'pirl', text: tests.state === 'pass' ? t('Test framework: PASS; chờ bạn quyết định commit', 'Framework tests: PASS; waiting for your commit decision') : t('Test framework: bỏ qua; chờ bạn quyết định commit', 'Framework tests: skipped; waiting for your commit decision'), tone: 'warning'},
		);
	}

	/** The framework's own tests on the Hub as the run left it: a broken framework must never be committed to main. */
	private async frameworkTests(): Promise<CheckResult> {
		if (!this.deps.python) return {state: 'skipped', detail: t('Không tìm thấy Python', 'Python not found')};
		const result = await this.python(['-m', 'unittest', 'discover', '-s', '.agents/evals/tests', '-p', 'test_*.py']);
		if (succeeded(result)) return {state: 'pass'};
		const output = `${result.stderr}\n${result.stdout}`.trim().split('\n');
		const failures = output.filter(line => /^(FAIL|ERROR):/.test(line));
		return {state: 'fail', detail: (failures.length ? failures : output.slice(-5)).join('\n') || result.error || t(`mã thoát ${result.code}`, `exit code ${result.code}`)};
	}

	/** The user's decision on this run's framework improvements. */
	async resolveImprovements(choice: 'commit' | 'keep' | 'discard'): Promise<void> {
		const pending = this.state.improvements;
		if (!pending || pending.state !== 'pending') return;
		// The run still waits for a decision: the error is shown with the choices, and logged for tracing.
		const refuse = (error: string) => this.update({improvements: {...pending, error}}, {who: 'pirl', text: t(`Cải tiến chưa xử lý được: ${error}`, `Could not handle the improvements: ${error}`), tone: 'error'});
		if (choice === 'commit' && pending.tests?.state === 'fail') {
			refuse(t('Test của framework đang lỗi: không commit một framework hỏng vào Hub. Chọn bỏ cải tiến, hoặc giữ để sửa tay.', 'The framework tests fail: a broken framework is not committed to the Hub. Discard the improvements, or keep them to fix by hand.'));
			return;
		}
		if (choice === 'keep') {
			this.finish({improvements: {...pending, state: 'kept'}}, t('Giữ cải tiến, chưa commit', 'Kept the improvements, not committed'));
			return;
		}
		const result =
			choice === 'commit'
				? await commitImprovements(this.deps.hub, pending.files, {kind: this.state.kind, recordId: this.state.outputs.recordId, summary: this.state.request.slice(0, 200)}, this.exec)
				: await discardImprovements(this.deps.hub, pending.files, this.exec);
		if (!result.ok) {
			refuse(result.error ?? t('lỗi không rõ', 'unknown error'));
			return;
		}
		const count = pending.files.length;
		this.finish(
			{improvements: {files: pending.files, state: choice === 'commit' ? 'committed' : 'discarded'}},
			choice === 'commit' ? t(`Đã commit ${count} file cải tiến`, `Committed ${count} improved ${plural(count, 'file')}`) : t(`Đã bỏ ${count} file cải tiến`, `Discarded ${count} improved ${plural(count, 'file')}`),
		);
	}

	/**
	 * Ends the run after its last step (`what`, for the log). A layer run that never produced its result ends failed
	 * with the reason, not done, so the user sees it had no result and /resume can continue it.
	 */
	private finish(patch: Partial<RunState>, what: string | null) {
		const outcome = this.missingResult ? t('Không có kết quả', 'No result') : t('Xong', 'Done');
		this.update(
			{...patch, ...(this.missingResult ? {status: 'failed', error: this.missingResult} : {status: 'done'})},
			{who: 'pirl', text: what ? `${what}. ${outcome}` : outcome, tone: this.missingResult ? 'warning' : 'success'},
		);
	}

	/** Task ID and title of the Plan file this run produced or worked on, for the run block. */
	planSummary(): string | null {
		const file = this.resolveHubPath(this.state.outputs.planFile);
		if (!file) return null;
		const fields = readFrontmatter(readFileSync(file, 'utf8'));
		return `${fields['task_id'] ?? ''} ${fields['title'] ?? ''}`.trim() || null;
	}
}

const TERMINAL: RunStatus[] = ['done', 'failed', 'stopped'];

/** What each layer hands off; a layer run without it has no result. */
const RESULT: Record<LayerKind, string> = {plan: 'Plan package', implement: 'Plan file', review: 'Review report'};

/** mm:ss since the run started, or h:mm:ss after an hour. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const two = (value: number) => String(value).padStart(2, '0');
	return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

const logStamp = (date: Date) => {
	const two = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};
