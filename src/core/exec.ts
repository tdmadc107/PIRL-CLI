import spawn from 'cross-spawn';

export type ExecResult = {
	/** Exit code; null when the process could not start or was killed by the timeout. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the program is missing or could not be started. */
	error?: string;
	timedOut?: boolean;
};

export type ExecOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	input?: string;
};

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Runs a program without a shell. cross-spawn resolves `.cmd` shims on Windows (claude, npm, ...). */
export const exec: Exec = (command, args, options = {}) =>
	new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeoutMs ?? 30_000);
		child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
		child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
		child.on('error', error => finish({code: null, stdout, stderr, error: error.message}));
		child.on('close', code => finish({code: timedOut ? null : code, stdout, stderr, timedOut}));
		child.stdin?.on('error', () => {});
		child.stdin?.end(options.input ?? '');
	});

export const succeeded = (result: ExecResult) => result.code === 0 && !result.error;
