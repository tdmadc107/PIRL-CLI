import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentDefinition} from './types.js';

export const CATALOG_FILE = '.agents/instructions/standalone-and-maintenance.instructions.md';

export type CatalogRole = {id: string; expertise: string; usedIn: string[]};

/** Reads the role catalog table of the Hub's framework, the only list of role IDs. */
export function readRoleCatalog(hub: string): CatalogRole[] {
	const text = readFileSync(join(hub, CATALOG_FILE), 'utf8');
	const section = text.slice(text.indexOf('### Role catalog'));
	const roles: CatalogRole[] = [];
	for (const line of section.split('\n')) {
		const match = /^\|\s*`([a-z-]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
		if (match) roles.push({id: match[1]!, expertise: match[2]!, usedIn: match[3]!.split(',').map(part => part.trim())});
	}
	return roles;
}

/**
 * The tools each role's subagent gets. Implementation roles edit files; the roles that trace code may run
 * read-only Git commands; process-auditor improves framework files and runs the framework's checks.
 * Which paths may be edited and which commands may run is limited further by the run's permission rules.
 */
export function roleTools(role: CatalogRole): string[] {
	const read = ['Read', 'Grep', 'Glob'];
	if (role.id === 'process-auditor') return [...read, 'Edit', 'Write', 'Bash'];
	if (role.usedIn.includes('implement')) return role.id === 'technical-writer' ? [...read, 'Edit', 'Write'] : [...read, 'Edit', 'Write', 'Bash'];
	if (role.id === 'code-analyst' || role.id === 'code-reviewer') return [...read, 'Bash'];
	return read;
}

/**
 * How a role uses its tools under the run's permission rules (src/engine/permissions.ts). Subagents do not see the
 * coordinator's host instructions, and a refused command costs a turn, so each role gets these rules itself.
 */
function toolRules(target: string | null): string[] {
	return [
		'Read files with the Read, Grep and Glob tools, never with `cat`, `ls`, `grep`, `find` or `head` in Bash: the run refuses those.',
		'Bash runs one command per call, without pipes or `;`. It is allowed only for: read-only Git (`log`, `show`, `diff`, `status`, `ls-files`, `rev-parse`, `blame`), the framework\'s Python tools run from the Hub root, and the test command the target repository documents.',
		...(target ? [`In the target repository, run Git as \`git -C ${target} <command>\` and tests as \`cd ${target} && <test command>\`.`] : []),
		'Temporary files go under `.tmp/pirl-run/` in the Hub; `/tmp` and every path outside the Hub and the target repository are refused.',
	];
}

/**
 * `model` is the roles' model alias; they run on the coordinator's model when it is left out. `target` is the run's
 * target repository, named in the roles' command rules.
 */
export function roleAgents(
	hub: string,
	roles: CatalogRole[] = readRoleCatalog(hub),
	model?: string,
	target: string | null = null,
	effort?: string,
): Record<string, AgentDefinition> {
	return Object.fromEntries(
		roles.map(role => [
			role.id,
			{
				description: `PIRL role ${role.id}: ${role.expertise}. Delegate this role's assignment of a PIRL layer run to it.`,
				prompt: [
					`You are the PIRL role \`${role.id}\`.`,
					`Before anything else, read \`${join(hub, '.agents', 'roles', `${role.id}.role.md`)}\` and apply it.`,
					'Work only on the assignment the coordinator gave you, with the sources, constraints and settled direction it names.',
					'Support every conclusion with its source: file path and symbol, command and result, or the rule that applies.',
					'Do not read drafts or conclusions of other roles of this run unless your assignment hands them to you.',
					'Report every reviewer outside your role that you consulted. Never commit, push or change files your assignment does not cover.',
					...toolRules(target),
				].join('\n'),
				tools: roleTools(role),
				...(model ? {model} : {}),
				// Set on every role, not left to inheritance, so the roles reason at the level the user chose.
				...(effort ? {effort} : {}),
			},
		]),
	);
}
