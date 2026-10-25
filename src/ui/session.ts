import type {Tone} from '../commands/dispatch.js';
import type {Clipboard} from '../core/clipboard.js';
import type {Config, MouseSetting} from '../core/config.js';
import type {TargetRepo} from '../core/targetRepo.js';
import type {DoctorReport} from '../doctor/doctor.js';
import type {PlanPackage, RecordSummary} from '../engine/hubData.js';
import type {PersistedRun, RunController} from '../engine/run.js';
import type {Question, QuotaRow, RunKind} from '../engine/types.js';
import type {MergeProposal} from '../engine/agentMerge.js';
import type {AttachedContext, PathEntry} from '../engine/attachments.js';
import type {HubStatus} from '../hub/hub.js';
import type {Conflict, Draft, FinishResult, HistoryEntry, LastUpdate, LocalChange} from '../hub/update.js';

export type Message =
	| {id: number; kind: 'welcome'}
	| {id: number; kind: 'user'; text: string}
	| {id: number; kind: 'note'; tone: Tone; text: string; hint?: string}
	| {id: number; kind: 'run'; runId: number};

/** A message before it gets its id (Omit applied to each member of the union). */
export type NewMessage = Message extends infer M ? (M extends Message ? Omit<M, 'id'> : never) : never;

export type DoctorState = {state: 'idle'} | {state: 'running'; previous?: DoctorReport} | {state: 'done'; report: DoctorReport};

/** Facts about the session shown in the header, the side panel and /framework. */
export type SessionInfo = {
	cliVersion: string;
	target: TargetRepo;
	hub: HubStatus | null;
	hubError: string | null;
	/** A newer PIRL release on npm than the one running, once the background check has found one. */
	cliUpdate?: string | null;
};

export type StartRunOptions = {
	id: number;
	kind: RunKind;
	request: string;
	config: Config;
	python: {command: string; args: string[]} | null;
	/** Context from the files and folders attached with `@`. */
	attachments?: {text: string; dirs: string[]};
	/** Continue a provider session: a stopped run (/resume) or the session of earlier chat messages. */
	resume?: {
		sessionId: string;
		status?: PersistedRun['status'];
		questions?: Question[];
		before?: PersistedRun['before'];
		prompt?: string;
		providerTotals?: PersistedRun['providerTotals'];
		key?: string;
		startedAt?: string;
	};
	recentOutputs?: string[];
};

/** What `/framework` does to the Hub (src/hub/update.ts); tests pass fakes. */
export type FrameworkServices = {
	status(): Promise<HubStatus>;
	changes(): Promise<LocalChange[]>;
	diff(path: string): Promise<string>;
	textDiff(from: string | null, to: string | null): Promise<string>;
	history(): Promise<HistoryEntry[]>;
	restore(path: string): Promise<void>;
	lastUpdate(): Promise<LastUpdate | null>;
	undo(tag: string): Promise<void>;
	commitUncommitted(files: string[]): Promise<void>;
	discardUncommitted(files: string[]): Promise<void>;
	startUpdate(): Promise<Draft>;
	resolve(draft: Draft, path: string, choice: 'mine' | 'theirs' | {content: string | null}): Promise<void>;
	/** The draft's copy of a file, for a conflict the user edits by hand; null when the file is gone. */
	readDraft(draft: Draft, path: string): string | null;
	proposeMerge(draft: Draft, conflict: Conflict, config: Config): Promise<MergeProposal>;
	finishUpdate(draft: Draft, python: {command: string; args: string[]} | null): Promise<FinishResult>;
	abortUpdate(): Promise<void>;
};

/** Side effects the TUI needs from outside; tests pass fakes. */
export type Services = {
	runDoctor(config: Config): Promise<DoctorReport>;
	saveConfig(config: Config): void;
	startRun?(options: StartRunOptions): RunController;
	saveRun?(run: PersistedRun): void;
	/** The saved layer runs of the target repository, newest first, for /resume. */
	runs?(): PersistedRun[];
	plans?(): PlanPackage[];
	records?(): RecordSummary[];
	clipboard?: Clipboard;
	framework?: FrameworkServices;
	/** The plan's usage windows from the provider (`/usage`, no model request); null when it does not report them. */
	quota?(): Promise<QuotaRow[] | null>;
	/** Files and folders of the target repository (the start directory outside one), for completing `@`. */
	paths?(): Promise<PathEntry[]>;
	/** The context of the `@` mentions of a request that name existing paths (src/engine/attachments.ts). */
	attach?(text: string): Promise<AttachedContext>;
	/** A newer PIRL release than the running one, or null (src/core/selfUpdate.ts); asked once at start, in the background. */
	cliUpdate?(): Promise<string | null>;
	/** Tells the terminal what PIRL wants from the mouse (src/ui/terminalInput.ts, mouseSequence). */
	setMouse?(mode: MouseSetting): void;
};

export type StartupNote = {tone: Tone; text: string; hint?: string};
