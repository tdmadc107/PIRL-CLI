import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {t} from '../core/i18n.js';
import {hasConflictMarkers, type Conflict} from '../hub/update.js';
import {ruleRoot, WAITING_TOOLS} from './permissions.js';
import type {AgentRunner, RunEvent} from './types.js';

export type MergeProposal = {ok: true; content: string; explanation: string} | {ok: false; error: string};

/** Where the three versions and the merged result live during the proposal, inside the draft's ignored `.tmp/`. */
const WORK = join('.tmp', 'pirl-merge');

const SYSTEM_PROMPT = (dir: string, path: string) =>
	[
		'You merge one file of the PIRL framework during a framework update. Nothing else is in scope.',
		`The file is \`${path}\`. Its versions are in ${dir}:`,
		'- `base`: the original version both sides started from;',
		'- `mine`: the user\'s version, carrying their local improvements;',
		'- `theirs`: the new original version.',
		`Read the three, then write the merged file to ${join(dir, 'merged')} with the Write tool.`,
		'Keep every change of `theirs` and every local improvement of `mine`. Where both change the same passage, write one passage that carries both intentions. When they contradict, prefer `theirs`, unless the local change makes a rule stricter.',
		'Never loosen, narrow or remove a safety rule (AGENTS.md, "Safety rules and self-improvement", defines them); where a safety rule differs between the versions, keep the stricter wording.',
		'The merged file holds only the file content: no conflict markers, no comments about the merge.',
		`Then reply in the language of the file's user, ${t('Vietnamese', 'English')}, in at most four short sentences: what each side changed and how you combined them.`,
	].join('\n');

/**
 * Asks the provider for a merged version of one conflicted file. Nothing is applied here: the proposal goes to the
 * user, who accepts it or picks another resolution. The provider may read the draft and write only the result file.
 */
export async function proposeMerge(runner: AgentRunner, draftDir: string, conflict: Conflict, model?: string): Promise<MergeProposal> {
	const work = join(draftDir, WORK);
	rmSync(work, {recursive: true, force: true});
	mkdirSync(work, {recursive: true});
	try {
		writeFileSync(join(work, 'base'), conflict.base ?? '', 'utf8');
		writeFileSync(join(work, 'mine'), conflict.mine ?? '', 'utf8');
		writeFileSync(join(work, 'theirs'), conflict.theirs ?? '', 'utf8');
		const improvements = conflict.myCommits.map(commit => `- ${commit.subject}${commit.record ? ` (record ${commit.record})` : ''}`);
		const prompt = [
			`Merge \`${conflict.path}\`.`,
			...(improvements.length ? ['The local improvements in `mine` came from:', ...improvements] : []),
		].join('\n');
		const merged = join(work, 'merged');
		let reply: Extract<RunEvent, {type: 'result'}> | null = null;
		const handle = runner.start(
			{
				cwd: draftDir,
				addDirs: [],
				prompt,
				systemPrompt: SYSTEM_PROMPT(work, conflict.path),
				agents: {},
				permissions: {
					allow: ['Read', 'Grep', 'Glob', `Edit(${ruleRoot(merged)})`],
					deny: ['Bash', 'Agent', 'WebFetch', 'WebSearch', ...WAITING_TOOLS],
				},
				model,
			},
			event => {
				if (event.type === 'result') reply = event;
			},
		);
		const exit = await handle.done;
		const result = reply as Extract<RunEvent, {type: 'result'}> | null;
		if (!result || result.isError) return {ok: false, error: result?.text || exit.stderr.trim().split('\n').slice(-2).join(' ') || t(`mã thoát ${exit.code}`, `exit code ${exit.code}`)};
		let content: string;
		try {
			content = readFileSync(merged, 'utf8');
		} catch {
			return {ok: false, error: t('Agent không ghi bản gộp.', 'The agent did not write a merged version.')};
		}
		if (hasConflictMarkers(content)) return {ok: false, error: t('Bản gộp của agent vẫn còn dấu xung đột.', 'The agent\'s merged version still has conflict markers.')};
		return {ok: true, content, explanation: result.text.trim()};
	} finally {
		rmSync(work, {recursive: true, force: true});
	}
}
