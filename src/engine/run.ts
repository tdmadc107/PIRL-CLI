import {existsSync, readFileSync, rmSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
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
import {emptyUsage, type AgentRunner, type LayerKind, type Question, type RunEvent, type RunHandle, type RunKind, type Usage} from './types.js';

export type RoleRun = {toolUseId: string; role: string; description: string; state: 'running' | 'done' | 'failed'; activity: string | null};

export type CheckResult = {state: 'pass' | 'fail' | 'skipped'; detail?: string};

export type RunStatus = 'running' | 'waiting' | 'checking' | 'improvements' | 'done' | 'failed' | 'stopped';

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
	error: string | null;
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
};

const MAX_REPAIRS = 2;

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

	constructor(
		readonly deps: RunDeps,
		id: number,
		kind: RunKind,
		request: string,
		resume?: {sessionId: string; status?: RunStatus; questions?: Question[]; before?: RunSnapshot; prompt?: string},
	) {
		this.exec = deps.exec ?? defaultExec;
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
			error: null,
		};
		if (resume?.status === 'waiting' && resume.questions?.length) this.state.status = 'waiting';
		this.resumedBefore = resume?.before;
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
		};
	}

	subscribe(listener: (state: RunState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private update(patch: Partial<RunState>) {
		this.state = {...this.state, ...patch};
		for (const listener of this.listeners) listener(this.state);
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
			this.update({status: 'failed', error: error instanceof Error ? error.message : String(error)});
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
		if (!this.handle) this.update({status: 'stopped'});
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
			agents: deps.agents ?? roleAgents(deps.hub),
			permissions: permissionsFor(this.state.kind, {hub: deps.hub, target: deps.target}, deps.python),
			resumeSessionId: this.state.sessionId ?? undefined,
		};
		let result: Extract<RunEvent, {type: 'result'}> | null = null;
		this.update({status: 'running', error: null, usage: {...this.state.usage, calls: this.state.usage.calls + 1}});
		this.handle = deps.runner.start(request, event => {
			if (event.type === 'result') result = event;
			this.apply(event);
		});
		const exit = await this.handle.done;
		this.handle = null;
		if (this.stopped) {
			this.update({status: 'stopped', roles: this.state.roles.map(role => (role.state === 'running' ? {...role, state: 'failed'} : role))});
			return;
		}
		const final = result as Extract<RunEvent, {type: 'result'}> | null;
		if (!final || final.isError) {
			const detail = final?.text || exit.stderr.trim().split('\n').slice(-3).join(' ') || `mã thoát ${exit.code}`;
			this.update({status: 'failed', error: detail, reply: final?.text ? stripBlocks(final.text) : this.state.reply});
			return;
		}
		await this.afterReply(final.text);
	}

	private apply(event: RunEvent) {
		switch (event.type) {
			case 'session':
				this.update({sessionId: event.sessionId});
				break;
			case 'role-start':
				this.update({roles: [...this.state.roles, {toolUseId: event.toolUseId, role: event.role, description: event.description, state: 'running', activity: null}]});
				break;
			case 'role-end':
				if (this.state.roles.some(role => role.toolUseId === event.toolUseId)) {
					this.update({roles: this.state.roles.map(role => (role.toolUseId === event.toolUseId ? {...role, state: event.ok ? 'done' : 'failed'} : role))});
				}
				break;
			case 'activity':
				if (event.agent && this.state.roles.some(role => role.toolUseId === event.agent)) {
					this.update({roles: this.state.roles.map(role => (role.toolUseId === event.agent ? {...role, activity: event.text} : role))});
				} else {
					this.update({activity: event.text});
				}
				break;
			case 'retry':
				this.update({activity: `Provider lỗi tạm thời (${event.error}), thử lại lần ${event.attempt}`});
				break;
			case 'denied':
				if (!this.state.denials.includes(event.detail)) this.update({denials: [...this.state.denials, event.detail]});
				break;
			case 'result':
				this.update({
					sessionId: event.sessionId ?? this.state.sessionId,
					usage: {
						calls: this.state.usage.calls,
						inputTokens: this.state.usage.inputTokens + event.usage.inputTokens,
						outputTokens: this.state.usage.outputTokens + event.usage.outputTokens,
					},
				});
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
			this.update({status: 'waiting', questions, answers: []});
			return;
		}
		if (this.layer) {
			this.update({status: 'checking'});
			const repair = await this.checkLayer();
			if (repair && this.repairs < (this.deps.maxRepairs ?? MAX_REPAIRS)) {
				this.repairs += 1;
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
			this.update({status: 'done'});
			return;
		}
		this.update({status: 'improvements', improvements: {files, state: 'pending'}});
	}

	/** The user's decision on this run's framework improvements. */
	async resolveImprovements(choice: 'commit' | 'keep' | 'discard'): Promise<void> {
		const pending = this.state.improvements;
		if (!pending || pending.state !== 'pending') return;
		if (choice === 'keep') {
			this.update({status: 'done', improvements: {...pending, state: 'kept'}});
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
		this.update({status: 'done', improvements: {files: pending.files, state: choice === 'commit' ? 'committed' : 'discarded'}});
	}

	/** Task ID and title of the Plan file this run produced or worked on, for the run block. */
	planSummary(): string | null {
		const file = this.resolveHubPath(this.state.outputs.planFile);
		if (!file) return null;
		const fields = readFrontmatter(readFileSync(file, 'utf8'));
		return `${fields['task_id'] ?? ''} ${fields['title'] ?? ''}`.trim() || null;
	}
}
