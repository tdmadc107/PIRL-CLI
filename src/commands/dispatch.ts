import {t} from '../core/i18n.js';
import type {TargetRepo} from '../core/targetRepo.js';
import type {RunKind} from '../engine/types.js';
import {commandUsage, type ParsedInput} from './registry.js';

export type Tone = 'info' | 'success' | 'warning' | 'error';
export type OverlayKind = 'help' | 'doctor' | 'settings' | 'framework' | 'plans' | 'records' | 'resume';

/** What the TUI does for one submitted input. Kept free of UI code so every rule can be tested directly. */
export type Effect =
	| {type: 'note'; tone: Tone; text: string; hint?: string}
	| {type: 'overlay'; overlay: OverlayKind}
	| {type: 'doctor'}
	| {type: 'run'; kind: RunKind; request: string}
	| {type: 'resume'}
	| {type: 'copy'}
	| {type: 'clear'}
	| {type: 'exit'};

export type DispatchContext = {target: TargetRepo};

const LAYERS = {'pirl-plan': 'plan', 'pirl-implement': 'implement', 'pirl-review': 'review'} as const;
const LABELS = {plan: 'Plan', implement: 'Implement', review: 'Review'} as const;

export function dispatch(input: ParsedInput, context: DispatchContext): Effect[] {
	switch (input.kind) {
		case 'empty':
			return [];
		case 'unknown-command':
			return [{type: 'note', tone: 'error', text: t(`Không có lệnh /${input.name}.`, `There is no /${input.name} command.`), hint: t('Gõ /help để xem danh sách lệnh.', 'Type /help to see the commands.')}];
		case 'text':
			// The coordinator classifies free text (question, standalone task, framework maintenance) per AGENTS.md.
			return [{type: 'run', kind: 'chat', request: input.text}];
		case 'command':
			break;
	}
	const {spec, request} = input;
	if (spec.name in LAYERS) {
		const kind = LAYERS[spec.name as keyof typeof LAYERS];
		if (context.target.kind !== 'git') {
			return [
				{
					type: 'note',
					tone: 'error',
					text: t(`Layer ${LABELS[kind]} bị khoá: ${context.target.reason.toLowerCase()}.`, `The ${LABELS[kind]} layer is locked: ${context.target.reason.toLowerCase()}.`),
					hint: t('Thoát (/exit), chuyển tới thư mục của một git repo rồi gõ lại `pirl`.', 'Exit (/exit), go to the folder of a git repository and type `pirl` again.'),
				},
			];
		}
		if (!request) return [{type: 'note', tone: 'warning', text: t('Thiếu nội dung request.', 'The request is missing.'), hint: t(`Cú pháp: ${commandUsage(spec)}`, `Usage: ${commandUsage(spec)}`)}];
		return [{type: 'run', kind, request}];
	}
	switch (spec.name) {
		case 'help':
			return [{type: 'overlay', overlay: 'help'}];
		case 'doctor':
			return [{type: 'overlay', overlay: 'doctor'}, {type: 'doctor'}];
		case 'settings':
			return [{type: 'overlay', overlay: 'settings'}];
		case 'framework':
			return [{type: 'overlay', overlay: 'framework'}];
		case 'plans':
			return [{type: 'overlay', overlay: 'plans'}];
		case 'records':
			return [{type: 'overlay', overlay: 'records'}];
		case 'resume':
			return [{type: 'resume'}];
		case 'copy':
			return [{type: 'copy'}];
		case 'clear':
			return [{type: 'clear'}];
		case 'exit':
			return [{type: 'exit'}];
		default:
			return [];
	}
}
