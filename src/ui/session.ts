import type {Tone} from '../commands/dispatch.js';
import type {Config} from '../core/config.js';
import type {TargetRepo} from '../core/targetRepo.js';
import type {DoctorReport} from '../doctor/doctor.js';
import type {HubStatus} from '../hub/hub.js';

export type Message =
	| {id: number; kind: 'welcome'}
	| {id: number; kind: 'user'; text: string}
	| {id: number; kind: 'note'; tone: Tone; text: string; hint?: string};

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

/** Side effects the TUI needs from outside; tests pass fakes. */
export type Services = {
	runDoctor(config: Config): Promise<DoctorReport>;
	saveConfig(config: Config): void;
};

export type StartupNote = {tone: Tone; text: string; hint?: string};
