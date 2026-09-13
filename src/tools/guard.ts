/**
 * Safety guard: the module that makes unsafe production actions structurally
 * impossible.
 *
 * Firefighter's whole value proposition is that it can act on production
 * without a human babysitting it. That only holds if a whole class of actions
 * is unreachable rather than merely discouraged. Every mutating tool in the
 * system funnels through one of the `assertSafe*` functions below, and every
 * refusal is written to the `safety_events` audit table before the throw.
 *
 * Design notes:
 *  - Deny rules are declarative (`FORBIDDEN_ACTIONS`) so the eval harness and
 *    the UI can enumerate exactly what the agent may never do.
 *  - `checkAction()` is the pure, side-effect-free twin of `assertSafeAction()`:
 *    it answers "what would happen" without throwing and without auditing.
 *  - Only *blocked* attempts are recorded. The audit table stays meaningful
 *    precisely because an allowed action never writes to it.
 *  - Everything here is synchronous, allocation-light and dependency-free; it
 *    sits on the hot path of every tool call.
 */

import { recordSafetyEvent } from '../db/repo.ts';
import { logger } from '../util/log.ts';

const log = logger('guard');

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown whenever the guard refuses an action. Carries structured fields so
 * callers can surface the refusal without string-parsing the message.
 */
export class UnsafeActionError extends Error {
  readonly action: string;
  readonly target: string | null;
  readonly reason: string;

  /**
   * @param action Logical action that was attempted (e.g. `merge_pull_request`).
   * @param target Thing the action was aimed at (branch, PR, URL) or null.
   * @param reason Human-readable explanation of the refusal.
   */
  constructor(action: string, target: string | null, reason: string) {
    super(`unsafe action blocked: ${action}${target ? ` -> ${target}` : ''} (${reason})`);
    this.name = 'UnsafeActionError';
    this.action = action;
    this.target = target;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Declarative deny list
// ---------------------------------------------------------------------------

/** One category of permanently forbidden action. Any match is a refusal. */
export interface ForbiddenAction {
  id: string;
  matches: RegExp[];
  reason: string;
}

/**
 * Normalise free-form text (an action name, a shell command line) into
 * space-separated lowercase tokens so a single set of `\b`-anchored patterns
 * matches `merge_pull_request`, `merge-pull-request` and `Merge Pull Request`
 * identically. Separators (`_`, `-`, `/`, `:`) all collapse to a space, which
 * is why `rm -rf` becomes `rm rf` and `push --force` becomes `push force`.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The complete set of things Firefighter may never do, in any environment,
 * with any credentials. These are not implemented anywhere in the codebase
 * either — the deny list is the second line of defence, not the first.
 */
export const FORBIDDEN_ACTIONS: readonly ForbiddenAction[] = Object.freeze([
  {
    id: 'merge_pull_request',
    matches: [/\bmerge\b/, /\bmerges\b/, /\bmerging\b/, /\bautomerge\b/, /\bmerged\b/],
    reason: 'Firefighter never merges pull requests; a human reviews and merges.',
  },
  {
    id: 'deploy_or_release',
    matches: [
      /\bdeploy\b/,
      /\bdeploys\b/,
      /\bdeployed\b/,
      /\bdeploying\b/,
      /\bdeployment\b/,
      /\bdeployments\b/,
      /\bredeploy\b/,
      /\brelease\b/,
      /\breleases\b/,
      /\brollout\b/,
      /\broll out\b/,
      /\bship it\b/,
      /\bpromote\b/,
      /\bcutover\b/,
      /\bhotfix deploy\b/,
    ],
    reason: 'Firefighter never deploys, releases or rolls out to any environment.',
  },
  {
    id: 'force_push',
    matches: [/\bforce\b.*\bpush\b/, /\bpush\b.*\bforce\b/, /\bforce with lease\b/, /\bpush f\b/],
    reason: 'Force-pushing can destroy published history; it is never permitted.',
  },
  {
    id: 'delete_ref',
    matches: [
      /\bdelete\b.*\b(branch|branches|tag|tags|ref|refs|remote|repo|repository)\b/,
      /\b(branch|tag|ref|remote)\b.*\bdelete\b/,
      /\bdestroy\b.*\b(branch|tag|repo|repository)\b/,
      /\bprune\b.*\b(remote|refs?)\b/,
    ],
    reason: 'Deleting a branch, tag or remote ref is destructive and irreversible.',
  },
  {
    id: 'rewrite_history',
    matches: [
      /\brewrite\b.{0,12}\bhistory\b/,
      /\bhistory\b.{0,12}\brewrite\b/,
      /\bforce\b.*\brebase\b/,
      /\bfilter branch\b/,
      /\bfilter repo\b/,
      /\bhard reset\b/,
      /\breset hard\b/,
      /\bexpire reflog\b/,
      /\breflog expire\b/,
      /\bamend\b.*\bpush\b/,
    ],
    reason: 'Rewriting published history is never permitted.',
  },
  {
    id: 'push_protected_branch',
    matches: [
      /\bpush\b.*\b(main|master|production|prod)\b/,
      /\b(commit|write|push)\b.*\bdirectly\b.*\b(main|master|production|prod)\b/,
      /\bdisable\b.*\bbranch protection\b/,
      /\bbranch protection\b.*\b(disable|remove|delete)\b/,
    ],
    reason: 'Protected branches are written only through a human-reviewed pull request.',
  },
  {
    id: 'close_incident',
    matches: [
      /\bclose\b.*\b(incident|ticket|issue|page)\b/,
      /\b(incident|ticket|issue|page)\b.*\bclose\b/,
      /\bresolve\b.*\b(incident|alert|page|pager)\b/,
      /\bdeclare\b.*\b(resolved|mitigated|all clear)\b/,
      /\bmark\b.*\bresolved\b/,
      /\ball clear\b/,
    ],
    reason: 'Only a human may declare an incident resolved or close its ticket.',
  },
  {
    id: 'destructive_database',
    matches: [
      /\bdrop (database|table|schema|index|user|role|collection)\b/,
      /\btruncate\b/,
      /\bdelete from\b/,
      /\bdrop if exists\b/,
      /\bflushall\b/,
      /\bflushdb\b/,
      /\bmigrate (down|reset|undo)\b/,
      /\bdb (drop|reset|wipe)\b/,
      /\brestore (database|snapshot)\b/,
    ],
    reason: 'Destructive database commands are never permitted.',
  },
  {
    id: 'destructive_infrastructure',
    matches: [
      /\bterraform (apply|destroy|import|taint|state rm)\b/,
      /\bkubectl (delete|apply|scale|rollout|drain|cordon|patch|replace|edit|exec)\b/,
      /\bhelm (install|upgrade|uninstall|delete|rollback)\b/,
      /\bdocker push\b/,
      /\bsystemctl (stop|restart|disable)\b/,
      /\baws (s3 rm|ecs update service|lambda update|cloudformation (deploy|delete))\b/,
      /\bscale (up|down)\b.*\b(prod|production)\b/,
    ],
    reason: 'Infrastructure mutation commands are never permitted.',
  },
  {
    id: 'publish_artifact',
    matches: [/\b(npm|yarn|pnpm|cargo|gem|twine) publish\b/, /\bpublish package\b/],
    reason: 'Publishing artifacts to a registry is a release action and is never permitted.',
  },
  {
    id: 'destructive_filesystem',
    matches: [
      /\brm rf\b/,
      /\brm fr\b/,
      /\brm r f\b/,
      /\brm f r\b/,
      /\bmkfs\b/,
      /\bdd if\b/,
      /\bshred\b/,
      /\bchmod 777 \b/,
    ],
    reason: 'Recursive/irreversible filesystem destruction is never permitted.',
  },
]);

// ---------------------------------------------------------------------------
// Protected branches
// ---------------------------------------------------------------------------

/** Branches the agent may propose changes to, but never write to directly. */
export const PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  'main',
  'master',
  'production',
  'release/*',
  'prod',
]);

const PROTECTED_PATTERNS: readonly RegExp[] = PROTECTED_BRANCHES.map(
  (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$', 'i'),
);

/**
 * Strip the decorations git puts around a branch name so `refs/heads/main`,
 * `origin/main` and `main` all compare equal. Only well-known remote prefixes
 * are stripped, so `release/2026-09-13` keeps its `release/` namespace.
 */
function canonicalBranch(name: string): string {
  let b = name.trim();
  b = b.replace(/^refs\/heads\//i, '');
  b = b.replace(/^refs\/remotes\/[^/]+\//i, '');
  b = b.replace(/^(origin|upstream)\//i, '');
  b = b.replace(/^refs\/tags\//i, '');
  return b;
}

/**
 * True when a branch name is protected: it may only be changed by a human
 * merging a pull request.
 */
export function isProtectedBranch(name: string): boolean {
  if (!name) return false;
  const b = canonicalBranch(name);
  if (!b) return false;
  return PROTECTED_PATTERNS.some((re) => re.test(b));
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * Action name fragments that imply writing to a branch. Combined with a
 * protected target these are refused; `create_pull_request` deliberately is
 * NOT in this list, because opening a PR *against* main is the whole point.
 */
const BRANCH_WRITE_TOKENS = ['push', 'commit', 'write', 'reset', 'amend', 'overwrite', 'rebase'];

function matchForbidden(text: string): ForbiddenAction | null {
  const n = normalize(text);
  if (!n) return null;
  for (const rule of FORBIDDEN_ACTIONS) {
    for (const re of rule.matches) if (re.test(n)) return rule;
  }
  return null;
}

/**
 * Pure evaluation of a logical action. Side-effect free: it neither throws nor
 * writes an audit row, which is what makes it usable from the eval harness.
 *
 * @param action Logical action name, e.g. `merge_pull_request`.
 * @param target Branch, PR number, environment or null.
 * @returns `{ allowed, reason }` — `reason` is null only when allowed.
 */
export function checkAction(
  action: string,
  target: string | null,
): { allowed: boolean; reason: string | null } {
  const rule = matchForbidden(action);
  if (rule) return { allowed: false, reason: rule.reason };

  // The target is validated as a *branch name*, never regex-matched as prose:
  // real targets include incident titles ("checkout 500s after the pricing
  // release") that would otherwise trip the deploy/release patterns.
  if (target) {
    const n = normalize(action);
    const writesBranch = BRANCH_WRITE_TOKENS.some((t) => new RegExp(`\\b${t}\\b`).test(n));
    if (writesBranch && isProtectedBranch(target)) {
      return {
        allowed: false,
        reason: `"${canonicalBranch(target)}" is a protected branch; changes reach it only via a human-merged pull request.`,
      };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Record a refusal in the audit trail and throw. Persistence failures (the DB
 * may not be open yet, e.g. in a unit test) must never turn a refusal into an
 * allow, so the write is best-effort and the throw is unconditional.
 */
function deny(action: string, target: string | null, reason: string, runId: string | null): never {
  try {
    recordSafetyEvent({ runId, action, target, reason, blocked: true });
  } catch (err) {
    log.warn(`safety event not persisted: ${(err as Error).message}`);
  }
  log.warn(`BLOCKED ${action}${target ? ` -> ${target}` : ''}: ${reason}`);
  throw new UnsafeActionError(action, target, reason);
}

/**
 * Assert that a logical action is permitted. Throws `UnsafeActionError` and
 * writes a `safety_events` row if it is not.
 */
export function assertSafeAction(action: string, target: string | null, runId: string | null): void {
  const verdict = checkAction(action, target);
  if (!verdict.allowed) deny(action, target, verdict.reason ?? 'forbidden action', runId);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * git subcommands Firefighter is allowed to run. Anything absent is refused:
 * a deny list of git subcommands would be a losing game, so this is an
 * allow list plus targeted rules for the dangerous members of it.
 */
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'cat-file', 'check-ignore',
  'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'count-objects',
  'describe', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'grep', 'hash-object', 'help',
  'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'merge-tree', 'mv',
  'name-rev', 'notes', 'push', 'rebase', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse',
  'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'switch', 'symbolic-ref',
  'tag', 'var', 'version', 'whatchanged', 'worktree',
]);

/** Subcommands refused with a specific, explanatory message. */
const GIT_DENIED_SUBCOMMANDS: Record<string, string> = {
  merge: 'git merge is refused: the guard cannot prove the checked-out branch is not protected, and Firefighter never merges.',
  'filter-branch': 'Rewriting published history is never permitted.',
  'filter-repo': 'Rewriting published history is never permitted.',
  'update-ref': 'Direct ref surgery bypasses branch protection.',
  'update-index': 'Direct index surgery bypasses the normal commit path.',
  reflog: 'Reflog mutation can destroy the recovery trail.',
  gc: 'Garbage collection can prune objects the incident response still needs.',
  prune: 'Pruning can destroy objects the incident response still needs.',
  'send-email': 'Firefighter does not send email from git.',
  daemon: 'Firefighter does not start network services.',
  'p4': 'Unsupported remote VCS bridge.',
  svn: 'Unsupported remote VCS bridge.',
};

/** Flags whose *following* argument is free-form text, not a ref or a path. */
const GIT_PAYLOAD_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '--author', '--committer', '--grep', '--date',
  '--body', '--title', '--pretty', '--format', '-S', '-G',
]);

/** Argument prefixes that carry free-form text inline (`--pretty=format:%h|%s`). */
const GIT_PAYLOAD_PREFIXES = [
  '--message=', '--pretty', '--format', '--author=', '--committer=', '--grep=',
  '--date=', '--body=', '--title=', '--sort=', '--exec=',
];

const SHELL_METACHARACTERS = /[;&|`$<>\n\r]/;

function isPayloadArg(arg: string, prev: string | undefined): boolean {
  if (prev !== undefined && GIT_PAYLOAD_FLAGS.has(prev)) return true;
  return GIT_PAYLOAD_PREFIXES.some((p) => arg.startsWith(p));
}

/** Drop `git` itself plus global options (`-C <dir>`, `-c k=v`, `--no-pager`, ...). */
function stripGitGlobals(argv: string[]): { args: string[]; subcommand: string | null } {
  const args = argv[0] === 'git' ? argv.slice(1) : argv.slice();
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (!a.startsWith('-')) break;
    if ((a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') && i + 1 < args.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return { args: args.slice(i), subcommand: args[i] ?? null };
}

/** Positional (non-flag) arguments of a subcommand, stopping at `--`. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));
}

/** True for a clustered short flag such as `-fu` containing `letter`. */
function hasShortFlag(args: string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && !a.startsWith('--') && a.slice(1).includes(letter));
}

function assertSafePush(args: string[], argv: string[], runId: string | null): void {
  const line = argv.join(' ');

  if (hasFlag(args, '--force', '--force-with-lease', '--force-if-includes') || hasShortFlag(args, 'f')) {
    deny('git_push_force', line, 'Force-pushing can destroy published history; it is never permitted.', runId);
  }
  if (hasFlag(args, '--mirror', '--all')) {
    deny('git_push_all_refs', line, 'Pushing all refs or mirroring can overwrite protected branches.', runId);
  }
  if (hasFlag(args, '--delete') || hasShortFlag(args, 'd')) {
    deny('git_push_delete', line, 'Deleting a remote ref is destructive and irreversible.', runId);
  }

  const pos = positionals(args);
  const refspecs = pos.slice(1); // pos[0] is the remote
  if (refspecs.length === 0) {
    deny(
      'git_push_ambiguous',
      line,
      'Refusing a push without an explicit refspec: the implicit upstream could be a protected branch.',
      runId,
    );
  }
  for (const spec of refspecs) {
    if (spec.startsWith('+')) {
      deny('git_push_force', line, 'A leading "+" in a refspec is a force push; it is never permitted.', runId);
    }
    const parts = spec.split(':');
    const src = parts[0] ?? '';
    const dst = parts.length > 1 ? parts[1] ?? '' : spec;
    if (parts.length > 1 && src === '') {
      deny('git_push_delete', line, 'Deleting a remote ref is destructive and irreversible.', runId);
    }
    if (isProtectedBranch(dst)) {
      deny(
        'git_push_protected_branch',
        canonicalBranch(dst),
        `"${canonicalBranch(dst)}" is a protected branch; changes reach it only via a human-merged pull request.`,
        runId,
      );
    }
  }
}

function assertSafeBranch(args: string[], argv: string[], runId: string | null): void {
  const line = argv.join(' ');
  const deleting = hasFlag(args, '--delete', '-d', '-D') || hasShortFlag(args, 'd') || hasShortFlag(args, 'D');
  const moving = hasFlag(args, '--move', '-m', '-M');
  if (!deleting && !moving) return;
  // Unlike `push`, every positional here is a branch name.
  for (const p of positionals(args)) {
    if (isProtectedBranch(p)) {
      deny(
        deleting ? 'git_branch_delete_protected' : 'git_branch_rename_protected',
        canonicalBranch(p),
        `"${canonicalBranch(p)}" is a protected branch and may not be deleted or renamed.`,
        runId,
      );
    }
  }
  if (deleting && (hasFlag(args, '--remotes', '-r') || hasShortFlag(args, 'r'))) {
    deny('git_branch_delete_remote', line, 'Deleting a remote-tracking ref is destructive and irreversible.', runId);
  }
}

function assertSafeTag(args: string[], argv: string[], runId: string | null): void {
  if (hasFlag(args, '--delete', '-d', '-D') || hasShortFlag(args, 'd')) {
    deny('git_tag_delete', argv.join(' '), 'Deleting a tag destroys a release marker and is never permitted.', runId);
  }
}

function assertSafeReset(args: string[], argv: string[], runId: string | null): void {
  if (!hasFlag(args, '--hard', '--merge', '--keep')) return;
  for (const p of positionals(args)) {
    if (isProtectedBranch(p)) {
      deny(
        'git_reset_protected_branch',
        canonicalBranch(p),
        `Hard-resetting "${canonicalBranch(p)}" rewrites a protected branch; it is never permitted.`,
        runId,
      );
    }
  }
}

function assertSafeCheckout(args: string[], argv: string[], runId: string | null): void {
  // `-B` / `-C` force-create, i.e. silently reset an existing branch.
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const forceCreate = a === '-B' || a === '-C' || a === '--force-create';
    if (!forceCreate) continue;
    const name = args[i + 1];
    if (name && isProtectedBranch(name)) {
      deny(
        'git_force_create_protected_branch',
        canonicalBranch(name),
        `Force-creating "${canonicalBranch(name)}" would reset a protected branch.`,
        runId,
      );
    }
  }
}

/**
 * Assert that a `git` invocation is safe. `argv` may or may not include the
 * leading `git`. Reads (log/show/diff/status/rev-parse/worktree), branch
 * creation, commits and reverts on non-protected branches are allowed; force
 * pushes, protected-branch writes, ref deletion, history rewrites and merges
 * are refused.
 */
export function assertSafeGitCommand(argv: string[], runId: string | null): void {
  const line = argv.join(' ');
  if (argv.length === 0) {
    deny('git_empty', null, 'Refusing an empty git invocation.', runId);
  }

  const { args, subcommand } = stripGitGlobals(argv);
  if (!subcommand) {
    deny('git_no_subcommand', line, 'Refusing a git invocation with no subcommand.', runId);
  }

  // Shell metacharacters in a ref/path argument mean someone is trying to
  // smuggle a second command through. Free-form payloads (commit messages,
  // --pretty formats) are exempt: they are data, and git is spawned without a
  // shell, so a "|" inside --pretty=format is inert.
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (isPayloadArg(a, args[i - 1])) continue;
    if (SHELL_METACHARACTERS.test(a) || a.includes('$(') || a.includes('${')) {
      deny(
        'git_shell_metacharacter',
        a,
        `Argument "${a}" contains a shell metacharacter; command injection is never permitted.`,
        runId,
      );
    }
  }

  const denied = GIT_DENIED_SUBCOMMANDS[subcommand];
  if (denied) deny(`git_${subcommand.replace(/-/g, '_')}`, line, denied, runId);

  if (!GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
    deny('git_subcommand_not_allowed', line, `git "${subcommand}" is not on the Firefighter allow list.`, runId);
  }

  const rest = args.slice(1);
  switch (subcommand) {
    case 'push':
      assertSafePush(rest, argv, runId);
      break;
    case 'branch':
      assertSafeBranch(rest, argv, runId);
      break;
    case 'tag':
      assertSafeTag(rest, argv, runId);
      break;
    case 'reset':
      assertSafeReset(rest, argv, runId);
      break;
    case 'checkout':
    case 'switch':
      assertSafeCheckout(rest, argv, runId);
      break;
    case 'rebase': {
      // `git rebase <upstream> [<branch>]` rewrites <branch>. Rebasing *onto*
      // a protected branch is normal; rebasing the protected branch is not.
      const target = positionals(rest)[1];
      if (target && isProtectedBranch(target)) {
        deny(
          'git_rebase_protected_branch',
          canonicalBranch(target),
          `Rebasing "${canonicalBranch(target)}" rewrites a protected branch; it is never permitted.`,
          runId,
        );
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const HTTP_READ_METHODS = new Set(['GET', 'HEAD']);

interface HttpRule {
  id: string;
  test: (method: string, path: string) => boolean;
  reason: string;
}

const HTTP_RULES: readonly HttpRule[] = Object.freeze([
  {
    id: 'github_merge_pull_request',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/pulls\/\d+\/merge\b/.test(p),
    reason: 'Firefighter never merges pull requests; a human reviews and merges.',
  },
  {
    id: 'github_merge_branches',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/(merges|merge-upstream)\b/.test(p),
    reason: 'Merging branches server-side bypasses human review.',
  },
  {
    id: 'github_deployments',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/(deployments|deployment_statuses|deploy|rollouts?)\b/.test(p),
    reason: 'Firefighter never deploys, releases or rolls out to any environment.',
  },
  {
    id: 'github_releases',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/releases\b/.test(p),
    reason: 'Cutting or publishing a release is a deploy action and is never permitted.',
  },
  {
    id: 'github_delete_ref',
    test: (m, p) => m === 'DELETE' && /\/(git\/)?refs?\//.test(p),
    reason: 'Deleting a ref is destructive and irreversible.',
  },
  {
    id: 'github_branch_protection',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/branches\/[^/]+\/protection\b/.test(p),
    reason: 'Branch protection may never be weakened by the agent.',
  },
  {
    id: 'github_workflow_dispatch',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && /\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/(rerun|cancel))\b/.test(p),
    reason: 'Dispatching a workflow can trigger a deployment.',
  },
  {
    id: 'write_to_merge_endpoint',
    test: (m, p) => !HTTP_READ_METHODS.has(m) && p.includes('/merge'),
    reason: 'Only GET/HEAD are permitted against a merge endpoint.',
  },
]);

/**
 * Assert that an outbound HTTP request is safe. Reads are always allowed;
 * writes to merge, deployment, release, ref-deletion and branch-protection
 * endpoints are refused.
 */
export function assertSafeHttp(method: string, url: string, runId: string | null): void {
  const m = (method || 'GET').toUpperCase();
  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    // Not an absolute URL — match against the raw string, which is stricter.
  }
  for (const rule of HTTP_RULES) {
    if (rule.test(m, path)) deny(rule.id, `${m} ${url}`, rule.reason, runId);
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Assert that a shell/exec invocation is safe. `git` and `gh` are delegated to
 * their dedicated guards; everything else is matched against the full
 * forbidden-action deny list (deploys, publishes, infra and database
 * destruction, `rm -rf`, ...).
 *
 * Note: argv is executed without a shell, so metacharacters inside arguments
 * are inert here (e.g. `node -e "require('./x')"` must keep working) and are
 * deliberately not treated as a refusal outside of git.
 */
export function assertSafeShell(argv: string[], runId: string | null): void {
  if (argv.length === 0) {
    deny('shell_empty', null, 'Refusing an empty command.', runId);
  }
  const cmd = (argv[0] ?? '').split('/').pop() ?? '';
  const line = argv.join(' ');

  if (cmd === 'git') {
    assertSafeGitCommand(argv, runId);
    return;
  }

  if (cmd === 'gh' && argv[1] === 'api') {
    const rest = argv.slice(2);
    let method = 'GET';
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === '-X' || a === '--method') method = (rest[i + 1] ?? 'GET').toUpperCase();
      else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
      else if (a === '-f' || a === '--field' || a === '--raw-field' || a === '-F') method = method === 'GET' ? 'POST' : method;
    }
    const target = rest.find((a) => !a.startsWith('-') && (a.includes('/') || a.startsWith('repos')));
    if (target) {
      const abs = /^https?:\/\//.test(target) ? target : `https://api.github.com/${target.replace(/^\//, '')}`;
      assertSafeHttp(method, abs, runId);
    }
  }

  const rule = matchForbidden(line);
  if (rule) deny(`shell_${rule.id}`, line, rule.reason, runId);
}
