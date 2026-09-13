/**
 * Builds the demo repository: a REAL git repository whose history is replayed
 * from {@link DEMO_COMMITS} with fixed author and committer dates, so every
 * commit sha is byte-for-byte reproducible across machines and reruns.
 *
 * Everything downstream (the git adapter, the mock GitHub adapter, the revert
 * and fix steps, the evals) reads this repository, so seeding is the foundation
 * of the whole demo.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../config.ts';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';
import { DEMO_COMMITS, type DemoCommitSpec } from './fixtures.ts';
import { SENTRY_ANCHORS, SENTRY_DEMO_COMMITS } from './fixtures-sentry.ts';

/**
 * Which demo service to build.
 *   'js'     - the self-contained JavaScript checkout service (default)
 *   'sentry' - a TypeScript service whose paths and line numbers match a real
 *              Sentry project, for INCIDENT_SOURCE=sentry
 */
export type DemoVariant = 'js' | 'sentry';

function commitsFor(variant: DemoVariant): DemoCommitSpec[] {
  return variant === 'sentry' ? SENTRY_DEMO_COMMITS : DEMO_COMMITS;
}

/**
 * The Sentry variant only works if its files line up with the frames Sentry
 * actually reports. An edit that shifts a line would silently break the
 * investigation, so the anchors are asserted at seed time instead.
 */
function verifySentryAnchors(repoPath: string): void {
  for (const anchor of SENTRY_ANCHORS) {
    const full = path.join(repoPath, anchor.path);
    if (!fs.existsSync(full)) {
      throw new Error(`sentry variant: expected ${anchor.path} to exist`);
    }
    const line = fs.readFileSync(full, 'utf8').split('\n')[anchor.line - 1] ?? '';
    if (!line.includes(anchor.contains)) {
      throw new Error(
        `sentry variant: ${anchor.path}:${anchor.line} must contain "${anchor.contains}" ` +
          `to match the Sentry stack frame, but line ${anchor.line} is: ${line.trim() || '(empty)'}`,
      );
    }
  }
}
import {
  META_FILENAME,
  readMeta,
  writeMeta,
  type DemoDeployMeta,
  type DemoPrMeta,
  type DemoRepoMeta,
} from './meta.ts';
import { nowIso } from '../util/clock.ts';

const log = logger('demo.seed');

/** Identity git records as the committer of every replayed squash merge. */
const COMMITTER_NAME = 'Firefighter Demo';
const COMMITTER_EMAIL = 'demo@firefighter.local';

/** Repo coordinates the demo pretends to live at. */
const DEMO_OWNER = 'firefighter-demo';
const DEMO_NAME = 'checkout-service';
const DEFAULT_BRANCH = 'main';

/** First PR number handed out to branches the agent opens. */
const NEXT_PR_NUMBER = 151;

/** A PR is opened roughly an hour before it merges. */
const PR_OPEN_LEAD_MS = 60 * 60 * 1000;

/**
 * Environment applied to every git invocation.
 *
 * The user's global and system git config is neutralised (never modified) so a
 * local commit.gpgsign, hooksPath or commit template cannot change the shas we
 * produce or block a commit.
 */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  TZ: 'UTC',
};

export interface SeedOptions {
  /** Where to build the repo. Defaults to config.demoRepoPath. */
  repoPath?: string;
  /** Delete the directory and rebuild from scratch. */
  force?: boolean;
  /** Which demo service to build. Defaults to 'js'. */
  variant?: DemoVariant;
}

export interface SeedResult {
  repoPath: string;
  meta: DemoRepoMeta;
  headSha: string;
  commits: { prNumber: number; sha: string }[];
}

/**
 * Run git with an argument vector (never a shell string).
 *
 * @param cwd - Working directory for the command.
 * @param args - Argument vector passed straight to git.
 * @param extraEnv - Per-command environment overrides, e.g. author dates.
 * @returns Trimmed stdout.
 */
function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
  }
}

/**
 * Slugify a commit title into a plausible branch name, used when a
 * DemoCommitSpec does not pin an explicit headRef.
 *
 * @param spec - The commit specification.
 */
function headRefFor(spec: DemoCommitSpec): string {
  if (spec.headRef) return spec.headRef;
  const colon = spec.title.indexOf(':');
  const prefix = colon === -1 ? 'chore' : spec.title.slice(0, colon).replace(/\(.*\)/, '').trim();
  const rest = colon === -1 ? spec.title : spec.title.slice(colon + 1);
  const slug = rest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix || 'chore'}/${slug}`;
}

/**
 * Resolve a repo-relative fixture path and refuse anything escaping the repo.
 *
 * @param repoPath - Repository root.
 * @param relative - Repo-relative path from a fixture.
 */
function safeJoin(repoPath: string, relative: string): string {
  const abs = path.resolve(repoPath, relative);
  const root = path.resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`fixture path escapes the demo repo: ${relative}`);
  }
  return abs;
}

/**
 * Materialise one commit: write its files, stage everything and commit with the
 * spec's date pinned as BOTH the author and the committer date.
 *
 * @param repoPath - Repository root.
 * @param spec - The commit to apply.
 * @returns The full sha of the new commit.
 */
function applyCommit(repoPath: string, spec: DemoCommitSpec): string {
  for (const relative of spec.deletes ?? []) {
    fs.rmSync(safeJoin(repoPath, relative), { force: true, recursive: true });
  }

  for (const [relative, contents] of Object.entries(spec.files)) {
    const abs = safeJoin(repoPath, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf8');
  }

  git(repoPath, ['add', '-A']);

  const subject = `${spec.title} (#${spec.prNumber})`;
  git(repoPath, ['commit', '--no-verify', '-m', subject, '-m', spec.body], {
    GIT_AUTHOR_NAME: spec.author,
    GIT_AUTHOR_EMAIL: spec.email,
    GIT_AUTHOR_DATE: spec.date,
    GIT_COMMITTER_NAME: COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
    GIT_COMMITTER_DATE: spec.date,
  });

  return git(repoPath, ['rev-parse', 'HEAD']);
}

/**
 * Shift an ISO timestamp by a fixed offset. Deterministic: it reformats a known
 * instant and never reads the wall clock.
 *
 * @param iso - Source timestamp.
 * @param deltaMs - Offset in milliseconds (negative moves earlier).
 */
function shiftIso(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

/**
 * Normalise a fixture timestamp to the exact ISO form the rest of the system
 * compares against.
 *
 * @param iso - Source timestamp.
 */
function isoOf(iso: string): string {
  return new Date(Date.parse(iso)).toISOString();
}

/**
 * Ensure the target directory is safe to build into, wiping stale state.
 *
 * Only an empty directory or something that already looks like a demo repo is
 * overwritten, so a mis-pointed FF_DEMO_REPO cannot destroy unrelated files.
 *
 * @param repoPath - Target directory.
 * @param force - Caller explicitly asked for a rebuild.
 */
function prepareTargetDir(repoPath: string, force: boolean): void {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
    return;
  }
  const entries = fs.readdirSync(repoPath);
  if (entries.length === 0) return;

  const looksLikeDemoRepo =
    entries.includes('.git') || entries.includes(META_FILENAME) || entries.includes('src');
  if (!looksLikeDemoRepo && !force) {
    throw new Error(
      `refusing to seed into non-empty directory ${repoPath}: it does not look like a demo repo. Pass force:true to overwrite.`,
    );
  }
  // Never destroy work the agent produced unless destruction was asked for
  // explicitly. firefighter/* branches carry reverts and fixes that open pull
  // requests still reference.
  if (!force && hasAgentBranches(repoPath)) {
    throw new Error(
      `refusing to wipe ${repoPath}: it contains firefighter/* branches from a previous incident run. ` +
        `Pass force:true (or run "npm run seed -- --force") if you really want to rebuild it.`,
    );
  }
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });
}

/** True when the repository holds branches created by a previous incident run. */
function hasAgentBranches(repoPath: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/firefighter/'],
      { cwd: repoPath, encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Has the demo repo already been fully seeded at this path?
 *
 * @param repoPath - Repository root.
 */
export function isSeeded(repoPath: string): boolean {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return false;
  const meta = readMeta(repoPath);
  if (meta === null) return false;
  // Must be a property of the SEEDED history, not of the list length: the agent
  // appends its own pull requests (#151, #152, ...) to this same array, so an
  // equality check on length flips to false the moment an incident is handled —
  // and every `if (!isSeeded()) seedDemoRepo()` call site would then wipe the
  // repository, destroying the branches and PR records that run still refers to.
  const present = new Set(meta.pullRequests.map((pr) => pr.number));
  return (
    DEMO_COMMITS.every((spec) => present.has(spec.prNumber)) ||
    SENTRY_DEMO_COMMITS.every((spec) => present.has(spec.prNumber))
  );
}

/**
 * Seed the demo repository.
 *
 * Idempotent by default: an already-seeded repo is returned untouched. With
 * force:true the directory is deleted and the history replayed from scratch.
 *
 * @param opts - Target path and rebuild flag.
 * @returns The repo path, its metadata sidecar, HEAD sha and per-PR shas.
 */
export async function seedDemoRepo(opts: SeedOptions = {}): Promise<SeedResult> {
  const repoPath = path.resolve(opts.repoPath ?? config.demoRepoPath);
  const force = opts.force === true;

  if (!force && isSeeded(repoPath)) {
    const meta = readMeta(repoPath)!;
    const headSha = git(repoPath, ['rev-parse', 'HEAD']);
    log.info(`demo repo already seeded at ${repoPath} (reusing, head ${headSha.slice(0, 7)})`);
    if ((opts.variant ?? 'js') === 'sentry') verifySentryAnchors(repoPath);
    return {
      repoPath,
      meta,
      headSha,
      commits: meta.pullRequests.map((pr) => ({ prNumber: pr.number, sha: pr.mergeCommitSha })),
    };
  }

  prepareTargetDir(repoPath, force);

  git(repoPath, ['init', '-b', DEFAULT_BRANCH]);
  git(repoPath, ['config', '--local', 'user.name', COMMITTER_NAME]);
  git(repoPath, ['config', '--local', 'user.email', COMMITTER_EMAIL]);
  git(repoPath, ['config', '--local', 'commit.gpgsign', 'false']);
  git(repoPath, ['config', '--local', 'tag.gpgSign', 'false']);
  git(repoPath, ['config', '--local', 'core.autocrlf', 'false']);

  const pullRequests: DemoPrMeta[] = [];
  const deployments: DemoDeployMeta[] = [];
  const commits: { prNumber: number; sha: string }[] = [];

  for (const spec of commitsFor(opts.variant ?? 'js')) {
    const sha = applyCommit(repoPath, spec);
    commits.push({ prNumber: spec.prNumber, sha });

    const mergedAt = isoOf(spec.date);
    pullRequests.push({
      number: spec.prNumber,
      title: spec.title,
      body: spec.body,
      author: spec.author,
      createdAt: shiftIso(spec.date, -PR_OPEN_LEAD_MS),
      mergedAt,
      mergeCommitSha: sha,
      baseRef: DEFAULT_BRANCH,
      headRef: headRefFor(spec),
      labels: [...spec.labels],
    });

    if (spec.deployedAt) {
      const deployedAt = isoOf(spec.deployedAt);
      deployments.push({
        id: `dep_${shortHash(`${DEMO_OWNER}/${DEMO_NAME}|${spec.prNumber}|${sha}|${deployedAt}`, 12)}`,
        sha,
        prNumber: spec.prNumber,
        environment: 'production',
        deployedAt,
        status: 'success',
      });
    }

    log.debug(`replayed #${spec.prNumber} ${spec.title} -> ${sha.slice(0, 7)}`);
  }

  const headSha = git(repoPath, ['rev-parse', 'HEAD']);

  const meta: DemoRepoMeta = {
    owner: DEMO_OWNER,
    name: DEMO_NAME,
    defaultBranch: DEFAULT_BRANCH,
    pullRequests,
    deployments,
    nextPrNumber: NEXT_PR_NUMBER,
    seededAt: nowIso(),
  };
  writeMeta(repoPath, meta);

  log.info(
    `seeded ${DEMO_OWNER}/${DEMO_NAME} at ${repoPath}: ${commits.length} commits, head ${headSha.slice(0, 7)}`,
  );

  return { repoPath, meta, headSha, commits };
}
