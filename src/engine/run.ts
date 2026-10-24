import {createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream} from 'node:fs';
import {dirname, isAbsolute, join, relative} from 'node:path';
import {exec as defaultExec, succeeded, type Exec} from '../core/exec.js';
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

/** Entries kept in memory for the TUI; the log file keeps every entry. Bounded so a long run costs the same to draw. */
export const LOG_LIMIT = 200;

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
	improvements: {files: string[]; state: 'pending' | 'committed' | 'kept' | 'discarded'; error?: string} | null;
	suggestion: string | null;
	denials: string[];
	usage: Usage;
	/** The plan's usage meters when the run started and after its latest provider call; null when unknown. */
	quota: {before: QuotaRow[] | null; after: QuotaRow[] | null};
	error: string | null;
	/** When the run started (epoch ms), for the elapsed time. */
	startedAt: number;
	/** The latest LOG_LIMIT entries, oldest first. */
	log: LogEntry[];
	/** Entries written since the start, including those no longer kept in `log`. */
	logCount: number;
	/** Where the whole log is written, when the run has a log directory. */
	logFile: string | null;
};

/** The Hub and target before a run started; changes after it are this run's. */
export type RunSnapshot = {hubChanges: string[]; records: number; planSets: string[]; targetChanges: string[]};

export type PersistedRun = {
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
	const cost = usage.costUsd === null ? '' : `, ≈ $${usage.costUsd.toFixed(3)} theo giá API`;
	return `Token đến giờ: ${usage.cacheReadTokens} đọc cache, ${usage.cacheWriteTokens} ghi cache, ${usage.outputTokens} ra, ${usage.inputTokens} vào mới${cost} (${usage.models.join(', ')})`;
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
	private providerTotals: Record<string, ModelTotals> = {};
	private deniedIds = new Set<string>();
	private logStream: WriteStream | null = null;
	private now: () => number;

	constructor(
		readonly deps: RunDeps,
		id: number,
		kind: RunKind,
		request: string,
		resume?: {sessionId: string; status?: RunStatus; questions?: Question[]; before?: RunSnapshot; prompt?: string; providerTotals?: Record<string, ModelTotals>},
	) {
		this.exec = deps.exec ?? defaultExec;
		this.now = deps.now ?? Date.now;
		const startedAt = this.now();
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
			log: [],
			logCount: 0,
			logFile,
		};
		if (resume?.status === 'waiting' && resume.questions?.length) this.state.status = 'waiting';
		this.resumedBefore = resume?.before;
		this.providerTotals = resume?.providerTotals ?? {};
		this.firstPrompt = resume ? resume.prompt ?? 'Tiếp tục run bị dừng từ chỗ đã dừng.' : request;
	}

	/** What the first call sends: the request, a chat message into an existing session, or "continue". */
	private firstPrompt: string;

	/** What /resume needs to continue this run after PIRL CLI was closed. */
	persisted(): PersistedRun {
		return {
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
			patch = {...patch, log: [...this.state.log.slice(-(LOG_LIMIT - 1)), line], logCount: this.state.logCount + 1};
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
		this.update({}, {who: 'pirl', text: `${this.state.sessionId ? 'Chạy tiếp' : 'Bắt đầu'} ${LAYER_LABELS[this.state.kind]}: ${this.state.request.split('\n')[0]!.slice(0, 120)}`});
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
			this.update({status: 'failed', error: message}, {who: 'pirl', text: `Lỗi: ${message}`, tone: 'error'});
		}
	}

	/** Answers to the questions, in order; resumes the provider session once all are given. */
	async answer(answers: string[]): Promise<void> {
		if (this.state.status !== 'waiting') return;
		const questions = this.state.questions;
		this.update({answers, status: 'running', questions: []});
		await this.guard(() => this.send(answersMessage(questions, answers)));
	}

	stop() {
		this.stopped = true;
		this.handle?.stop();
		if (!this.handle) this.update({status: 'stopped'}, {who: 'pirl', text: 'Đã dừng'});
	}

	private async send(prompt: string): Promise<void> {
		const deps = this.deps;
		const request = {
			cwd: deps.hub,
			addDirs: deps.target && deps.target !== deps.hub ? [deps.target] : [],
			prompt,
			systemPrompt: hostInstructions({
				kind: this.state.kind,
				hub: deps.hub,
				target: deps.target,
				python: deps.python,
				maxParallelRoles: deps.maxParallelRoles,
				recentOutputs: deps.recentOutputs,
			}),
			agents: deps.agents ?? roleAgents(deps.hub, undefined, deps.roleModel),
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
			this.update({status: 'stopped', roles: this.state.roles.map(role => (role.state === 'running' ? {...role, state: 'failed'} : role))}, {who: 'pirl', text: 'Đã dừng theo yêu cầu', tone: 'warning'});
			return;
		}
		const final = result as Extract<RunEvent, {type: 'result'}> | null;
		if (!final || final.isError) {
			const detail = final?.text || exit.stderr.trim().split('\n').slice(-3).join(' ') || `mã thoát ${exit.code}`;
			this.update({status: 'failed', error: detail, reply: final?.text ? stripBlocks(final.text) : this.state.reply}, {who: 'pirl', text: `Lỗi: ${detail.slice(0, 200)}`, tone: 'error'});
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
					{who: event.role, text: `bắt đầu: ${event.description}`},
				);
				break;
			case 'role-end': {
				const role = this.roleName(event.toolUseId);
				if (role) {
					this.update(
						{roles: this.state.roles.map(item => (item.toolUseId === event.toolUseId ? {...item, state: event.ok ? 'done' : 'failed'} : item))},
						{who: role, text: event.ok ? 'xong' : 'kết thúc với lỗi', tone: event.ok ? 'success' : 'error'},
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
				const text = `Provider lỗi tạm thời (${event.error}), thử lại lần ${event.attempt}`;
				this.update({activity: text}, {who: 'pirl', text, tone: 'warning'});
				break;
			}
			case 'denied':
				// Claude Code reports a refusal while it happens and again in the result: count it once.
				if (event.id ? this.deniedIds.has(event.id) : this.state.denials.includes(event.detail)) break;
				if (event.id) this.deniedIds.add(event.id);
				this.update({denials: [...this.state.denials, event.detail]}, {who: 'pirl', text: `Chặn (ngoài quyền của run): ${event.detail}`, tone: 'warning'});
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
			this.update({status: 'waiting', questions, answers: []}, {who: 'pirl', text: `Chờ bạn trả lời ${questions.length} câu hỏi`, tone: 'warning'});
			return;
		}
		if (this.layer) {
			this.update({status: 'checking'}, {who: 'pirl', text: 'Coordinator xong; kiểm tra kết quả'});
			const repair = await this.checkLayer();
			if (repair && this.repairs < (this.deps.maxRepairs ?? MAX_REPAIRS)) {
				this.repairs += 1;
				this.update({}, {who: 'pirl', text: `Gửi coordinator sửa (lần ${this.repairs})`, tone: 'warning'});
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
		if (!python) return {code: null, stdout: '', stderr: '', error: 'Không tìm thấy Python'};
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
		if (!target) {
			checks.validator = {state: 'skipped', detail: 'không xác định được file kết quả của run'};
		} else {
			const result = await this.python(['.agents/evals/validate_layer_artifact.py', '--kind', layer === 'review' ? 'review' : 'plan', '--path', target]);
			if (succeeded(result)) checks.validator = {state: 'pass', detail: relative(this.deps.hub, target) || target};
			else {
				const detail = (result.stdout || result.stderr || result.error || '').trim().slice(0, 1500);
				checks.validator = {state: 'fail', detail};
				repairs.push(`Validator báo lỗi cho ${target}:\n${detail}\nSửa các lỗi này rồi chạy lại validator cho tới khi PASS.`);
			}
			if (layer === 'plan' && !this.state.outputs.planSet) this.update({outputs: {...this.state.outputs, planSet: target}});
		}

		// Self-evaluation: exactly one new record for this layer, and the records still pass `check`.
		const added = countRecords(this.deps.hub, layer) - this.before.records;
		const check = await this.python(['.agents/evals/layer_record.py', 'check']);
		if (added < 1) {
			checks.record = {state: 'fail', detail: 'process-auditor chưa ghi record cho run này'};
			repairs.push('Bước tự đánh giá chưa xong: process-auditor chưa ghi record nào cho run này. Hoàn tất bước đó theo skill của layer.');
		} else if (!succeeded(check)) {
			checks.record = {state: 'fail', detail: (check.stdout || check.stderr).trim().slice(0, 800)};
			repairs.push(`\`layer_record.py check\` báo lỗi:\n${checks.record.detail}\nSửa record cho đúng.`);
		} else {
			checks.record = {state: 'pass', detail: added > 1 ? `${added} record mới` : '1 record mới'};
		}

		// Implement may change only the Plan's Allowed paths in the target repository.
		if (layer === 'implement' && this.deps.target && this.deps.target !== this.deps.hub) {
			const planFile = this.resolveHubPath(this.state.outputs.planFile);
			const allowed = planFile ? allowedPaths(readFileSync(planFile, 'utf8')) : [];
			const changed = (await changedPaths(this.deps.target, this.exec)).filter(path => !this.before.targetChanges.includes(path));
			const outside = outsideAllowed(changed, allowed);
			checks.paths =
				allowed.length === 0
					? {state: 'skipped', detail: 'Plan không có dòng Allowed paths'}
					: outside.length === 0
						? {state: 'pass', detail: `${changed.length} file thay đổi, đều trong Allowed paths`}
						: {state: 'fail', detail: `Ngoài Allowed paths: ${outside.join(', ')}`};
		}

		const labels: Record<string, string> = {validator: 'Validator', record: 'Record', paths: 'Allowed paths'};
		for (const [key, check] of Object.entries(checks)) {
			const verdict = check.state === 'pass' ? 'PASS' : check.state === 'fail' ? 'FAIL' : 'bỏ qua';
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
		const files = now.filter(path => !this.before.hubChanges.includes(path));
		if (files.length === 0) {
			this.update({status: 'done'}, {who: 'pirl', text: 'Xong', tone: 'success'});
			return;
		}
		this.update({status: 'improvements', improvements: {files, state: 'pending'}}, {who: 'pirl', text: `${files.length} file framework thay đổi; chờ bạn quyết định commit`, tone: 'warning'});
	}

	/** The user's decision on this run's framework improvements. */
	async resolveImprovements(choice: 'commit' | 'keep' | 'discard'): Promise<void> {
		const pending = this.state.improvements;
		if (!pending || pending.state !== 'pending') return;
		if (choice === 'keep') {
			this.update({status: 'done', improvements: {...pending, state: 'kept'}}, {who: 'pirl', text: 'Giữ cải tiến, chưa commit. Xong', tone: 'success'});
			return;
		}
		const result =
			choice === 'commit'
				? await commitImprovements(this.deps.hub, pending.files, {kind: this.state.kind, recordId: this.state.outputs.recordId, summary: this.state.request.slice(0, 200)}, this.exec)
				: await discardImprovements(this.deps.hub, pending.files, this.exec);
		if (!result.ok) {
			this.update({improvements: {...pending, error: result.error ?? 'lỗi không rõ'}});
			return;
		}
		this.update(
			{status: 'done', improvements: {files: pending.files, state: choice === 'commit' ? 'committed' : 'discarded'}},
			{who: 'pirl', text: `${choice === 'commit' ? 'Đã commit' : 'Đã bỏ'} ${pending.files.length} file cải tiến. Xong`, tone: 'success'},
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
