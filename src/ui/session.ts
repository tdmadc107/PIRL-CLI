import type {Tone} from '../commands/dispatch.js';
import type {Clipboard} from '../core/clipboard.js';
import type {Config} from '../core/config.js';
import type {TargetRepo} from '../core/targetRepo.js';
import type {DoctorReport} from '../doctor/doctor.js';
import type {PlanPackage, RecordSummary} from '../engine/hubData.js';
import type {PersistedRun, RunController} from '../engine/run.js';
import type {Question, RunKind} from '../engine/types.js';
import type {HubStatus} from '../hub/hub.js';

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
};

export type StartRunOptions = {
	id: number;
	kind: RunKind;
	request: string;
	config: Config;
	python: {command: string; args: string[]} | null;
	/** Continue a provider session: a stopped run (/resume) or the session of earlier chat messages. */
	resume?: {sessionId: string; status?: PersistedRun['status']; questions?: Question[]; before?: PersistedRun['before']; prompt?: string};
	recentOutputs?: string[];
};

/** Side effects the TUI needs from outside; tests pass fakes. */
export type Services = {
	runDoctor(config: Config): Promise<DoctorReport>;
	saveConfig(config: Config): void;
	startRun?(options: StartRunOptions): RunController;
	saveRun?(run: PersistedRun): void;
	lastRun?(): PersistedRun | null;
	plans?(): PlanPackage[];
	records?(): RecordSummary[];
	clipboard?: Clipboard;
};

export type StartupNote = {tone: Tone; text: string; hint?: string};
