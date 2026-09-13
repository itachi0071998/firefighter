/**
 * The tool registry: the complete, explicit surface the agent is allowed to act
 * through.
 *
 * Three properties hold for every tool here:
 *   1. Side effects live in deterministic code, never in the LLM.
 *   2. Every mutating tool passes through withIdempotency(), so replaying a
 *      workflow can never produce a duplicate ticket, branch, PR, or message.
 *   3. Every mutating tool passes through the safety guard first, so merges and
 *      deploys are impossible to express.
 */
import { Config, config as defaultConfig } from '../config.ts';
import {
  ChangedFile,
  CodeMatch,
  CommitInfo,
  Deployment,
  FilePatch,
  Incident,
  LintResult,
  PullRequestInfo,
  PullRequestRef,
  RepoInfo,
  ReproResult,
  RevertPrep,
  SlackMessageRef,
  StepName,
  TestRunResult,
  TicketRef,
} from '../types.ts';
import { CreatePrInput, getGitHubClient, GitHubClient } from './github.ts';
import { getSlackClient, SlackClient, SlackUpdateInput } from './slack.ts';
import { getTicketClient, TicketClient, TicketInput } from './tickets.ts';
import { getTestRunner, RunOpts, TestRunner } from './tests.ts';
import { assertSafeAction } from './guard.ts';
import { getIncident, recordToolCall, withIdempotency } from '../db/repo.ts';
import { nowMs } from '../util/clock.ts';
import { payloadHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';

const log = logger('tools');

export interface ToolContext {
  runId: string;
  incidentId: string;
  cfg: Config;
  /** Mutated by the engine as it advances, so tool calls are attributed. */
  step: StepName | null;
}

export interface Mutated<T> {
  ref: T;
  replayed: boolean;
}

export interface Tools {
  readonly ctx: ToolContext;
  readonly github: GitHubClient;
  readonly slack: SlackClient;
  readonly tickets: TicketClient;
  readonly testRunner: TestRunner;

  // --- read-only -----------------------------------------------------------
  get_incident(id?: string): Incident | null;
  get_repo_info(): Promise<RepoInfo>;
  get_recent_commits(limit?: number): Promise<CommitInfo[]>;
  get_recent_pull_requests(limit?: number): Promise<PullRequestInfo[]>;
  get_pull_request(n: number): Promise<PullRequestInfo | null>;
  inspect_diff(ref: string | number): Promise<ChangedFile[]>;
  get_deployments(limit?: number): Promise<Deployment[]>;
  search_code(query: string): Promise<CodeMatch[]>;
  read_file(path: string, ref?: string): Promise<string | null>;
  run_tests(opts?: RunOpts): Promise<TestRunResult>;
  run_lint(opts?: RunOpts): Promise<LintResult>;
  reproduce_bug(incident: Incident, opts?: RunOpts): Promise<ReproResult>;

  // --- mutating (idempotent) ----------------------------------------------
  create_incident_ticket(input: TicketInput): Promise<Mutated<TicketRef>>;
  update_ticket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef>;
  /** `role` names the logical branch ("revert" / "fix") for duplicate detection. */
  create_branch(name: string, fromRef: string, role?: string): Promise<Mutated<{ branch: string; sha: string }>>;
  generate_revert(prNumber: number, branch: string): Promise<Mutated<RevertPrep>>;
  apply_patch(branch: string, patches: FilePatch[], message: string, role?: string): Promise<Mutated<{ sha: string; files: string[] }>>;
  create_pull_request(input: CreatePrInput): Promise<Mutated<PullRequestRef>>;
  post_slack_update(input: SlackUpdateInput): Promise<Mutated<SlackMessageRef>>;
}

/**
 * Simulated hard crash used by the eval harness. When FF_CRASH_AFTER names a
 * mutating tool, the process dies immediately AFTER the external side effect is
 * durably recorded but BEFORE the step can be marked succeeded — precisely the
 * window where a naive agent would create a duplicate on restart.
 */
function maybeCrashAfter(tool: string): void {
  const target = (process.env.FF_CRASH_AFTER ?? '').trim();
  if (target && target === tool) {
    log.error(`FF_CRASH_AFTER=${tool} — simulating process crash after side effect`);
    process.exit(137);
  }
}

export function createTools(ctx: ToolContext): Tools {
  const cfg = ctx.cfg ?? defaultConfig;
  const github = getGitHubClient(cfg);
  const slack = getSlackClient(cfg);
  const tickets = getTicketClient(cfg);
  const testRunner = getTestRunner(cfg);

  /** Wraps a read-only tool: timing + durable tool_call audit trail. */
  async function read<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    const t0 = nowMs();
    try {
      const result = await fn();
      recordToolCall({
        runId: ctx.runId,
        step: ctx.step,
        tool,
        args,
        result: summarise(result),
        ok: true,
        durationMs: nowMs() - t0,
      });
      return result;
    } catch (err) {
      recordToolCall({
        runId: ctx.runId,
        step: ctx.step,
        tool,
        args,
        result: null,
        ok: false,
        error: String(err instanceof Error ? err.message : err),
        durationMs: nowMs() - t0,
      });
      throw err;
    }
  }

  /** Wraps a mutating tool: guard -> idempotency ledger -> audit trail. */
  async function mutate<T extends { externalId: string; externalUrl?: string | null }>(
    tool: string,
    target: string | null,
    key: string,
    subject: string,
    args: unknown,
    fn: () => Promise<T>,
  ): Promise<Mutated<T>> {
    assertSafeAction(tool, target, ctx.runId);
    const t0 = nowMs();
    try {
      const { result, replayed } = await withIdempotency(
        { key, runId: ctx.runId, incidentId: ctx.incidentId, kind: tool, subject, payload: args },
        fn,
      );
      recordToolCall({
        runId: ctx.runId,
        step: ctx.step,
        tool,
        args,
        result: summarise(result),
        ok: true,
        mutating: true,
        idempotencyKey: key,
        replayed,
        durationMs: nowMs() - t0,
      });
      if (replayed) {
        log.info(`${tool}: replayed from idempotency ledger (${key}) -> ${result.externalId}`);
      } else {
        maybeCrashAfter(tool);
      }
      return { ref: result, replayed };
    } catch (err) {
      recordToolCall({
        runId: ctx.runId,
        step: ctx.step,
        tool,
        args,
        result: null,
        ok: false,
        mutating: true,
        idempotencyKey: key,
        error: String(err instanceof Error ? err.message : err),
        durationMs: nowMs() - t0,
      });
      throw err;
    }
  }

  const inc = ctx.incidentId;

  return {
    ctx,
    github,
    slack,
    tickets,
    testRunner,

    get_incident: (id) => getIncident(id ?? ctx.incidentId),
    get_repo_info: () => read('get_repo_info', {}, () => github.getRepoInfo()),
    get_recent_commits: (limit = 30) =>
      read('get_recent_commits', { limit }, () => github.getRecentCommits(limit)),
    get_recent_pull_requests: (limit = 10) =>
      read('get_recent_pull_requests', { limit }, () => github.getRecentPullRequests(limit)),
    get_pull_request: (n) => read('get_pull_request', { n }, () => github.getPullRequest(n)),
    inspect_diff: (ref) => read('inspect_diff', { ref }, () => github.inspectDiff(ref)),
    get_deployments: (limit = 10) => read('get_deployments', { limit }, () => github.getDeployments(limit)),
    search_code: (query) => read('search_code', { query }, () => github.searchCode(query)),
    read_file: (p, ref) => read('read_file', { path: p, ref }, () => github.readFile(p, ref)),
    run_tests: (opts) => read('run_tests', opts ?? {}, () => testRunner.runTests(opts)),
    run_lint: (opts) => read('run_lint', opts ?? {}, () => testRunner.runLint(opts)),
    reproduce_bug: (incident, opts) =>
      read('reproduce_bug', { incidentId: incident.id }, () => testRunner.reproduce(incident, opts)),

    create_incident_ticket: (input) =>
      mutate('create_incident_ticket', input.title, `ticket:${inc}`, 'incident_ticket', input, async () => {
        const ref = await tickets.createIncidentTicket(input);
        return { ...ref, externalId: ref.identifier, externalUrl: ref.url };
      }).then((m) => ({ ref: m.ref as unknown as TicketRef, replayed: m.replayed })),

    update_ticket: (id, patch) =>
      read('update_ticket', { id, patch }, () => tickets.updateTicket(id, patch)),

    create_branch: (name, fromRef, role) =>
      mutate('create_branch', name, `branch:${inc}:${name}`, `branch:${role ?? name}`, { name, fromRef }, async () => {
        const r = await github.createBranch(name, fromRef);
        return { branch: r.branch, sha: r.sha, externalId: r.branch, externalUrl: null };
      }).then((m) => ({ ref: { branch: m.ref.branch, sha: m.ref.sha }, replayed: m.replayed })),

    generate_revert: (prNumber, branch) =>
      mutate('generate_revert', `#${prNumber}`, `revert:${inc}:${prNumber}`, `revert:pr-${prNumber}`, { prNumber, branch }, async () => {
        const prep = await github.generateRevert(prNumber, branch);
        return { ...prep, externalId: prep.revertedSha, externalUrl: null };
      }).then((m) => ({ ref: m.ref as unknown as RevertPrep, replayed: m.replayed })),

    apply_patch: (branch, patches, message, role) =>
      mutate(
        'apply_patch',
        branch,
        `patch:${inc}:${branch}:${payloadHash(patches.map((p) => ({ path: p.path, contents: p.contents })))}`,
        `patch:${role ?? branch}`,
        { branch, message, paths: patches.map((p) => p.path) },
        async () => {
          const r = await github.applyPatch(branch, patches, message);
          return { sha: r.sha, files: r.files, externalId: r.sha, externalUrl: null };
        },
      ).then((m) => ({ ref: { sha: m.ref.sha, files: m.ref.files }, replayed: m.replayed })),

    create_pull_request: (input) =>
      mutate('create_pull_request', input.head, `pr:${inc}:${input.kind}:${input.head}`, `pull_request:${input.kind}`, input, async () => {
        const ref = await github.createPullRequest(input);
        return { ...ref, externalId: String(ref.number), externalUrl: ref.url };
      }).then((m) => ({ ref: m.ref as unknown as PullRequestRef, replayed: m.replayed })),

    post_slack_update: (input) =>
      mutate(
        'post_slack_update',
        input.channel,
        `slack:${inc}`,
        'slack_update',
        { channel: input.channel, incidentId: input.incident.id },
        async () => {
          const ref = await slack.postIncidentUpdate(input);
          return { ...ref, externalId: ref.ts, externalUrl: ref.permalink };
        },
      ).then((m) => ({ ref: m.ref as unknown as SlackMessageRef, replayed: m.replayed })),
  };
}

/** Keeps the audit trail readable: large payloads are summarised, not dumped. */
function summarise(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 12) return { count: value.length, sample: value.slice(0, 3) };
    return value;
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.output === 'string' && v.output.length > 1200) {
      return { ...v, output: v.output.slice(-1200) };
    }
  }
  return value;
}
