import type {TargetRepo} from '../core/targetRepo.js';
import {commandUsage, type ParsedInput} from './registry.js';

export type Tone = 'info' | 'success' | 'warning' | 'error';
export type OverlayKind = 'help' | 'doctor' | 'settings' | 'framework';

/** What the TUI does for one submitted input. Kept free of UI code so every rule can be tested directly. */
export type Effect =
	| {type: 'note'; tone: Tone; text: string; hint?: string}
	| {type: 'overlay'; overlay: OverlayKind}
	| {type: 'doctor'}
	| {type: 'clear'}
	| {type: 'exit'};

export type DispatchContext = {target: TargetRepo};

const LAYER_PHASE: Record<string, {label: string; phase: number}> = {
	'pirl-plan': {label: 'Plan', phase: 1},
	'pirl-implement': {label: 'Implement', phase: 2},
	'pirl-review': {label: 'Review', phase: 2},
};

export function dispatch(input: ParsedInput, context: DispatchContext): Effect[] {
	switch (input.kind) {
		case 'empty':
			return [];
		case 'unknown-command':
			return [{type: 'note', tone: 'error', text: `Không có lệnh /${input.name}.`, hint: 'Gõ /help để xem danh sách lệnh.'}];
		case 'text':
			// Phase 2: the coordinator classifies free text (question, standalone task, framework maintenance) per AGENTS.md.
			return [
				{
					type: 'note',
					tone: 'info',
					text: 'Trò chuyện với coordinator (câu hỏi, standalone task, bảo trì framework) có từ giai đoạn 2.',
					hint: 'Gõ /help để xem những lệnh đã dùng được.',
				},
			];
		case 'command':
			break;
	}
	const {spec, request} = input;
	const layer = LAYER_PHASE[spec.name];
	if (layer) {
		if (context.target.kind !== 'git') {
			return [
				{
					type: 'note',
					tone: 'error',
					text: `Layer ${layer.label} bị khoá: ${context.target.reason.toLowerCase()}.`,
					hint: 'Thoát (/exit), chuyển tới thư mục của một git repo rồi gõ lại `pirl`.',
				},
			];
		}
		if (!request) {
			return [{type: 'note', tone: 'warning', text: `Thiếu nội dung request.`, hint: `Cú pháp: ${commandUsage(spec)}`}];
		}
		return [
			{
				type: 'note',
				tone: 'info',
				text: `Layer ${layer.label} chạy được từ giai đoạn ${layer.phase} của pilot Claude Code; bản này mới có khung TUI.`,
			},
		];
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
		case 'clear':
			return [{type: 'clear'}];
		case 'exit':
			return [{type: 'exit'}];
		case 'resume':
			return [{type: 'note', tone: 'info', text: 'Không có run nào đang dở.'}];
		case 'plans':
		case 'records':
			return [{type: 'note', tone: 'info', text: `/${spec.name} có từ giai đoạn 2, khi các layer tạo ra Plan và record.`}];
		default:
			return [];
	}
}
