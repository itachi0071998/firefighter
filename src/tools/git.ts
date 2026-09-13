/**
 * Thin, safe wrapper around the git CLI.
 *
 * Two rules make this module boring on purpose:
 *   1. Arguments are always passed as an argv array to execFileSync. A shell
 *      string is never constructed, so nothing in a branch name, commit
 *      message or file path can turn into shell metacharacters.
 *   2. Every invocation is screened by `assertSafeGitCommand` first, so the
 *      single place that decides "is this git command allowed" is the guard
 *      module — force pushes and writes to protected branches are refused
 *      centrally rather than being re-checked at each call site.
 */
import { execFileSync } from 'node:child_process';
import { assertSafeGitCommand } from './guard.ts';
import { logger } from '../util/log.ts';

const log = logger('tools/git');

/** Result of a single git invocation. `code` is 0 on success. */
export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Options accepted by {@link git} and {@link gitOk}. */
export interface GitOptions {
  /** Working directory to run in. Defaults to the current process cwd. */
  cwd?: string;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  /** When true a non-zero exit code is returned instead of thrown. */
  allowFail?: boolean;
}

interface ExecError extends Error {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function asText(v: string | Buffer | undefined): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : v.toString('utf8');
}

/**
 * Run a git command.
 *
 * @param args   argv for git, e.g. `['log', '-n', '5', '--pretty=%H']`.
 * @param opts   cwd / extra env / whether a non-zero exit is tolerated.
 * @returns      stdout, stderr and the exit code.
 * @throws       {@link UnsafeActionError} if the guard rejects the command, or
 *               an Error carrying git's stderr when the command fails and
 *               `allowFail` is not set.
 */
export function git(args: string[], opts: GitOptions = {}): GitResult {
  assertSafeGitCommand(args, null);
  const env = { ...process.env, ...(opts.env ?? {}) };
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: asText(stdout), stderr: '', code: 0 };
  } catch (err) {
    const e = err as ExecError;
    const result: GitResult = {
      stdout: asText(e.stdout),
      stderr: asText(e.stderr) || e.message,
      code: typeof e.status === 'number' ? e.status : 1,
    };
    if (opts.allowFail) {
      log.debug(`git ${args.join(' ')} -> exit ${result.code}`);
      return result;
    }
    throw new Error(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
}

/**
 * Run a git command purely to ask a yes/no question (does this ref exist, is
 * this a repository, ...). Never throws for a non-zero exit.
 *
 * @param args argv for git.
 * @param opts cwd / extra env.
 * @returns true when git exited 0.
 */
export function gitOk(args: string[], opts: GitOptions = {}): boolean {
  try {
    return git(args, { ...opts, allowFail: true }).code === 0;
  } catch {
    // Guard rejection or a missing git binary both mean "no".
    return false;
  }
}

/**
 * Convenience for read-only commands whose stdout is the answer.
 *
 * @param args argv for git.
 * @param opts cwd / extra env.
 * @returns trimmed stdout, or '' when the command failed.
 */
export function gitOut(args: string[], opts: GitOptions = {}): string {
  const r = git(args, { ...opts, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : '';
}
