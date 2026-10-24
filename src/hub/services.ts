import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Config} from '../core/config.js';
import {proposeMerge} from '../engine/agentMerge.js';
import {discardImprovements} from '../engine/hubData.js';
import type {AgentRunner} from '../engine/types.js';
import type {FrameworkServices} from '../ui/session.js';
import type {BundledFramework} from './framework.js';
import {hubStatus} from './hub.js';
import * as update from './update.js';

/** `/framework` on the real Hub (src/hub/update.ts); the agent merge goes through the user's provider. */
export function frameworkServices(path: string, bundle: BundledFramework, runner: AgentRunner, modelOf: (config: Config) => string | undefined): FrameworkServices {
	return {
		status: () => hubStatus(path, bundle),
		changes: () => update.localChanges(path),
		diff: file => update.fileDiff(path, file),
		textDiff: (from, to) => update.textDiff(from, to),
		history: () => update.improvementHistory(path),
		restore: file => update.restoreFile(path, file),
		lastUpdate: () => update.lastUpdate(path),
		undo: tag => update.undoUpdate(path, tag),
		commitUncommitted: files => update.commitUncommitted(path, files),
		discardUncommitted: async files => {
			const result = await discardImprovements(path, files);
			if (!result.ok) throw new Error(result.error ?? 'Không bỏ được các thay đổi.');
		},
		startUpdate: () => update.startUpdate(path, bundle),
		resolve: (draft, file, choice) => update.resolveConflict(draft.dir, file, choice),
		readDraft: (draft, file) => {
			try {
				return readFileSync(join(draft.dir, file), 'utf8');
			} catch {
				return null;
			}
		},
		proposeMerge: (draft, conflict, config) => proposeMerge(runner, draft.dir, conflict, modelOf(config)),
		finishUpdate: (draft, python) => update.finishUpdate(path, draft, python),
		abortUpdate: () => update.removeDraft(path),
	};
}
