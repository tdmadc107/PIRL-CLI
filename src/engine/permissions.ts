import type {RunKind, Permissions} from './types.js';

/**
 * Claude Code permission rules for one run (proposal section 7.2). The run uses permission mode `dontAsk`:
 * anything not allowed here is refused, so no prompt can stall a run nobody can answer.
 * Absolute paths are written as `//path`; Windows paths become `//d/Project/...`.
 */
export function ruleRoot(path: string): string {
	const posix = path.replace(/\\/g, '/');
	const drive = /^([A-Za-z]):\/?(.*)$/.exec(posix);
	const absolute = drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : posix;
	return `/${absolute.replace(/\/+$/, '')}`;
}

/** Commands the framework's tools need, from the Hub: record, validator, helper scripts, framework tests. */
export function pythonRules(python: {command: string; args: string[]}): string[] {
	const prefix = [python.command, ...python.args, '-B'].join(' ');
	return [`Bash(${prefix} .agents/evals/*)`, `Bash(${prefix} .skills/*)`, `Bash(${prefix} -m unittest *)`];
}

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Agent', 'TodoWrite'];
const GIT_READ_SUBCOMMANDS = ['log', 'show', 'diff', 'status', 'ls-files', 'rev-parse', 'blame'];
const GIT_READ = GIT_READ_SUBCOMMANDS.map(command => `Bash(git ${command} *)`);
/** Read-only Git in another repository, as `git -C <path> log ...` with the path written exactly as given. */
const gitReadIn = (path: string) => GIT_READ_SUBCOMMANDS.map(command => `Bash(git -C ${path} ${command} *)`);

/**
 * Tools that make a headless run wait: scheduled wakeups, timers and watches keep `claude -p` open until they
 * fire, so a run would never end. Removed from every run; the runner also turns background work off.
 */
export const WAITING_TOOLS = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'Monitor', 'RemoteTrigger'];

/** Functional tests under FUT; the target repository's documentation says which one applies. */
export const TEST_RUNNERS = [
	'npm test',
	'npm run test',
	'pnpm test',
	'pnpm run test',
	'yarn test',
	'bun test',
	'npx vitest',
	'npx jest',
	'pytest',
	'python -m pytest',
	'python3 -m pytest',
	'py -m pytest',
	'go test',
	'cargo test',
	'dotnet test',
	'mvn test',
	'gradle test',
	'./gradlew test',
	'php artisan test',
	'vendor/bin/phpunit',
].map(command => `Bash(${command} *)`);

/** Never allowed in any run: the framework leaves commits, pushes and destructive Git operations to the user. */
const ALWAYS_DENY = ['git commit', 'git push', 'git reset', 'git clean', 'git checkout', 'git switch', 'git stash', 'git rebase', 'git merge', 'git tag', 'rm'].map(
	command => `Bash(${command} *)`,
);

export function permissionsFor(kind: RunKind, paths: {hub: string; target: string | null}, python: {command: string; args: string[]} | null): Permissions {
	const hub = ruleRoot(paths.hub);
	const target = paths.target ? ruleRoot(paths.target) : null;
	const sameRoot = target === hub;
	const allow = [...READ_TOOLS, ...GIT_READ, ...gitReadIn(paths.hub), ...(paths.target ? gitReadIn(paths.target) : []), ...(python ? pythonRules(python) : []), `Edit(${hub}/**)`];
	const deny = [...WAITING_TOOLS, ...ALWAYS_DENY];
	if (target && !sameRoot) {
		if (kind === 'implement' || kind === 'chat') allow.push(`Edit(${target}/**)`);
		else deny.push(`Edit(${target}/**)`);
	}
	if (kind === 'implement') allow.push(...TEST_RUNNERS);
	return {allow, deny};
}
