/**
 * GitHub adapter.
 *
 * One interface, three implementations:
 *   - {@link LocalGitHubClient}  provider 'mock'   — real git operations against the
 *     seeded demo repository plus a JSON metadata sidecar that stands in for the
 *     GitHub API (pull requests, deployments, PR numbering).
 *   - {@link GhCliCLient}        provider 'gh-cli' — subprocess calls to the
 *     authenticated `gh` CLI.
 *   - {@link ApiGitHubClient}    provider 'api'    — global fetch against
 *     api.github.com with a bearer token.
 *
 * Safety: there is deliberately NO merge, close, deploy or force-push method on
 * the interface or on any implementation. Firefighter opens pull requests and
 * stops; a human merges. Every git invocation is screened by
 * `assertSafeGitCommand` (inside src/tools/git.ts) and every mutating HTTP call
 * by `assertSafeHttp`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, config as globalConfig, effectiveProviders } from '../config.ts';
import { readMeta, writeMeta } from '../demo/meta.ts';
import {
  ChangedFile,
  CodeMatch,
  CommitInfo,
  Deployment,
  FilePatch,
  FileStatus,
  PrKind,
  PullRequestInfo,
  PullRequestRef,
  RepoInfo,
  RevertPrep,
} from '../types.ts';
import { nowIso } from '../util/clock.ts';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';
import { git, gitOk, gitOut } from './git.ts';
import { assertSafeAction, assertSafeHttp } from './guard.ts';

const log = logger('tools/github');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Everything needed to open a pull request. Never carries a merge instruction. */
export interface CreatePrInput {
  title: string;
  body: string;
  head: string;
  base: string;
  kind: PrKind;
  labels: string[];
  draft?: boolean;
}

/**
 * The only surface the agent has on a code host. Read methods gather evidence;
 * write methods are limited to branches, commits and opening pull requests.
 */
export interface GitHubClient {
  readonly provider: string;
  getRepoInfo(): Promise<RepoInfo>;
  getRecentCommits(limit?: number): Promise<CommitInfo[]>;
  getRecentPullRequests(limit?: number): Promise<PullRequestInfo[]>;
  getPullRequest(n: number): Promise<PullRequestInfo | null>;
  inspectDiff(ref: string | number): Promise<ChangedFile[]>;
  getDeployments(limit?: number): Promise<Deployment[]>;
  searchCode(query: string): Promise<CodeMatch[]>;
  readFile(path: string, ref?: string): Promise<string | null>;
  createBranch(name: string, fromRef: string): Promise<{ branch: string; sha: string; created: boolean }>;
  generateRevert(prNumber: number, branch: string): Promise<RevertPrep>;
  applyPatch(branch: string, patches: FilePatch[], message: string): Promise<{ sha: string; files: string[] }>;
  createPullRequest(input: CreatePrInput): Promise<PullRequestRef>;
}

// ---------------------------------------------------------------------------
// Shared diff helpers
// ---------------------------------------------------------------------------

/** Branches (and therefore pull requests) that Firefighter itself created. */
const FIREFIGHTER_BRANCH_PREFIX = 'firefighter/';

const BOT_NAME = 'Firefighter Bot';
const BOT_EMAIL = 'firefighter@users.noreply.github.com';

/**
 * Environment that makes a git commit fully deterministic: fixed identity and a
 * timestamp from the injectable clock, so a frozen clock yields a stable sha.
 *
 * @returns environment overrides for `git commit`.
 */
function commitEnv(): Record<string, string> {
  const ts = nowIso().replace(/\.\d{3}Z$/, 'Z');
  return {
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
    GIT_AUTHOR_DATE: ts,
    GIT_COMMITTER_DATE: ts,
    // Never let a developer's global gpgsign setting break an automated commit.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

/**
 * Extract the added lines of a unified diff: '+' lines with the marker
 * stripped, excluding the '+++' file header. This is what the analyzer greps
 * for symbols from the stack trace, so it must contain source text only.
 *
 * @param patch unified diff text for a single file.
 * @returns added source lines, in order.
 */
export function addedLinesOf(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) out.push(line.slice(1));
  }
  return out;
}

/**
 * Split a multi-file unified diff into per-path patch text.
 *
 * @param patchText output of `git show`/`git diff` with patches enabled.
 * @returns map of repository-relative path to that file's diff hunk text.
 */
function splitPatchByFile(patchText: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patchText.trim()) return byPath;
  const lines = patchText.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current !== null) byPath.set(current, buf.join('\n'));
    current = null;
    buf = [];
  };
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      const bPath = header[2];
      current = bPath === '/dev/null' ? header[1] : bPath;
      buf = [line];
      continue;
    }
    if (current === null) continue;
    const plusHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusHeader && buf.length < 8) current = plusHeader[1];
    buf.push(line);
  }
  flush();
  return byPath;
}

/**
 * Normalise a git/GitHub status letter or word into the domain FileStatus.
 *
 * @param raw 'A' | 'M' | 'D' | 'added' | 'removed' | ...
 * @returns the domain status, defaulting to 'modified'.
 */
function normaliseStatus(raw: string): FileStatus {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('a') || s === 'copied' || s.startsWith('c')) return 'added';
  if (s.startsWith('d') || s === 'removed') return 'removed';
  return 'modified';
}

/** Parse a trailing "(#123)" from a commit subject. */
function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject.split('\n')[0] ?? '');
  return m ? Number(m[1]) : null;
}

/** Split "owner/name" into its parts, tolerating a full URL. */
function splitSlug(slug: string): { owner: string; name: string } {
  const clean = slug.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [owner = '', name = ''] = clean.split('/');
  return { owner, name };
}

// ---------------------------------------------------------------------------
// LocalGitHubClient — real git + seeded metadata
// ---------------------------------------------------------------------------

type LocalMeta = NonNullable<ReturnType<typeof readMeta>>;
type LocalPrMeta = LocalMeta['pullRequests'][number];

/** Selector-agnostic description of a diff to collect (`git show` vs `git diff`). */
interface DiffSpec {
  /** argv before the selector flag. */
  prefix: string[];
  /** argv after the selector flag (revisions / ranges). */
  revs: string[];
}

/**
 * The default adapter and the one the demo runs on.
 *
 * Backed by the real git repository at `config.demoRepoPath`: every diff, blob
 * and revert is produced by git itself. The GitHub-side facts that git cannot
 * know (PR numbers, bodies, deployments) come from the seeded metadata file.
 */
export class LocalGitHubClient implements GitHubClient {
  readonly provider = 'mock';
  private readonly repoPath: string;
  private readonly cfg: Config;

  /** @param cfg resolved configuration; `demoRepoPath` selects the repository. */
  constructor(cfg: Config) {
    this.cfg = cfg;
    this.repoPath = cfg.demoRepoPath;
  }

  // -- infrastructure -------------------------------------------------------

  private get cwd(): { cwd: string } {
    return { cwd: this.repoPath };
  }

  private meta(): LocalMeta | null {
    try {
      return readMeta(this.repoPath);
    } catch {
      return null;
    }
  }

  private requireMeta(): LocalMeta {
    const m = this.meta();
    if (!m) {
      throw new Error(
        `Demo repository metadata not found at ${this.repoPath}. Run the seeder first (npm run seed).`,
      );
    }
    return m;
  }

  private defaultBranch(): string {
    return this.meta()?.defaultBranch || this.cfg.github.baseBranch || 'main';
  }

  /**
   * Refuse, centrally and audibly, to write to a protected branch. Every write
   * path goes through here before it touches a ref.
   */
  protected assertWritableBranch(branch: string): void {
    if (!branch || branch.trim() === '') throw new Error('branch name is required');
    assertSafeAction('commit_to_branch', branch, null);
  }

  private revParse(ref: string): string {
    return gitOut(['rev-parse', ref], this.cwd);
  }

  private isMerge(sha: string): boolean {
    const line = gitOut(['rev-list', '--parents', '-n', '1', sha], this.cwd);
    return line.split(/\s+/).filter(Boolean).length > 2;
  }

  /** Collect ChangedFile[] for an arbitrary diff selector, in git's own order. */
  private collectFiles(spec: DiffSpec): ChangedFile[] {
    const run = (selector: string): string =>
      gitOut([...spec.prefix, selector, ...spec.revs], this.cwd);

    const numstat = run('--numstat');
    if (!numstat.trim()) return [];
    const nameStatus = run('--name-status');
    const patches = splitPatchByFile(run('--patch'));

    const statusByPath = new Map<string, FileStatus>();
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const p = parts[parts.length - 1];
      statusByPath.set(p, normaliseStatus(parts[0]));
    }

    const files: ChangedFile[] = [];
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [addRaw, delRaw] = parts;
      const p = parts[parts.length - 1];
      const patch = patches.get(p) ?? '';
      files.push({
        path: p,
        status: statusByPath.get(p) ?? 'modified',
        additions: addRaw === '-' ? 0 : Number(addRaw) || 0,
        deletions: delRaw === '-' ? 0 : Number(delRaw) || 0,
        patch,
        addedLines: addedLinesOf(patch),
      });
    }
    return files;
  }

  /** ChangedFile[] introduced by one commit (merge commits use first-parent). */
  private filesOfCommit(sha: string): ChangedFile[] {
    const prefix = ['show', '--format=', '--no-renames'];
    if (this.isMerge(sha)) prefix.push('-m', '--first-parent');
    return this.collectFiles({ prefix, revs: [sha] });
  }

  /** ChangedFile[] for `base...head` (what a PR would show). */
  private filesOfRange(base: string, head: string): ChangedFile[] {
    return this.collectFiles({ prefix: ['diff', '--no-renames'], revs: [`${base}...${head}`] });
  }

  private commitExists(ref: string): boolean {
    return !!ref && gitOk(['cat-file', '-e', `${ref}^{commit}`], this.cwd);
  }

  private branchExists(name: string): boolean {
    return gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], this.cwd);
  }

  // -- reads ----------------------------------------------------------------

  /**
   * Repository identity plus the current default-branch head.
   *
   * @returns owner, name, default branch and head sha.
   */
  async getRepoInfo(): Promise<RepoInfo> {
    const m = this.meta();
    const slug = splitSlug(this.cfg.github.repo || 'firefighter-demo/checkout-service');
    const defaultBranch = this.defaultBranch();
    return {
      owner: m?.owner || slug.owner,
      name: m?.name || slug.name,
      defaultBranch,
      headSha: this.revParse(defaultBranch) || this.revParse('HEAD'),
    };
  }

  /**
   * Recent commits on the default branch, newest first, with changed files.
   *
   * @param limit maximum commits to return (default 20).
   * @returns parsed commit records; `prNumber` comes from a trailing "(#123)".
   */
  async getRecentCommits(limit = 20): Promise<CommitInfo[]> {
    const text = gitOut(
      ['log', `-n${Math.max(1, limit)}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%B%x1e'],
      this.cwd,
    );
    const out: CommitInfo[] = [];
    for (const record of text.split('\x1e')) {
      const chunk = record.replace(/^\n+/, '');
      if (!chunk.trim()) continue;
      const [sha = '', author = '', authoredAt = '', message = ''] = chunk.split('\x1f');
      if (!sha) continue;
      const msg = message.trim();
      out.push({
        sha,
        shortSha: sha.slice(0, 7),
        message: msg,
        author,
        authoredAt,
        files: this.filesOfCommit(sha).map((f) => f.path),
        prNumber: prNumberFromSubject(msg),
      });
    }
    return out;
  }

  /** Build a PullRequestInfo from seeded metadata plus a real git diff. */
  private toPullRequestInfo(pr: LocalPrMeta): PullRequestInfo {
    const owner = this.meta()?.owner ?? splitSlug(this.cfg.github.repo).owner;
    const name = this.meta()?.name ?? splitSlug(this.cfg.github.repo).name;
    const mergeSha = pr.mergeCommitSha || '';
    const mergedAt = pr.mergedAt || null;
    const merged = !!mergedAt && this.commitExists(mergeSha);

    let files: ChangedFile[] = [];
    let headSha = mergeSha;
    if (merged) {
      files = this.filesOfCommit(mergeSha);
    } else if (this.branchExists(pr.headRef)) {
      headSha = this.revParse(pr.headRef);
      const base = this.branchExists(pr.baseRef) ? pr.baseRef : this.defaultBranch();
      files = this.filesOfRange(base, pr.headRef);
    }

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      state: merged ? 'merged' : 'open',
      createdAt: pr.createdAt,
      mergedAt,
      mergeCommitSha: merged ? mergeSha : null,
      headSha,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      url: `https://github.com/${owner}/${name}/pull/${pr.number}`,
      files,
      labels: pr.labels ?? [],
    };
  }

  /**
   * Pull requests newest first (by merge time, falling back to creation time).
   *
   * @param limit maximum pull requests to return (default 10).
   * @returns pull requests with real, git-computed diffs.
   */
  async getRecentPullRequests(limit = 10): Promise<PullRequestInfo[]> {
    const m = this.meta();
    if (!m) return [];
    const sorted = [...m.pullRequests].sort((a, b) => {
      const at = a.mergedAt ?? a.createdAt;
      const bt = b.mergedAt ?? b.createdAt;
      if (at === bt) return b.number - a.number;
      return at < bt ? 1 : -1;
    });
    return sorted.slice(0, Math.max(1, limit)).map((p) => this.toPullRequestInfo(p));
  }

  /**
   * One pull request by number.
   *
   * @param n pull request number.
   * @returns the pull request, or null when unknown.
   */
  async getPullRequest(n: number): Promise<PullRequestInfo | null> {
    const m = this.meta();
    const pr = m?.pullRequests.find((p) => p.number === n);
    return pr ? this.toPullRequestInfo(pr) : null;
  }

  /**
   * Diff for a pull request number, or for any git ref/sha.
   *
   * @param ref PR number (or its string form), otherwise a sha/ref.
   * @returns changed files with patches and added lines.
   */
  async inspectDiff(ref: string | number): Promise<ChangedFile[]> {
    const asNumber =
      typeof ref === 'number' ? ref : /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
    if (asNumber !== null) {
      const pr = await this.getPullRequest(asNumber);
      if (pr) return pr.files;
      if (typeof ref === 'number') return [];
    }
    const target = String(ref);
    if (!this.commitExists(target)) return [];
    return this.filesOfCommit(this.revParse(target));
  }

  /**
   * Production deployments, newest first.
   *
   * @param limit maximum deployments to return (default 10).
   * @returns deployment records from the seeded metadata.
   */
  async getDeployments(limit = 10): Promise<Deployment[]> {
    const m = this.meta();
    if (!m) return [];
    return [...m.deployments]
      .sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : a.deployedAt > b.deployedAt ? -1 : 0))
      .slice(0, Math.max(1, limit))
      .map((d) => ({
        id: d.id,
        sha: d.sha,
        prNumber: d.prNumber ?? null,
        environment: d.environment,
        deployedAt: d.deployedAt,
        status: d.status,
      }));
  }

  /**
   * Case-insensitive substring search over tracked files in the working tree.
   *
   * @param query literal substring to look for.
   * @returns matches with 1-based line numbers, capped at 200.
   */
  async searchCode(query: string): Promise<CodeMatch[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const tracked = gitOut(['ls-files'], this.cwd)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => !p.startsWith('.git/') && !p.split('/').includes('node_modules'));

    const matches: CodeMatch[] = [];
    for (const rel of tracked) {
      if (matches.length >= 200) break;
      const abs = path.join(this.repoPath, rel);
      let text: string;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: rel, line: i + 1, text: lines[i].trim() });
          if (matches.length >= 200) break;
        }
      }
    }
    return matches;
  }

  /**
   * Read a file's contents at a ref.
   *
   * @param filePath repository-relative path.
   * @param ref      git ref, default 'HEAD'.
   * @returns file contents, or null when it does not exist at that ref.
   */
  async readFile(filePath: string, ref = 'HEAD'): Promise<string | null> {
    const rel = filePath.replace(/^\.\//, '');
    const r = git(['show', `${ref}:${rel}`], { ...this.cwd, allowFail: true });
    return r.code === 0 ? r.stdout : null;
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Create a branch without checking it out. Idempotent.
   *
   * @param name    branch to create (must not be protected).
   * @param fromRef ref to cut from.
   * @returns the branch, its head sha, and whether this call created it.
   */
  async createBranch(
    name: string,
    fromRef: string,
  ): Promise<{ branch: string; sha: string; created: boolean }> {
    this.assertWritableBranch(name);
    if (this.branchExists(name)) {
      return { branch: name, sha: this.revParse(name), created: false };
    }
    const from = this.commitExists(fromRef) ? fromRef : this.defaultBranch();
    git(['branch', name, from], this.cwd);
    return { branch: name, sha: this.revParse(name), created: true };
  }

  /** Run `fn` inside a throwaway worktree checked out at `branch`. */
  private withWorktree<T>(branch: string, key: string, fn: (dir: string) => T): T {
    const dir = path.join(
      os.tmpdir(),
      `firefighter-wt-${shortHash(`${this.repoPath}:${branch}:${key}`, 12)}`,
    );
    // A worktree left behind by a crashed run must not block this one.
    git(['worktree', 'remove', '--force', dir], { ...this.cwd, allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], { ...this.cwd, allowFail: true });
    git(['worktree', 'add', '--quiet', dir, branch], this.cwd);
    try {
      return fn(dir);
    } finally {
      git(['worktree', 'remove', '--force', dir], { ...this.cwd, allowFail: true });
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      git(['worktree', 'prune'], { ...this.cwd, allowFail: true });
    }
  }

  /** Find an existing revert of `sha` among commits unique to `branch`. */
  private findExistingRevert(branch: string, base: string, sha: string): string | null {
    const raw = gitOut(['log', `${base}..${branch}`, '--pretty=format:%H%x1f%B%x1e'], this.cwd);
    for (const record of raw.split('\x1e')) {
      const chunk = record.replace(/^\n+/, '');
      if (!chunk.trim()) continue;
      const [commitSha = '', body = ''] = chunk.split('\x1f');
      if (body.includes(`This reverts commit ${sha}`)) return commitSha;
    }
    return null;
  }

  private revertPrepFor(
    branch: string,
    baseSha: string,
    revertedSha: string,
    prNumber: number,
  ): RevertPrep {
    return {
      branch,
      baseSha,
      revertedSha,
      targetPrNumber: prNumber,
      filesRestored: gitOut(['show', '--name-only', '--format=', revertedSha], this.cwd)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      diffStat: gitOut(['show', '--shortstat', '--format=', revertedSha], this.cwd).trim(),
    };
  }

  /**
   * Produce a real `git revert` of a merged pull request on a dedicated branch.
   *
   * The revert happens inside a temporary worktree, so the repository's main
   * working tree is never checked out, dirtied or detached. Idempotent: if the
   * branch already contains a revert of that commit, the existing state is
   * returned without creating a second commit.
   *
   * @param prNumber pull request to revert.
   * @param branch   branch to place the revert commit on (created if missing).
   * @returns branch, base sha, the new revert commit, files restored and diffstat.
   */
  async generateRevert(prNumber: number, branch: string): Promise<RevertPrep> {
    this.assertWritableBranch(branch);
    const meta = this.requireMeta();
    const pr = meta.pullRequests.find((p) => p.number === prNumber);
    if (!pr) throw new Error(`pull request #${prNumber} not found in demo metadata`);
    if (!pr.mergeCommitSha || !this.commitExists(pr.mergeCommitSha)) {
      throw new Error(`pull request #${prNumber} has no merge commit to revert`);
    }
    const sha = this.revParse(pr.mergeCommitSha);
    const base = this.defaultBranch();
    const baseSha = this.revParse(base);

    await this.createBranch(branch, base);

    const already = this.findExistingRevert(branch, base, sha);
    if (already) {
      log.debug(`revert of ${sha.slice(0, 7)} already present on ${branch} as ${already.slice(0, 7)}`);
      return this.revertPrepFor(branch, baseSha, already, prNumber);
    }

    const subject = (pr.title || gitOut(['log', '-1', '--pretty=%s', sha], this.cwd)).trim();
    const message =
      `Revert "${subject}" (#${prNumber})\n\n` +
      `This reverts commit ${sha}.\n\n` +
      `Automated mitigation prepared by Firefighter. Restores the last known-good\n` +
      `behaviour of the affected code path. Requires human review before merge.\n`;

    const newSha = this.withWorktree(branch, `revert-${sha}`, (dir) => {
      const wt = { cwd: dir, env: commitEnv() };
      const revert = git(['revert', '--no-commit', sha], { ...wt, allowFail: true });
      if (revert.code !== 0) {
        git(['revert', '--quit'], { cwd: dir, allowFail: true });
        git(['reset', '--hard', 'HEAD'], { cwd: dir, allowFail: true });
        throw new Error(
          `git revert of ${sha.slice(0, 7)} conflicted: ${revert.stderr.trim() || revert.stdout.trim()}`,
        );
      }
      if (gitOut(['status', '--porcelain'], { cwd: dir }) === '') {
        // Changes were already undone by something else on this branch.
        git(['revert', '--quit'], { cwd: dir, allowFail: true });
        return gitOut(['rev-parse', 'HEAD'], { cwd: dir });
      }
      git(['commit', '-m', message], wt);
      return gitOut(['rev-parse', 'HEAD'], { cwd: dir });
    });

    log.info(`prepared revert of #${prNumber} on ${branch} (${newSha.slice(0, 7)})`);
    return this.revertPrepFor(branch, baseSha, newSha, prNumber);
  }

  /**
   * Write file contents onto a branch and commit them, via a temporary worktree.
   *
   * Idempotent: when the branch tip already holds identical contents for every
   * patch, no empty commit is created and the existing tip is returned.
   *
   * @param branch  target branch (created from the default branch if missing).
   * @param patches files to write.
   * @param message commit message.
   * @returns the resulting commit sha and the paths written.
   */
  async applyPatch(
    branch: string,
    patches: FilePatch[],
    message: string,
  ): Promise<{ sha: string; files: string[] }> {
    this.assertWritableBranch(branch);
    if (patches.length === 0) {
      const sha = this.branchExists(branch) ? this.revParse(branch) : this.revParse(this.defaultBranch());
      return { sha, files: [] };
    }
    await this.createBranch(branch, this.defaultBranch());

    const paths = patches.map((p) => p.path.replace(/^\.\//, ''));
    const unchanged = patches.every((p) => {
      const current = git(['show', `${branch}:${p.path.replace(/^\.\//, '')}`], {
        ...this.cwd,
        allowFail: true,
      });
      return current.code === 0 && current.stdout === p.contents;
    });
    if (unchanged) {
      log.debug(`applyPatch: ${branch} already matches ${paths.length} patch(es), skipping commit`);
      return { sha: this.revParse(branch), files: paths };
    }

    const sha = this.withWorktree(branch, `patch-${shortHash(paths.join('|'), 8)}`, (dir) => {
      for (const p of patches) {
        const rel = p.path.replace(/^\.\//, '');
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, p.contents, 'utf8');
      }
      git(['add', '--', ...paths], { cwd: dir });
      if (gitOut(['status', '--porcelain'], { cwd: dir }) === '') {
        return gitOut(['rev-parse', 'HEAD'], { cwd: dir });
      }
      git(['commit', '-m', message], { cwd: dir, env: commitEnv() });
      return gitOut(['rev-parse', 'HEAD'], { cwd: dir });
    });

    log.info(`applied ${paths.length} patch(es) to ${branch} (${sha.slice(0, 7)})`);
    return { sha, files: paths };
  }

  /**
   * Open a pull request. Numbers are allocated from the seeded metadata and
   * persisted, so they survive a process restart. Idempotent on the head branch.
   *
   * @param input title/body/head/base/labels for the PR.
   * @returns a reference to the PR. `merged` is always false.
   */
  async createPullRequest(input: CreatePrInput): Promise<PullRequestRef> {
    this.assertWritableBranch(input.head);
    const meta = this.requireMeta();
    const existing = meta.pullRequests.find((p) => p.headRef === input.head);
    if (existing) {
      log.debug(`pull request for head ${input.head} already exists as #${existing.number}`);
      return {
        number: existing.number,
        url: `https://github.com/${meta.owner}/${meta.name}/pull/${existing.number}`,
        branch: existing.headRef,
        baseBranch: existing.baseRef,
        title: existing.title,
        provider: this.provider,
        kind: input.kind,
        merged: false,
      };
    }

    const number = meta.nextPrNumber;
    // An open PR has no merge: empty strings keep the sidecar's schema honest
    // and read back as "not merged" everywhere below.
    const entry: LocalPrMeta = {
      number,
      title: input.title,
      body: input.body,
      author: 'firefighter[bot]',
      createdAt: nowIso(),
      mergedAt: '',
      mergeCommitSha: '',
      baseRef: input.base,
      headRef: input.head,
      labels: input.labels,
    };
    meta.pullRequests.push(entry);
    meta.nextPrNumber = number + 1;
    writeMeta(this.repoPath, meta);

    log.info(`opened pull request #${number} (${input.kind}) from ${input.head} -> ${input.base}`);
    return {
      number,
      url: `https://github.com/${meta.owner}/${meta.name}/pull/${number}`,
      branch: input.head,
      baseBranch: input.base,
      title: input.title,
      provider: this.provider,
      kind: input.kind,
      merged: false,
    };
  }
}

// ---------------------------------------------------------------------------
// REST implementations (gh-cli and api share one code path, two transports)
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RestResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

interface GhUser {
  login?: string;
}
interface GhRepo {
  owner?: GhUser;
  name?: string;
  default_branch?: string;
}
interface GhCommitFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}
interface GhCommit {
  sha: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: GhUser;
  files?: GhCommitFile[];
  parents?: { sha: string }[];
}
interface GhPull {
  number: number;
  title?: string;
  body?: string | null;
  user?: GhUser;
  state?: string;
  created_at?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  html_url?: string;
  labels?: { name: string }[];
}
interface GhDeployment {
  id: number;
  sha: string;
  environment?: string;
  created_at?: string;
  description?: string | null;
  payload?: Record<string, unknown> | string | null;
  ref?: string;
}
interface GhDeploymentStatus {
  state?: string;
}
interface GhContents {
  content?: string;
  encoding?: string;
  sha?: string;
  type?: string;
}
interface GhRef {
  object?: { sha?: string };
}

const API_ROOT = 'https://api.github.com';

/**
 * Shared REST implementation of {@link GitHubClient}. Subclasses provide only
 * the transport; every GitHub semantic lives here so `gh-cli` and `api` cannot
 * drift apart.
 */
abstract class RestGitHubClient implements GitHubClient {
  abstract readonly provider: string;
  protected readonly cfg: Config;
  protected readonly slug: string;

  protected constructor(cfg: Config) {
    this.cfg = cfg;
    this.slug = cfg.github.repo;
    if (!this.slug.includes('/')) {
      throw new Error('GITHUB_REPO must be set to "owner/name" for the gh-cli/api providers');
    }
  }

  /** Perform one API call. Implementations must screen mutating calls. */
  protected abstract request<T>(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
  ): Promise<RestResponse<T>>;

  /** Screen a mutating call through the central guard before it is sent. */
  protected screen(method: HttpMethod, apiPath: string): void {
    if (method === 'GET') return;
    assertSafeHttp(method, `${API_ROOT}/${apiPath.replace(/^\//, '')}`, null);
  }

  protected async get<T>(apiPath: string): Promise<T | null> {
    return (await this.request<T>('GET', apiPath)).data;
  }

  private get repoPath(): string {
    return `repos/${this.slug}`;
  }

  private mapFiles(files: GhCommitFile[] | undefined): ChangedFile[] {
    return (files ?? []).map((f) => {
      const patch = f.patch ?? '';
      return {
        path: f.filename,
        status: normaliseStatus(f.status ?? 'modified'),
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch,
        addedLines: addedLinesOf(patch),
      };
    });
  }

  private mapPull(pr: GhPull, files: ChangedFile[]): PullRequestInfo {
    const { owner, name } = splitSlug(this.slug);
    return {
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      author: pr.user?.login ?? 'unknown',
      state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      createdAt: pr.created_at ?? '',
      mergedAt: pr.merged_at ?? null,
      mergeCommitSha: pr.merged_at ? pr.merge_commit_sha ?? null : null,
      headSha: pr.head?.sha ?? '',
      baseRef: pr.base?.ref ?? this.cfg.github.baseBranch,
      headRef: pr.head?.ref ?? '',
      url: pr.html_url ?? `https://github.com/${owner}/${name}/pull/${pr.number}`,
      files,
      labels: (pr.labels ?? []).map((l) => l.name),
    };
  }

  /** @returns owner, name, default branch and default-branch head sha. */
  async getRepoInfo(): Promise<RepoInfo> {
    const repo = await this.get<GhRepo>(this.repoPath);
    const { owner, name } = splitSlug(this.slug);
    const defaultBranch = repo?.default_branch ?? this.cfg.github.baseBranch ?? 'main';
    const head = await this.get<GhCommit>(`${this.repoPath}/commits/${defaultBranch}`);
    return {
      owner: repo?.owner?.login ?? owner,
      name: repo?.name ?? name,
      defaultBranch,
      headSha: head?.sha ?? '',
    };
  }

  /**
   * @param limit maximum commits (default 20).
   * @returns default-branch commits, newest first, with changed file paths.
   */
  async getRecentCommits(limit = 20): Promise<CommitInfo[]> {
    const list = (await this.get<GhCommit[]>(`${this.repoPath}/commits?per_page=${Math.max(1, limit)}`)) ?? [];
    const out: CommitInfo[] = [];
    for (const c of list) {
      const detail = await this.get<GhCommit>(`${this.repoPath}/commits/${c.sha}`);
      const message = (detail?.commit?.message ?? c.commit?.message ?? '').trim();
      out.push({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message,
        author: c.author?.login ?? c.commit?.author?.name ?? 'unknown',
        authoredAt: c.commit?.author?.date ?? '',
        files: (detail?.files ?? []).map((f) => f.filename),
        prNumber: prNumberFromSubject(message),
      });
    }
    return out;
  }

  /**
   * @param limit maximum pull requests (default 10).
   * @returns recently updated pull requests with their file diffs.
   */
  async getRecentPullRequests(limit = 10): Promise<PullRequestInfo[]> {
    const list =
      (await this.get<GhPull[]>(
        `${this.repoPath}/pulls?state=all&sort=updated&direction=desc&per_page=${Math.max(1, limit)}`,
      )) ?? [];
    const out: PullRequestInfo[] = [];
    for (const pr of list) {
      // Only a change that actually shipped can have caused a production
      // incident, and Firefighter's own mitigation/fix pull requests are
      // responses to the incident, never its cause. Including either would let
      // the agent investigate its own output.
      if (pr.merged_at === null || pr.merged_at === undefined) continue;
      if ((pr.head?.ref ?? '').startsWith(FIREFIGHTER_BRANCH_PREFIX)) continue;
      const files = await this.get<GhCommitFile[]>(`${this.repoPath}/pulls/${pr.number}/files?per_page=100`);
      out.push(this.mapPull(pr, this.mapFiles(files ?? [])));
    }

    // Always union with commit-derived candidates. A repository whose history
    // was pushed directly has no server-side pull requests at all, and one that
    // has some must not lose the rest of its history just because a few exist.
    // GitHub's own squash-merge convention records the number in the commit
    // subject as "(#142)", which is what makes this recoverable.
    const derived = await this.pullRequestsFromCommits(Math.max(limit, 30));
    const byNumber = new Map<number, PullRequestInfo>();
    for (const d of derived) byNumber.set(d.number, d);
    for (const real of out) byNumber.set(real.number, real); // a real PR wins
    return [...byNumber.values()].sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
  }

  /** Recover pull-request-shaped candidates from commit subjects. */
  private async pullRequestsFromCommits(limit: number): Promise<PullRequestInfo[]> {
    const repo = await this.getRepoInfo();
    const commits =
      (await this.get<GhCommit[]>(`${this.repoPath}/commits?per_page=${Math.max(1, limit)}`)) ?? [];
    const out: PullRequestInfo[] = [];
    for (const c of commits) {
      const message = c.commit?.message ?? '';
      const subject = message.split('\n')[0] ?? '';
      const marker = /\(#(\d+)\)\s*$/.exec(subject);
      if (!marker) continue;
      const full = await this.get<GhCommit>(`${this.repoPath}/commits/${c.sha}`);
      const date = c.commit?.author?.date ?? '';
      out.push({
        number: Number(marker[1]),
        title: subject.replace(/\s*\(#\d+\)\s*$/, ''),
        body: message.split('\n').slice(1).join('\n').trim(),
        author: c.author?.login ?? c.commit?.author?.name ?? 'unknown',
        state: 'merged',
        createdAt: date,
        mergedAt: date,
        mergeCommitSha: c.sha,
        headSha: c.sha,
        baseRef: repo.defaultBranch,
        headRef: `commit/${c.sha.slice(0, 7)}`,
        url: `https://github.com/${repo.owner}/${repo.name}/commit/${c.sha}`,
        files: this.mapFiles(full?.files),
        labels: [],
      });
    }
    if (!out.length) {
      log.warn(
        'this repository has no pull requests and no "(#N)" commit-subject markers; ' +
          'the analyzer has no change candidates to rank',
      );
    }
    return out;
  }

  /**
   * Resolve a change by number, whether it exists as a real pull request or was
   * recovered from a commit subject. The analyzer ranks whatever
   * getRecentPullRequests() returned, so anything it can blame must also be
   * resolvable here — otherwise a repo without server-side pull requests could
   * identify a culprit it then refuses to revert.
   */
  protected async resolveChange(n: number): Promise<PullRequestInfo | null> {
    const direct = await this.getPullRequest(n);
    if (direct) return direct;
    const derived = await this.pullRequestsFromCommits(30);
    return derived.find((p) => p.number === n) ?? null;
  }

  /**
   * @param n pull request number.
   * @returns the pull request with its file diffs, or null when not found.
   */
  async getPullRequest(n: number): Promise<PullRequestInfo | null> {
    const pr = await this.get<GhPull>(`${this.repoPath}/pulls/${n}`);
    if (!pr) return null;
    const files = await this.get<GhCommitFile[]>(`${this.repoPath}/pulls/${n}/files?per_page=100`);
    return this.mapPull(pr, this.mapFiles(files ?? []));
  }

  /**
   * @param ref pull request number, or a sha/ref.
   * @returns changed files with patches and added lines.
   */
  async inspectDiff(ref: string | number): Promise<ChangedFile[]> {
    const asNumber =
      typeof ref === 'number' ? ref : /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
    if (asNumber !== null) {
      const files = await this.get<GhCommitFile[]>(`${this.repoPath}/pulls/${asNumber}/files?per_page=100`);
      if (files) return this.mapFiles(files);
      if (typeof ref === 'number') return [];
    }
    const commit = await this.get<GhCommit>(`${this.repoPath}/commits/${String(ref)}`);
    return this.mapFiles(commit?.files);
  }

  /**
   * @param limit maximum deployments (default 10).
   * @returns deployments with their latest status, newest first.
   */
  async getDeployments(limit = 10): Promise<Deployment[]> {
    const list =
      (await this.get<GhDeployment[]>(`${this.repoPath}/deployments?per_page=${Math.max(1, limit)}`)) ?? [];
    const out: Deployment[] = [];
    for (const d of list) {
      const statuses = await this.get<GhDeploymentStatus[]>(
        `${this.repoPath}/deployments/${d.id}/statuses?per_page=1`,
      );
      const state = statuses?.[0]?.state ?? 'success';
      let prNumber: number | null = null;
      const payload = typeof d.payload === 'object' && d.payload ? d.payload : {};
      const raw = (payload as Record<string, unknown>).pr ?? (payload as Record<string, unknown>).pull_request;
      if (typeof raw === 'number') prNumber = raw;
      else if (typeof raw === 'string' && /^\d+$/.test(raw)) prNumber = Number(raw);
      else {
        const m = /#(\d+)/.exec(d.description ?? '');
        if (m) prNumber = Number(m[1]);
      }
      out.push({
        id: String(d.id),
        sha: d.sha,
        prNumber,
        environment: d.environment ?? 'production',
        deployedAt: d.created_at ?? '',
        status: state === 'success' ? 'success' : 'failed',
      });
    }
    if (out.length) return out;
    // No GitHub Deployments recorded. Rather than drop the temporal signal
    // entirely, approximate "when this change reached production" with the
    // commit timestamp. This is explicitly an approximation and is reported as
    // such, but it keeps recency evidence available on repos that deploy
    // outside GitHub's Deployments API.
    return this.deriveDeploysFromCommits(limit);
  }

  /** Read-only: approximate deploy times from commit timestamps when GitHub records none. */
  private async deriveDeploysFromCommits(limit: number): Promise<Deployment[]> {
    const prs = await this.pullRequestsFromCommits(limit);
    if (!prs.length) return [];
    log.warn(
      'no GitHub Deployments found; approximating deploy time with commit time for the temporal signal',
    );
    return prs
      .filter((p) => p.mergedAt)
      .map((p) => ({
        id: `commit:${p.mergeCommitSha ?? p.headSha}`,
        sha: p.mergeCommitSha ?? p.headSha,
        prNumber: p.number,
        environment: 'production (approximated from commit time)',
        deployedAt: p.mergedAt as string,
        status: 'success' as const,
      }));
  }

  /**
   * @param query literal code search query.
   * @returns matching lines, resolved by fetching each hit's file contents.
   */
  async searchCode(query: string): Promise<CodeMatch[]> {
    const q = encodeURIComponent(`${query} repo:${this.slug}`);
    const res = await this.get<{ items?: { path: string }[] }>(`search/code?q=${q}&per_page=10`);
    const needle = query.trim().toLowerCase();
    const matches: CodeMatch[] = [];
    for (const item of res?.items ?? []) {
      const text = await this.readFile(item.path);
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: item.path, line: i + 1, text: lines[i].trim() });
          if (matches.length >= 200) return matches;
        }
      }
    }
    return matches;
  }

  /**
   * @param filePath repository-relative path.
   * @param ref      git ref, default the repository default branch.
   * @returns decoded file contents, or null when absent.
   */
  async readFile(filePath: string, ref?: string): Promise<string | null> {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await this.get<GhContents>(
      `${this.repoPath}/contents/${encodeURI(filePath.replace(/^\.\//, ''))}${suffix}`,
    );
    if (!res?.content) return null;
    return Buffer.from(res.content, (res.encoding as BufferEncoding) ?? 'base64').toString('utf8');
  }

  /** Blob sha of a path at a ref, or null when the path does not exist there. */
  private async blobShaAt(filePath: string, ref: string): Promise<string | null> {
    const res = await this.get<GhContents>(
      `${this.repoPath}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref)}`,
    );
    return res?.sha ?? null;
  }

  private async branchHead(name: string): Promise<string | null> {
    const res = await this.request<GhRef>('GET', `${this.repoPath}/git/ref/heads/${encodeURI(name)}`);
    return res.ok ? res.data?.object?.sha ?? null : null;
  }

  /**
   * Refuse, centrally and audibly, to write to a protected branch. Every write
   * path goes through here before it touches a ref.
   */
  protected assertWritableBranch(branch: string): void {
    if (!branch || branch.trim() === '') throw new Error('branch name is required');
    assertSafeAction('commit_to_branch', branch, null);
  }

  /**
   * Create a branch ref. Idempotent.
   *
   * @param name    branch to create (must not be protected).
   * @param fromRef ref to cut from.
   * @returns the branch, its head sha, and whether this call created it.
   */
  async createBranch(
    name: string,
    fromRef: string,
  ): Promise<{ branch: string; sha: string; created: boolean }> {
    this.assertWritableBranch(name);
    const existing = await this.branchHead(name);
    if (existing) return { branch: name, sha: existing, created: false };
    const from = await this.get<GhCommit>(`${this.repoPath}/commits/${encodeURIComponent(fromRef)}`);
    if (!from?.sha) throw new Error(`cannot resolve ref "${fromRef}"`);
    const created = await this.request<GhRef>('POST', `${this.repoPath}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: from.sha,
    });
    if (!created.ok) throw new Error(`failed to create branch ${name}: ${created.error ?? created.status}`);
    return { branch: name, sha: created.data?.object?.sha ?? from.sha, created: true };
  }

  /**
   * Commit a tree onto a branch via the git data API: build a tree from the
   * base tree, create a commit, then fast-forward the ref (never forced).
   *
   * @returns the new commit sha, or the unchanged head when the tree is identical.
   */
  private async commitTree(
    branch: string,
    entries: { path: string; sha: string | null }[],
    message: string,
  ): Promise<string> {
    const head = await this.branchHead(branch);
    if (!head) throw new Error(`branch ${branch} does not exist`);
    const headCommit = await this.get<{ tree?: { sha?: string } }>(`${this.repoPath}/git/commits/${head}`);
    const baseTree = headCommit?.tree?.sha;
    const tree = await this.request<{ sha?: string }>('POST', `${this.repoPath}/git/trees`, {
      base_tree: baseTree,
      tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    });
    if (!tree.ok || !tree.data?.sha) {
      throw new Error(`failed to create tree on ${branch}: ${tree.error ?? tree.status}`);
    }
    if (tree.data.sha === baseTree) return head;
    const commit = await this.request<{ sha?: string }>('POST', `${this.repoPath}/git/commits`, {
      message,
      tree: tree.data.sha,
      parents: [head],
    });
    if (!commit.ok || !commit.data?.sha) {
      throw new Error(`failed to create commit on ${branch}: ${commit.error ?? commit.status}`);
    }
    const updated = await this.request<GhRef>('PATCH', `${this.repoPath}/git/refs/heads/${encodeURI(branch)}`, {
      sha: commit.data.sha,
      force: false,
    });
    if (!updated.ok) {
      throw new Error(`failed to update ${branch}: ${updated.error ?? updated.status}`);
    }
    return commit.data.sha;
  }

  /**
   * Restore every file a pull request touched to its pre-merge state on a
   * dedicated branch, as one commit. Idempotent: identical blobs produce an
   * identical tree, in which case the existing head is returned unchanged.
   *
   * @param prNumber pull request to revert.
   * @param branch   branch to place the revert on.
   * @returns branch, base sha, revert commit, files restored and diffstat.
   */
  async generateRevert(prNumber: number, branch: string): Promise<RevertPrep> {
    this.assertWritableBranch(branch);
    const pr = await this.resolveChange(prNumber);
    if (!pr) throw new Error(`pull request #${prNumber} not found`);
    const mergeSha = pr.mergeCommitSha ?? pr.headSha;
    if (!mergeSha) throw new Error(`pull request #${prNumber} has no commit to revert`);

    const repo = await this.getRepoInfo();
    const baseSha = repo.headSha;
    await this.createBranch(branch, repo.defaultBranch);

    const mergeCommit = await this.get<GhCommit>(`${this.repoPath}/git/commits/${mergeSha}`);
    const parentSha = mergeCommit?.parents?.[0]?.sha;
    if (!parentSha) throw new Error(`cannot resolve the parent of ${mergeSha}`);

    const entries: { path: string; sha: string | null }[] = [];
    for (const f of pr.files) {
      entries.push({ path: f.path, sha: await this.blobShaAt(f.path, parentSha) });
    }
    const additions = pr.files.reduce((n, f) => n + f.deletions, 0);
    const deletions = pr.files.reduce((n, f) => n + f.additions, 0);
    const message =
      `Revert "${pr.title}" (#${prNumber})\n\n` +
      `This reverts commit ${mergeSha}.\n\n` +
      `Automated mitigation prepared by Firefighter. Requires human review before merge.`;
    const revertedSha = await this.commitTree(branch, entries, message);

    return {
      branch,
      baseSha,
      revertedSha,
      targetPrNumber: prNumber,
      filesRestored: pr.files.map((f) => f.path),
      diffStat: `${pr.files.length} file${pr.files.length === 1 ? '' : 's'} changed, ${additions} insertion(s)(+), ${deletions} deletion(s)(-)`,
    };
  }

  /**
   * Write file contents onto a branch as one commit. Idempotent: unchanged
   * contents yield the same tree and the existing head sha is returned.
   *
   * @param branch  target branch (created from the default branch if missing).
   * @param patches files to write.
   * @param message commit message.
   * @returns the resulting commit sha and the paths written.
   */
  async applyPatch(
    branch: string,
    patches: FilePatch[],
    message: string,
  ): Promise<{ sha: string; files: string[] }> {
    this.assertWritableBranch(branch);
    const repo = await this.getRepoInfo();
    await this.createBranch(branch, repo.defaultBranch);
    if (patches.length === 0) {
      return { sha: (await this.branchHead(branch)) ?? repo.headSha, files: [] };
    }
    const entries: { path: string; sha: string | null }[] = [];
    for (const p of patches) {
      const blob = await this.request<{ sha?: string }>('POST', `${this.repoPath}/git/blobs`, {
        content: Buffer.from(p.contents, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      if (!blob.ok || !blob.data?.sha) {
        throw new Error(`failed to create blob for ${p.path}: ${blob.error ?? blob.status}`);
      }
      entries.push({ path: p.path.replace(/^\.\//, ''), sha: blob.data.sha });
    }
    const sha = await this.commitTree(branch, entries, message);
    return { sha, files: entries.map((e) => e.path) };
  }

  /**
   * Open a pull request. Idempotent on the head branch.
   *
   * @param input title/body/head/base/labels for the PR.
   * @returns a reference to the PR. `merged` is always false.
   */
  async createPullRequest(input: CreatePrInput): Promise<PullRequestRef> {
    this.assertWritableBranch(input.head);
    const { owner } = splitSlug(this.slug);
    const existing = await this.get<GhPull[]>(
      // state=open for the same reason as the gh-cli client: a closed pull
      // request is a human rejection, not a reusable artifact.
      `${this.repoPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`,
    );
    const found = existing?.[0];
    if (found) {
      return {
        number: found.number,
        url: found.html_url ?? `https://github.com/${this.slug}/pull/${found.number}`,
        branch: input.head,
        baseBranch: found.base?.ref ?? input.base,
        title: found.title ?? input.title,
        provider: this.provider,
        kind: input.kind,
        merged: false,
      };
    }
    const created = await this.request<GhPull>('POST', `${this.repoPath}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });
    if (!created.ok || !created.data) {
      throw new Error(`failed to open pull request: ${created.error ?? created.status}`);
    }
    if (input.labels.length > 0) {
      await this.request('POST', `${this.repoPath}/issues/${created.data.number}/labels`, {
        labels: input.labels,
      });
    }
    return {
      number: created.data.number,
      url: created.data.html_url ?? `https://github.com/${this.slug}/pull/${created.data.number}`,
      branch: input.head,
      baseBranch: input.base,
      title: input.title,
      provider: this.provider,
      kind: input.kind,
      merged: false,
    };
  }
}

/**
 * provider 'gh-cli' — every call is a `gh api` subprocess, so it inherits the
 * developer's existing `gh auth login` session and needs no token in .env.
 * Opening a PR goes through `gh pr` so it behaves exactly like a hand-run one.
 */
export class GhCliCLient extends RestGitHubClient {
  readonly provider = 'gh-cli';

  /** @param cfg resolved configuration; `github.repo` selects the repository. */
  constructor(cfg: Config) {
    super(cfg);
  }

  protected async request<T>(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
  ): Promise<RestResponse<T>> {
    this.screen(method, apiPath);
    const args = ['api', apiPath.replace(/^\//, ''), '-H', 'Accept: application/vnd.github+json'];
    if (method !== 'GET') args.push('--method', method);
    if (body !== undefined) args.push('--input', '-');
    try {
      const stdout = execFileSync('gh', args, {
        encoding: 'utf8',
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const text = stdout.trim();
      return { ok: true, status: 200, data: text ? (JSON.parse(text) as T) : null };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? 0) || 500;
      if (status !== 404) log.debug(`gh api ${method} ${apiPath} -> ${status}`);
      return { ok: false, status, data: null, error: (stderr || e.message || '').trim() };
    }
  }

  /**
   * Open a pull request with `gh pr create`, reusing an existing PR for the same
   * head branch when one is already open.
   *
   * @param input title/body/head/base/labels for the PR.
   * @returns a reference to the PR. `merged` is always false.
   */
  /**
   * Make sure every label exists, creating the missing ones. Returns the labels
   * that are safe to attach; a label that cannot be created is dropped rather
   * than failing the pull request, because the PR matters more than its tags.
   */
  private ensureLabels(labels: string[]): string[] {
    if (!labels.length) return [];
    let existing = new Set<string>();
    try {
      const out = execFileSync(
        'gh',
        ['api', `repos/${this.slug}/labels?per_page=100`, '--jq', '.[].name'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      existing = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
    } catch {
      return [];
    }
    const usable: string[] = [];
    for (const label of labels) {
      if (existing.has(label)) {
        usable.push(label);
        continue;
      }
      try {
        execFileSync(
          'gh',
          ['label', 'create', label, '--repo', this.slug, '--color', 'B60205', '--description', 'Created by Firefighter'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        usable.push(label);
      } catch {
        log.warn(`could not create label "${label}" in ${this.slug}; opening the pull request without it`);
      }
    }
    return usable;
  }

  override async createPullRequest(input: CreatePrInput): Promise<PullRequestRef> {
    assertSafeHttp('POST', `${API_ROOT}/repos/${this.slug}/pulls`, null);
    // Only an OPEN pull request may be reused. A closed one represents a human
    // decision — typically "this blame is wrong" — and reporting it back as the
    // freshly-opened mitigation would misstate the state of the incident.
    const listArgs = [
      'pr', 'list', '--repo', this.slug, '--head', input.head, '--state', 'open',
      '--json', 'number,url,title,baseRefName', '--limit', '1',
    ];
    try {
      const out = execFileSync('gh', listArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const rows = out ? (JSON.parse(out) as { number: number; url: string; title: string; baseRefName: string }[]) : [];
      const found = rows[0];
      if (found) {
        return {
          number: found.number,
          url: found.url,
          branch: input.head,
          baseBranch: found.baseRefName || input.base,
          title: found.title || input.title,
          provider: this.provider,
          kind: input.kind,
          merged: false,
        };
      }
    } catch {
      // No PR list available (e.g. fresh repo) — fall through to create.
    }
    const createArgs = [
      'pr', 'create', '--repo', this.slug,
      '--title', input.title, '--body', input.body,
      '--head', input.head, '--base', input.base,
    ];
    if (input.draft) createArgs.push('--draft');
    // `gh pr create` aborts outright if a label does not exist in the repo, so
    // the labels Firefighter relies on are created first (idempotently).
    for (const label of this.ensureLabels(input.labels)) createArgs.push('--label', label);
    const url = execFileSync('gh', createArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    return {
      number,
      url: url.split('\n').pop() ?? url,
      branch: input.head,
      baseBranch: input.base,
      title: input.title,
      provider: this.provider,
      kind: input.kind,
      merged: false,
    };
  }
}

/** Kept for the conventional spelling; identical to {@link GhCliCLient}. */
export { GhCliCLient as GhCliClient };

/**
 * provider 'api' — direct calls to api.github.com with the bearer token from
 * `GITHUB_TOKEN`.
 */
export class ApiGitHubClient extends RestGitHubClient {
  readonly provider = 'api';
  private readonly token: string;

  /** @param cfg resolved configuration; requires `github.token`. */
  constructor(cfg: Config) {
    super(cfg);
    this.token = cfg.github.token;
    if (!this.token) throw new Error('GITHUB_TOKEN is required for the api provider');
  }

  protected async request<T>(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
  ): Promise<RestResponse<T>> {
    const url = `${API_ROOT}/${apiPath.replace(/^\//, '')}`;
    this.screen(method, apiPath);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'firefighter-agent',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as T) : null;
      if (!res.ok) {
        if (res.status !== 404) log.debug(`github ${method} ${apiPath} -> ${res.status}`);
        return { ok: false, status: res.status, data: null, error: text.slice(0, 400) };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: (err as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** True when the `gh` binary is present and usable. */
function ghAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the GitHub implementation for this configuration.
 *
 * Provider selection goes through `effectiveProviders`, so a missing token (or
 * a missing `gh` binary) silently degrades to the local client rather than
 * failing a live incident response.
 *
 * @param cfg configuration to use; defaults to the process-wide config.
 * @returns a ready-to-use client.
 */
export function getGitHubClient(cfg: Config = globalConfig): GitHubClient {
  const providers = effectiveProviders(cfg);
  try {
    if (providers.github === 'gh-cli') {
      if (!ghAvailable()) {
        log.warn('GITHUB_PROVIDER=gh-cli but the gh CLI is not installed -> using local git client');
        return new LocalGitHubClient(cfg);
      }
      return new GhCliCLient(cfg);
    }
    if (providers.github === 'api') return new ApiGitHubClient(cfg);
  } catch (err) {
    log.warn(`falling back to the local git client: ${(err as Error).message}`);
    return new LocalGitHubClient(cfg);
  }
  return new LocalGitHubClient(cfg);
}
