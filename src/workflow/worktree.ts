import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';

const log = logger('worktree');

/**
 * Make sure a ref exists in the LOCAL repository.
 *
 * With a remote GitHub provider, branches are created server-side, so the local
 * clone has never heard of them. Verification runs locally (that is the point —
 * we execute the tests ourselves), so the ref is fetched down first.
 */
export function ensureLocalRef(repoPath: string, ref: string): void {
  const exists = (): boolean => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: repoPath,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  if (exists()) return;

  let remotes = '';
  try {
    remotes = execFileSync('git', ['remote'], { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch {
    /* not a git repo */
  }
  if (!remotes) {
    throw new Error(
      `ref "${ref}" does not exist in ${repoPath} and the repository has no remote to fetch it from`,
    );
  }
  const remote = remotes.split('\n')[0].trim();
  log.info(`fetching ${ref} from ${remote} for local verification`);
  execFileSync('git', ['fetch', remote, `+refs/heads/${ref}:refs/heads/${ref}`], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  if (!exists()) throw new Error(`could not fetch ref "${ref}" from ${remote}`);
}

/**
 * Materialise a branch into a throwaway git worktree, run `fn` against it, and
 * always clean up.
 *
 * Every verification step uses this instead of checking branches out in place,
 * so the demo repository's working tree is never mutated and concurrent steps
 * cannot collide.
 */
export async function withWorktree<T>(
  repoPath: string,
  ref: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(os.tmpdir(), `ff-wt-${shortHash(repoPath + ref, 10)}`);
  ensureLocalRef(repoPath, ref);
  cleanup(repoPath, dir);
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: repoPath, encoding: 'utf8' });
  try {
    return await fn(dir);
  } finally {
    cleanup(repoPath, dir);
  }
}

function cleanup(repoPath: string, dir: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoPath, stdio: 'ignore' });
  } catch {
    /* worktree may not exist */
  }
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`could not remove ${dir}: ${String(err)}`);
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}
