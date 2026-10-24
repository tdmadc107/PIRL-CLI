import type {Question, RunKind} from './types.js';

/**
 * The contract between PIRL CLI and the coordinator, appended to the provider's system prompt.
 * The framework's own files (AGENTS.md, the router, the layer's skill) still decide how the work is done;
 * this text only says how the run is hosted: who can answer, how to ask, what to hand back.
 */
export type HostContext = {
	kind: RunKind;
	hub: string;
	target: string | null;
	python: {command: string; args: string[]} | null;
	maxParallelRoles: number;
	/** Plans and reports from earlier runs of this session, for chat context. */
	recentOutputs?: string[];
};

const SKILL: Record<Exclude<RunKind, 'chat'>, string> = {
	plan: '.skills/pirl-plan/SKILL.md',
	implement: '.skills/pirl-implement/SKILL.md',
	review: '.skills/pirl-review/SKILL.md',
};

const LAYER_NAME: Record<Exclude<RunKind, 'chat'>, string> = {plan: 'Plan', implement: 'Implement', review: 'Review'};

export function hostInstructions(context: HostContext): string {
	const python = context.python ? [context.python.command, ...context.python.args].join(' ') : 'python';
	const lines = [
		'# PIRL CLI host',
		'',
		'You are the coordinator of the PIRL framework, run by PIRL CLI, a terminal UI, in non-interactive mode.',
		`- The Hub (framework root) is your working directory: ${context.hub}. Read AGENTS.md there first and follow it, with CONTEXT.md for every answer.`,
		context.target
			? `- The target repository is ${context.target}. Write it as an absolute path wherever a Plan or report records target_repo.`
			: '- No target repository: the user started PIRL CLI outside a Git repository.',
		`- Run every Python command of the framework as \`${python} -B ...\` from the Hub root (for example \`${python} -B .agents/evals/layer_record.py start\`). Other spellings are refused.`,
		'- Run each framework command as one plain command from the Hub root: no `cd`, no heredoc, no pipe, no `&&`. Pass JSON through a file, for example `layer_record.py append --input .tmp/pirl-run/record.json`.',
		context.target
			? `- Read the target repository's Git history with \`git -C ${context.target} log ...\` (also show, diff, status, ls-files, rev-parse, blame), the path written exactly like that.`
			: '',
		'- Temporary files go under `.tmp/pirl-run/` in the Hub; PIRL CLI deletes that directory when the run ends, so do not delete them yourself. Nothing outside the Hub and the target repository is writable; `/tmp` is refused.',
		'- Run subagents in the foreground and wait for their results in this turn. Do not start background work or schedule wakeups: the run ends when your reply ends.',
		'- The run\'s permissions are fixed by PIRL CLI and cannot change during the run. Never ask the user to grant a permission; when a command is refused, use the allowed form above, or say what could not be done.',
		'- Write your replies to the user in the language of the user\'s request; the framework\'s files (Plans, reports, records) keep the language their format requires.',
	];
	if (context.kind === 'chat') {
		lines.push(
			'- No layer was opened. The user typed text without a slash command: answer a question, do a standalone task or framework maintenance, per AGENTS.md "Choosing a layer".',
			'- If the user\'s words ask for a layer (create a Plan, implement a Plan, review), do not run it. End your reply with the slash command the user should type, in a fenced block:',
			'```pirl-suggest',
			'/pirl-plan <the request, restated>',
			'```',
		);
		if (context.recentOutputs?.length) lines.push(`- Outputs of earlier runs in this session: ${context.recentOutputs.join('; ')}.`);
	} else {
		const kind = context.kind;
		lines.push(
			`- The user opened the ${LAYER_NAME[kind]} layer with /pirl-${kind}; that is their explicit request for this layer and for delegating its roles to agents. Run the layer through \`${SKILL[kind]}\`. Do not open any other layer.`,
			`- Delegate each role to the subagent of the same name (business-analyst, code-analyst, …), with the Agent tool. Run at most ${context.maxParallelRoles} role subagents at the same time.`,
		);
	}
	lines.push(
		'- Nobody can answer a prompt while you run. When a decision only the user can make is missing, finish the parts that do not depend on it, then end your reply with the questions in a fenced block; PIRL CLI shows them and resumes this session with the answers:',
		'```pirl-questions',
		'[{"id": "Q1", "question": "…", "options": ["…", "…"], "recommended": 0}]',
		'```',
		'- Do not commit, push or switch branches anywhere. Leave framework improvements uncommitted in the Hub: PIRL CLI shows them and asks the user whether to commit.',
		'- Some commands are refused by the run\'s permissions. When one is refused, do not retry it; say what could not be done.',
	);
	if (context.kind !== 'chat') {
		lines.push(
			'- At the very end of your final reply, after the closing block of CONTEXT.md, add the outputs of this run in a fenced block (paths absolute):',
			'```pirl-result',
			'{"plan_set": "<package directory or null>", "plan_file": "<Plan file or null>", "report": "<Review report or null>", "record_id": "<record id or null>"}',
			'```',
		);
	}
	return lines.filter(line => line !== '').join('\n');
}

const blockPattern = (name: string) => new RegExp('```' + name + '\\s*\\n([\\s\\S]*?)\\n?```', 'g');

/** Text of the last fenced block with this name, or null. */
export function lastBlock(text: string, name: string): string | null {
	const matches = [...text.matchAll(blockPattern(name))];
	return matches.length > 0 ? matches.at(-1)![1]!.trim() : null;
}

/** The reply as the user should read it: the machine-readable blocks are taken out. */
export function stripBlocks(text: string): string {
	return ['pirl-questions', 'pirl-result', 'pirl-suggest']
		.reduce((current, name) => current.replace(blockPattern(name), ''), text)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function parseQuestions(text: string): Question[] {
	const block = lastBlock(text, 'pirl-questions');
	if (!block) return [];
	try {
		const data = JSON.parse(block) as unknown;
		if (!Array.isArray(data)) return [];
		return data
			.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>)['question'] === 'string')
			.map((item, index) => ({
				id: typeof item['id'] === 'string' ? item['id'] : `Q${index + 1}`,
				question: String(item['question']),
				options: Array.isArray(item['options']) ? (item['options'] as unknown[]).map(String) : [],
				recommended: typeof item['recommended'] === 'number' ? item['recommended'] : undefined,
			}));
	} catch {
		return [];
	}
}

export type RunOutputs = {planSet: string | null; planFile: string | null; report: string | null; recordId: string | null};

export function parseOutputs(text: string): RunOutputs {
	const empty: RunOutputs = {planSet: null, planFile: null, report: null, recordId: null};
	const block = lastBlock(text, 'pirl-result');
	if (!block) return empty;
	try {
		const data = JSON.parse(block) as Record<string, unknown>;
		const value = (key: string) => (typeof data[key] === 'string' && data[key] !== 'null' && data[key] !== '' ? (data[key] as string) : null);
		return {planSet: value('plan_set'), planFile: value('plan_file'), report: value('report'), recordId: value('record_id')};
	} catch {
		return empty;
	}
}

export const parseSuggestion = (text: string) => lastBlock(text, 'pirl-suggest')?.split('\n')[0]?.trim() || null;

/** The message that resumes the session once the user has answered every question. */
export function answersMessage(questions: Question[], answers: string[]): string {
	return [
		'Câu trả lời của người dùng cho các câu hỏi trong khối pirl-questions:',
		...questions.map((question, index) => `- ${question.id} (${question.question}): ${answers[index] ?? '(không trả lời)'}`),
		'Ghi các câu trả lời này đúng nguyên văn vào output của run như AGENTS.md yêu cầu, rồi tiếp tục.',
	].join('\n');
}
