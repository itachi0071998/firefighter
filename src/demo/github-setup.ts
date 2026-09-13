/**
 * One-time OPERATOR setup that mirrors the seeded demo repository onto real
 * GitHub, so Firefighter can investigate genuine remote history.
 *
 * Deliberately performs NO merges and NO deployments: it only creates a
 * repository and pushes the already-linear seeded history to main. Each seeded
 * commit subject carries its pull-request number (e.g. "... (#142)"), which is
 * how the adapter recovers the change set without any pull request having to be
 * merged. Firefighter never merges; neither does its setup.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { readMeta, writeMeta } from './meta.ts';
import { logger } from '../util/log.ts';

const log = logger('github-setup');

function run(file: string, args: string[], cwd?: string): string {
  return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryRun(file: string, args: string[], cwd?: string): string | null {
  try {
    return run(file, args, cwd);
  } catch {
    return null;
  }
}

/**
 * Point the demo repo's `origin` at the configured GitHub repository.
 *
 * Re-seeding rebuilds `.git` from scratch and therefore drops the remote, but
 * remote providers need it: verification fetches agent-created branches down
 * to run the tests locally. Safe to call repeatedly, and a no-op when GitHub is
 * mocked or the CLI cannot resolve the repository.
 */
export function ensureOriginRemote(repoSlug: string, repoPath: string = config.demoRepoPath): boolean {
  if (!repoSlug.includes('/')) return false;
  const remote = tryRun('gh', ['repo', 'view', repoSlug, '--json', 'sshUrl', '--jq', '.sshUrl']);
  if (!remote) return false;
  if (tryRun('git', ['remote', 'get-url', 'origin'], repoPath)) {
    tryRun('git', ['remote', 'set-url', 'origin', remote], repoPath);
  } else {
    tryRun('git', ['remote', 'add', 'origin', remote], repoPath);
  }
  log.info(`origin -> ${repoSlug}`);
  return true;
}

export interface GitHubSetupResult {
  repo: string;
  url: string;
  branch: string;
  commits: { sha: string; subject: string }[];
  created: boolean;
}

export async function setupGitHubDemo(
  repoSlug: string,
  opts: { private?: boolean } = {},
): Promise<GitHubSetupResult> {
  const meta = readMeta(config.demoRepoPath);
  if (!meta) {
    throw new Error(`demo repo is not seeded at ${config.demoRepoPath}; run "npm run seed -- --force" first`);
  }
  if (!repoSlug.includes('/')) throw new Error(`expected owner/name, got "${repoSlug}"`);

  const existed = tryRun('gh', ['repo', 'view', repoSlug, '--json', 'name']) !== null;
  if (!existed) {
    log.info(`creating ${repoSlug}`);
    run('gh', [
      'repo',
      'create',
      repoSlug,
      opts.private === false ? '--public' : '--private',
      '--description',
      'Firefighter demo — intentionally buggy checkout service',
    ]);
  } else {
    log.info(`${repoSlug} already exists, reusing it`);
  }

  const remote = run('gh', ['repo', 'view', repoSlug, '--json', 'sshUrl', '--jq', '.sshUrl']);

  // Work in a throwaway clone so the demo repo's own state is untouched.
  const work = path.join(os.tmpdir(), `ff-gh-setup-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  run('git', ['clone', '--no-local', '--branch', meta.defaultBranch, config.demoRepoPath, work]);
  run('git', ['remote', 'set-url', 'origin', remote], work);

  log.info(`pushing ${meta.defaultBranch} to ${repoSlug}`);
  run('git', ['push', '-u', 'origin', `${meta.defaultBranch}:refs/heads/${meta.defaultBranch}`], work);

  const commits = run('git', ['log', '--format=%H%x09%s', meta.defaultBranch], work)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\t');
      return { sha, subject };
    });

  writeMeta(config.demoRepoPath, {
    ...meta,
    owner: repoSlug.split('/')[0],
    name: repoSlug.split('/')[1],
  });

  // Point the demo repo itself at the remote, so verification steps can fetch
  // branches the agent created server-side.
  if (tryRun('git', ['remote', 'get-url', 'origin'], config.demoRepoPath)) {
    run('git', ['remote', 'set-url', 'origin', remote], config.demoRepoPath);
  } else {
    run('git', ['remote', 'add', 'origin', remote], config.demoRepoPath);
  }

  fs.rmSync(work, { recursive: true, force: true });
  return {
    repo: repoSlug,
    url: `https://github.com/${repoSlug}`,
    branch: meta.defaultBranch,
    commits,
    created: !existed,
  };
}
