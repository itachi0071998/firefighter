/**
 * Ticketing adapter (Linear / Jira).
 *
 * One interface, four implementations, selected by config:
 *
 *   mock   - a durable local issue tracker: identifiers come from a monotonic
 *            counter persisted in <dataDir>/tickets.json, so updates and
 *            comments survive a restart and nothing is random.
 *   linear - the real Linear GraphQL API.
 *   jira   - the real Jira Cloud REST v3 API (description in ADF).
 *   bridge - records a bridge intent for an external connector to fulfil.
 *
 * `buildTicketDescription()` is pure and shared by every implementation, so the
 * ticket body is identical whichever backend is in use.
 *
 * Idempotency is deliberately NOT implemented here: `withIdempotency()` in the
 * tool registry owns that. Calling `createIncidentTicket` twice really does
 * create two tickets — which is exactly what the engine's ledger prevents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Config, config as defaultConfig, effectiveProviders } from '../config.ts';
import { Evidence, Incident, Investigation, PullRequestRef, Severity, TicketRef } from '../types.ts';
import { getRunByIncident, upsertBridgeIntent } from '../db/repo.ts';
import { nowIso, nowMs } from '../util/clock.ts';
import { payloadHash, shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';

const log = logger('tickets');

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface TicketInput {
  incidentId: string;
  title: string;
  description: string;
  severity: Severity;
  labels: string[];
  priority?: number;
}

export interface TicketClient {
  readonly provider: string;
  createIncidentTicket(input: TicketInput): Promise<TicketRef>;
  updateTicket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef>;
  addComment(id: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Description rendering (pure)
// ---------------------------------------------------------------------------

/** Return `value` when it is a usable non-empty string, else `fallback`. */
function orElse(value: string | null | undefined, fallback: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : fallback;
}

/** Collapse newlines/repeated whitespace so a value is safe on a single line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Trim to `max` characters, appending an ellipsis when anything was cut. */
function truncate(value: string, max: number): string {
  const s = value.trim();
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Render a 0..1 confidence as a whole-number percentage, e.g. `92%`. */
function pct(confidence: number): string {
  const n = Number.isFinite(confidence) ? confidence : 0;
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

/** Rank evidence by its actual contribution (weight x |score|), strongest first. */
function rankEvidence(evidence: Evidence[]): Evidence[] {
  return [...(evidence ?? [])]
    .filter((e) => e && typeof e.description === 'string' && e.description.trim().length > 0)
    .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score));
}

/** Severity -> priority: sev1 is urgent (1), sev3 is normal (3). */
function severityToPriority(severity: Severity): number {
  switch (severity) {
    case 'sev1':
      return 1;
    case 'sev2':
      return 2;
    default:
      return 3;
  }
}

/**
 * Render the incident ticket body in Markdown.
 *
 * Sections: summary, impact, detection, suspected change (with confidence),
 * evidence, immediate mitigation, permanent remediation, links, and the
 * standing human-approval notice. Every optional input may be absent — an
 * inconclusive investigation, no revert PR, no fix PR — and no section ever
 * renders a placeholder such as `undefined`.
 *
 * @param args Incident + investigation, plus whatever PRs already exist.
 * @returns Markdown suitable for Linear, or for ADF conversion for Jira.
 */
export function buildTicketDescription(args: {
  incident: Incident;
  investigation: Investigation;
  revertPr?: PullRequestRef | null;
  fixPr?: PullRequestRef | null;
}): string {
  const { incident, investigation: inv } = args;
  const out: string[] = [];

  const title = orElse(incident?.title, 'Untitled incident');
  const incidentId = orElse(incident?.id, 'unknown-incident');
  const service = orElse(incident?.service, 'unknown-service');
  const severity = orElse(incident?.severity, 'sev3');
  const errorType = orElse(incident?.errorType, 'Error');
  const errorMessage = orElse(incident?.errorMessage, 'no error message captured');

  // --- summary -------------------------------------------------------------
  out.push('## Summary');
  out.push(
    `${title} — \`${errorType}: ${oneLine(errorMessage)}\` in **${service}**.`,
  );
  out.push('');
  out.push(
    `**Incident:** ${incidentId} · **Service:** ${service} · **Severity:** ${severity.toUpperCase()} · **Source:** ${orElse(
      incident?.source,
      'unknown',
    )}`,
  );
  out.push('');

  // --- impact --------------------------------------------------------------
  out.push('## Impact');
  const affected = oneLine(orElse(inv?.affectedFunctionality, ''));
  if (affected) out.push(`- Affected functionality: ${affected}`);
  if (incident?.metrics) {
    out.push(
      `- Error rate ${incident.metrics.errorRatePct}% over ${orElse(incident.metrics.window, 'the alert window')}`,
    );
    out.push(`- ${incident.metrics.affectedRequests} requests affected`);
  }
  if (!affected && !incident?.metrics) out.push('- Impact not quantified by the available telemetry.');
  out.push('');

  // --- detection -----------------------------------------------------------
  out.push('## Detection');
  out.push(
    `Detected at ${orElse(incident?.detectedAt, 'an unknown time')} by \`${orElse(incident?.source, 'unknown')}\`.`,
  );
  const stack = orElse(incident?.stackTrace, '');
  if (stack) {
    out.push('');
    out.push('```');
    out.push(stack.split('\n').slice(0, 6).join('\n'));
    out.push('```');
  }
  const frame = inv?.failingFrame ?? null;
  if (frame) {
    out.push('');
    out.push(`Failing frame: \`${orElse(frame.fn, 'anonymous')}\` at \`${orElse(frame.file, 'unknown')}:${frame.line}\``);
  }
  out.push('');

  // --- suspected change ----------------------------------------------------
  const suspect = inv?.suspect ?? null;
  const topCandidate = suspect ?? (inv?.rankedSuspects?.length ? inv.rankedSuspects[0] : null);
  const inconclusive = !suspect || inv?.inconclusive === true;

  out.push('## Suspected change');
  if (inconclusive) {
    out.push(
      '**Inconclusive** — no recent change cleared the confidence floor, so nothing has been blamed and nothing has been reverted. Human triage is required.',
    );
    if (topCandidate) {
      out.push('');
      out.push(
        `Highest-scoring candidate, **not** blamed: ${describeSuspect(topCandidate)} at ${pct(
          topCandidate.confidence,
        )} confidence.`,
      );
    }
  } else {
    out.push(`**${describeSuspect(suspect)}**`);
    out.push('');
    out.push(`- Confidence: **${pct(suspect.confidence)}**`);
    out.push(`- Author: ${orElse(suspect.author, 'unknown')}`);
    out.push(`- Commit: \`${orElse(suspect.sha, 'unknown').slice(0, 12)}\``);
    if (suspect.deployedAt) out.push(`- Deployed to production: ${suspect.deployedAt}`);
  }
  const rootCause = oneLine(orElse(inv?.rootCause, ''));
  if (rootCause) {
    out.push('');
    out.push(`**Root cause:** ${rootCause}`);
  }
  out.push('');

  // --- evidence ------------------------------------------------------------
  const evidence = topCandidate ? rankEvidence(topCandidate.evidence ?? []) : [];
  // --- causal verification -------------------------------------------------
  // Stated before the evidence list, because whether the cause was PROVEN or
  // merely inferred changes how the rest should be read.
  const verification = inv?.verification;
  if (verification) {
    out.push('## Causal verification');
    if (verification.verified) {
      const proven = verification.probes.find((p) => p.verdict === 'proven');
      out.push(
        `**Proven by execution.** The production request was replayed in isolated worktrees on ` +
          `both sides of the change:`,
      );
      out.push('');
      out.push(`- \`${proven?.parentSha?.slice(0, 10)}\` (before #${verification.culpritPr}) — does **not** reproduce`);
      out.push(`- \`${verification.culpritSha?.slice(0, 10)}\` (#${verification.culpritPr}) — **does** reproduce`);
      if (verification.overrodeRanking) {
        out.push('');
        out.push(
          `> Correlation first ranked #${verification.rankedPr}; execution disproved that and identified #${verification.culpritPr}.`,
        );
      }
    } else {
      out.push(
        `**Not proven.** ${verification.skippedReason ?? verification.summary} The suspected change ` +
          `below is correlation-based and needs human confirmation.`,
      );
    }
    out.push('');
  }

  out.push('## Evidence');
  if (evidence.length) {
    for (const e of evidence) {
      const kind = orElse(e.kind, 'signal').replace(/_/g, ' ');
      const detail = oneLine(orElse(e.detail, ''));
      out.push(
        `- **${kind}** (weight ${e.weight}, score ${e.score}) — ${oneLine(e.description)}${
          detail ? ` _(${truncate(detail, 200)})_` : ''
        }`,
      );
    }
  } else {
    out.push('- No correlating signal was strong enough to record.');
  }
  out.push('');

  // --- mitigation / remediation -------------------------------------------
  out.push('## Immediate mitigation');
  if (args.revertPr) {
    out.push(
      `Revert PR [#${args.revertPr.number}](${orElse(args.revertPr.url, '')}) is open against \`${orElse(
        args.revertPr.baseBranch,
        'main',
      )}\` from \`${orElse(args.revertPr.branch, 'unknown branch')}\`. It is **not merged** — a human reviews and merges it.`,
    );
  } else {
    out.push(oneLine(orElse(inv?.immediateMitigation, 'No automated revert was prepared; mitigate manually.')));
  }
  out.push('');

  out.push('## Permanent remediation');
  if (args.fixPr) {
    out.push(
      `Fix PR [#${args.fixPr.number}](${orElse(args.fixPr.url, '')}) is open from \`${orElse(
        args.fixPr.branch,
        'unknown branch',
      )}\`, with a regression test covering the failure. It is **not merged**.`,
    );
  } else {
    out.push(
      oneLine(
        orElse(inv?.permanentFix, 'A permanent fix has not been generated automatically; manual remediation required.'),
      ),
    );
  }
  out.push('');

  // --- links ---------------------------------------------------------------
  out.push('## Links');
  out.push(`- Incident: ${incidentId}`);
  if (args.revertPr) out.push(`- Revert PR: ${orElse(args.revertPr.url, `#${args.revertPr.number}`)}`);
  if (args.fixPr) out.push(`- Fix PR: ${orElse(args.fixPr.url, `#${args.fixPr.number}`)}`);
  if (!args.revertPr && !args.fixPr) out.push('- No pull requests have been opened yet.');
  out.push('');

  const narrative = oneLine(orElse(inv?.narrative, ''));
  if (narrative) {
    out.push('## Investigation notes');
    out.push(truncate(narrative, 1500));
    out.push(`_Reasoning source: ${orElse(inv?.reasoningSource, 'deterministic')}._`);
    out.push('');
  }

  out.push('---');
  out.push('**Human approval required — Firefighter does not merge or deploy.**');

  return out.join('\n');
}

/** `PR #142 — title`, or the short sha when the change has no pull request. */
function describeSuspect(s: { prNumber: number | null; sha: string; title: string }): string {
  const title = oneLine(orElse(s.title, 'untitled change'));
  if (s.prNumber !== null && s.prNumber !== undefined) return `PR #${s.prNumber} — ${title}`;
  const sha = orElse(s.sha, '').slice(0, 7);
  return sha ? `commit ${sha} — ${title}` : title;
}

// ---------------------------------------------------------------------------
// HTTP helper: 15s timeout, two retries on 429/5xx
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3; // one attempt + two retries

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never let an API key reach a log line, a timeline entry or an Error message. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***redacted***');
  }
  return out;
}

interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Issue a JSON request with an AbortController timeout, retrying twice on 429,
 * 5xx or a transport error. 4xx responses are returned so the caller can raise
 * a clear, credential-free domain error.
 */
async function httpJson(
  method: string,
  url: string,
  body: unknown | null,
  headers: Record<string, string>,
  secrets: string[],
): Promise<HttpResponse> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        lastError = `HTTP ${res.status}`;
        log.warn(`ticket ${method} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      return { status: res.status, body: text };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        log.warn(`ticket ${method} failed (${redact(lastError, secrets)}) — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(redact(`Ticket API request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`, secrets));
}

/** Parse a JSON body, or fail with a short, quoted excerpt of what arrived. */
function parseJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${context}: response was not JSON — ${truncate(body, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Mock (Linear-shaped, file backed)
// ---------------------------------------------------------------------------

/** The mock's identifier prefix. Matches the demo's `INC-12` shape. */
const MOCK_PREFIX = 'INC';

interface StoredComment {
  body: string;
  createdAt: string;
}

interface StoredTicket {
  id: string;
  identifier: string;
  number: number;
  url: string;
  provider: string;
  state: string;
  title: string;
  description: string;
  severity: Severity;
  priority: number;
  labels: string[];
  incidentId: string;
  createdAt: string;
  updatedAt: string;
  comments: StoredComment[];
}

interface TicketStore {
  version: 1;
  counter: number;
  tickets: StoredTicket[];
}

/** Deterministic uuid-shaped internal id, mirroring Linear's `issue.id`. */
function mockTicketId(incidentId: string, identifier: string): string {
  const h = shortHash(`${incidentId}|${identifier}`, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-a${h.slice(15, 18)}-${h.slice(18, 30)}`;
}

/**
 * A durable, deterministic stand-in for Linear. Everything lives in one JSON
 * file so `updateTicket`/`addComment` keep working across process restarts and
 * the dashboard can read the same records.
 */
class MockLinearClient implements TicketClient {
  readonly provider = 'mock';
  private readonly file: string;

  constructor(cfg: Config) {
    this.file = path.join(cfg.dataDir, 'tickets.json');
  }

  /** Read the store, tolerating a missing or corrupt file. */
  private read(): TicketStore {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TicketStore>;
      const tickets = Array.isArray(parsed.tickets) ? (parsed.tickets as StoredTicket[]) : [];
      const counter = Number.isFinite(parsed.counter) ? Number(parsed.counter) : 0;
      return { version: 1, counter, tickets };
    } catch {
      return { version: 1, counter: 0, tickets: [] };
    }
  }

  /** Write the store atomically so a crash mid-write cannot corrupt it. */
  private write(store: TicketStore): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /**
   * Next issue number, derived from the store rather than kept in memory: the
   * max of the persisted counter and every existing ticket number, plus one.
   * Never random, and correct after a restart.
   */
  private nextNumber(store: TicketStore): number {
    const highest = store.tickets.reduce((max, t) => (t.number > max ? t.number : max), 0);
    return Math.max(store.counter, highest) + 1;
  }

  private find(store: TicketStore, id: string): StoredTicket | undefined {
    return store.tickets.find((t) => t.id === id || t.identifier === id);
  }

  private toRef(t: StoredTicket): TicketRef {
    return {
      id: t.id,
      identifier: t.identifier,
      url: t.url,
      provider: this.provider,
      state: t.state,
      title: t.title,
    };
  }

  /** Create a ticket. Two calls create two tickets — idempotency is the engine's job. */
  async createIncidentTicket(input: TicketInput): Promise<TicketRef> {
    const store = this.read();
    const number = this.nextNumber(store);
    const identifier = `${MOCK_PREFIX}-${number}`;
    const ts = nowIso();
    const ticket: StoredTicket = {
      id: mockTicketId(input.incidentId, identifier),
      identifier,
      number,
      url: `https://linear.app/firefighter-demo/issue/${identifier}`,
      provider: this.provider,
      state: 'Triage',
      title: input.title,
      description: input.description,
      severity: input.severity,
      priority: input.priority ?? severityToPriority(input.severity),
      labels: [...(input.labels ?? [])],
      incidentId: input.incidentId,
      createdAt: ts,
      updatedAt: ts,
      comments: [],
    };
    store.tickets.push(ticket);
    store.counter = number;
    this.write(store);
    log.info(`ticket (mock) created ${identifier} for ${input.incidentId}`);
    return this.toRef(ticket);
  }

  /** Move state and/or replace the description. Unknown ids are an error. */
  async updateTicket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef> {
    const store = this.read();
    const ticket = this.find(store, id);
    if (!ticket) throw new Error(`ticket not found: ${id}`);
    if (typeof patch.state === 'string' && patch.state.trim()) ticket.state = patch.state.trim();
    if (typeof patch.description === 'string') ticket.description = patch.description;
    ticket.updatedAt = nowIso();
    this.write(store);
    return this.toRef(ticket);
  }

  /** Append a comment to the persisted record. */
  async addComment(id: string, body: string): Promise<void> {
    const store = this.read();
    const ticket = this.find(store, id);
    if (!ticket) throw new Error(`ticket not found: ${id}`);
    ticket.comments.push({ body, createdAt: nowIso() });
    ticket.updatedAt = nowIso();
    this.write(store);
  }
}

// ---------------------------------------------------------------------------
// Linear (real GraphQL API)
// ---------------------------------------------------------------------------

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state?: { name: string } | null;
}

/** Linear GraphQL. Auth header is the raw personal API key, per Linear's docs. */
class LinearClient implements TicketClient {
  readonly provider = 'linear';
  private static readonly ENDPOINT = 'https://api.linear.app/graphql';

  constructor(private readonly cfg: Config) {}

  private get key(): string {
    const k = this.cfg.tickets.linearApiKey;
    if (!k) throw new Error('LINEAR_API_KEY is not configured');
    return k;
  }

  /** Execute a GraphQL document, turning `errors[]` into a clean Error. */
  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const key = this.key;
    const res = await httpJson(
      'POST',
      LinearClient.ENDPOINT,
      { query, variables },
      { authorization: key },
      [key],
    );
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Linear rejected the credentials (HTTP ${res.status}); check LINEAR_API_KEY`);
    }
    if (res.status >= 400) {
      throw new Error(redact(`Linear API HTTP ${res.status}: ${truncate(res.body, 300)}`, [key]));
    }
    const parsed = parseJson<GraphQlResponse<T>>(res.body, 'Linear API');
    if (parsed.errors?.length) {
      throw new Error(redact(`Linear API error: ${parsed.errors.map((e) => e.message).join('; ')}`, [key]));
    }
    if (!parsed.data) throw new Error('Linear API returned no data');
    return parsed.data;
  }

  /** Resolve the configured team key to its id, plus its label ids by name. */
  private async resolveTeam(): Promise<{ id: string; labels: Map<string, string> }> {
    const teamKey = this.cfg.tickets.linearTeamKey;
    const data = await this.gql<{
      teams: { nodes: { id: string; key: string; labels: { nodes: { id: string; name: string }[] } }[] };
    }>(
      `query TeamByKey($key: String!) {
         teams(filter: { key: { eq: $key } }, first: 1) {
           nodes { id key labels(first: 100) { nodes { id name } } }
         }
       }`,
      { key: teamKey },
    );
    const team = data.teams?.nodes?.[0];
    if (!team) throw new Error(`Linear team "${teamKey}" not found (set LINEAR_TEAM_KEY)`);
    const labels = new Map<string, string>();
    for (const l of team.labels?.nodes ?? []) labels.set(l.name.toLowerCase(), l.id);
    return { id: team.id, labels };
  }

  private toRef(issue: LinearIssue): TicketRef {
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      provider: this.provider,
      state: issue.state?.name ?? 'Triage',
      title: issue.title,
    };
  }

  /** Create the issue on the configured team, mapping severity to priority. */
  async createIncidentTicket(input: TicketInput): Promise<TicketRef> {
    const team = await this.resolveTeam();
    // Only labels that already exist are attached; Firefighter does not create
    // workspace-level labels as a side effect of an incident.
    const labelIds = (input.labels ?? [])
      .map((name) => team.labels.get(name.toLowerCase()))
      .filter((id): id is string => Boolean(id));
    const data = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
      `mutation CreateIssue($input: IssueCreateInput!) {
         issueCreate(input: $input) {
           success
           issue { id identifier url title state { name } }
         }
       }`,
      {
        input: {
          teamId: team.id,
          title: input.title,
          description: input.description,
          priority: input.priority ?? severityToPriority(input.severity),
          ...(labelIds.length ? { labelIds } : {}),
        },
      },
    );
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue) throw new Error('Linear issueCreate did not return an issue');
    return this.toRef(issue);
  }

  /** Update the description and/or move the issue to a named workflow state. */
  async updateTicket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef> {
    const update: Record<string, unknown> = {};
    if (typeof patch.description === 'string') update.description = patch.description;

    if (patch.state) {
      const current = await this.gql<{
        issue: { id: string; team: { states: { nodes: { id: string; name: string }[] } } } | null;
      }>(
        `query IssueStates($id: String!) {
           issue(id: $id) { id team { states(first: 50) { nodes { id name } } } }
         }`,
        { id },
      );
      const states = current.issue?.team?.states?.nodes ?? [];
      const wanted = patch.state.toLowerCase();
      const match = states.find((s) => s.name.toLowerCase() === wanted);
      if (!match) {
        throw new Error(
          `Linear workflow state "${patch.state}" not found on this team (have: ${states.map((s) => s.name).join(', ')})`,
        );
      }
      update.stateId = match.id;
    }

    const data = await this.gql<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) {
           success
           issue { id identifier url title state { name } }
         }
       }`,
      { id, input: update },
    );
    const issue = data.issueUpdate?.issue;
    if (!data.issueUpdate?.success || !issue) throw new Error('Linear issueUpdate did not return an issue');
    return this.toRef(issue);
  }

  /** Add a comment to the issue. */
  async addComment(id: string, body: string): Promise<void> {
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: id, body } },
    );
    if (!data.commentCreate?.success) throw new Error('Linear commentCreate failed');
  }
}

// ---------------------------------------------------------------------------
// Jira (real REST v3 API, ADF bodies)
//
// v3 is stricter than it looks, and every rule encoded below is one that
// answers HTTP 400 rather than degrading quietly: rich text must be Atlassian
// Document Format and never Markdown, `summary` is single-line and capped at
// 255 characters, labels may not contain whitespace, and a status is a
// *transition* rather than a field that can be PUT.
// ---------------------------------------------------------------------------

/** A mark on an ADF text node. `link` carries its target in `attrs.href`. */
interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/**
 * Jira caps a rich-text field at 32,767 characters. The ticket body is bounded
 * long before that, but a pathological stack trace must not be what turns a
 * successful investigation into a failed write.
 */
const ADF_MAX_CHARS = 30_000;

/** Container nodes that ADF rejects when they end up with no children. */
const ADF_REQUIRES_CONTENT = new Set(['heading', 'bulletList', 'listItem', 'blockquote', 'codeBlock']);

/**
 * One pass over the inline markdown `buildTicketDescription` actually emits:
 * links, inline code, bold, and emphasis. Ordered so that the earliest match
 * wins and a `[text](url)` inside a code span stays literal.
 */
const INLINE_PATTERN = /\[([^\]\n]+)\]\(([^()\s]*)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w`*])_([^_\n]+)_(?![\w])/g;

/** `err.message` for an Error, its string form otherwise (already redacted). */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Inline markdown -> ADF text nodes with marks. Empty text nodes are illegal. */
function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  const push = (value: string, marks?: AdfMark[]): void => {
    if (!value) return; // ADF rejects a text node whose `text` is empty
    nodes.push(marks && marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value });
  };

  let last = 0;
  for (const m of text.matchAll(INLINE_PATTERN)) {
    const token = m[0] ?? '';
    const idx = m.index ?? 0;
    push(text.slice(last, idx));
    const linkText = m[1];
    const href = m[2];
    const code = m[3];
    const bold = m[4];
    const emphasis = m[5];
    if (linkText) {
      // `[#151]()` happens when a PR has no URL yet; a link mark with an empty
      // href is invalid ADF, so it degrades to plain text instead.
      push(linkText, href ? [{ type: 'link', attrs: { href } }] : undefined);
    } else if (code) {
      push(code, [{ type: 'code' }]);
    } else if (bold) {
      push(bold, [{ type: 'strong' }]);
    } else if (emphasis) {
      push(emphasis, [{ type: 'em' }]);
    } else {
      push(token);
    }
    last = idx + token.length;
  }
  push(text.slice(last));
  return nodes;
}

/** Drop empty text nodes and childless containers so the doc is always valid. */
function sanitiseAdf(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes ?? []) {
    if (!node || typeof node.type !== 'string' || !node.type) continue;
    if (node.type === 'text') {
      if (typeof node.text === 'string' && node.text.length > 0) out.push(node);
      continue;
    }
    if (!node.content) {
      out.push(node);
      continue;
    }
    const content = sanitiseAdf(node.content);
    if (!content.length && ADF_REQUIRES_CONTENT.has(node.type)) continue;
    out.push({ ...node, content });
  }
  return out;
}

/** Last-resort document: the text as plain paragraphs, split on blank lines. */
function plainAdfDoc(text: string): AdfDoc {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length > 0)
    .map((block) => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }) satisfies AdfNode);
  return { type: 'doc', version: 1, content: paragraphs.length ? paragraphs : [{ type: 'paragraph' }] };
}

/**
 * Convert the Markdown ticket body into an ADF document.
 *
 * Handles exactly what `buildTicketDescription` emits — ATX headings, `-`/`*`
 * bullets, fenced code blocks, `>` quotes, `---` rules, blank lines and
 * paragraphs, with inline bold, code, emphasis and links. Anything unrecognised
 * becomes a paragraph, and a conversion that somehow throws degrades to plain
 * text: a ticket with a flat body beats no ticket at all.
 */
function markdownToAdf(markdown: string): AdfDoc {
  const source = truncate(typeof markdown === 'string' ? markdown : '', ADF_MAX_CHARS);
  try {
    const content = sanitiseAdf(convertMarkdown(source));
    return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph' }] };
  } catch (err) {
    log.warn(`jira ADF conversion fell back to plain text: ${errorText(err)}`);
    return plainAdfDoc(source);
  }
}

/** The block-level scan behind `markdownToAdf`. */
function convertMarkdown(markdown: string): AdfNode[] {
  const lines = markdown.split('\n');
  const content: AdfNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    content.push({ type: 'paragraph', content: inlineToAdf(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushBullets = (): void => {
    if (!bullets.length) return;
    content.push({
      type: 'bulletList',
      content: bullets.map((b) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inlineToAdf(b) }],
      })),
    });
    bullets = [];
  };
  const flushQuote = (): void => {
    if (!quote.length) return;
    content.push({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: inlineToAdf(quote.join(' ')) }],
    });
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushBullets();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      // An empty codeBlock is invalid ADF, hence the single-space floor.
      content.push({ type: 'codeBlock', content: [{ type: 'text', text: body.join('\n') || ' ' }] });
      continue;
    }
    if (!trimmed) {
      flushAll();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      content.push({ type: 'rule' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      content.push({
        type: 'heading',
        attrs: { level: Math.min(6, (heading[1] ?? '#').length) },
        content: inlineToAdf(heading[2] ?? ''),
      });
      continue;
    }
    const blockquote = /^>\s?(.*)$/.exec(trimmed);
    if (blockquote) {
      flushParagraph();
      flushBullets();
      quote.push(blockquote[1] ?? '');
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      flushQuote();
      bullets.push(bullet[1] ?? '');
      continue;
    }
    flushBullets();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();
  return content;
}

// --- field hygiene ---------------------------------------------------------

/** Jira's hard limit on `summary`; exceeding it is a 400, not a truncation. */
const JIRA_SUMMARY_MAX = 255;
/** Jira's hard limit on a single label. */
const JIRA_LABEL_MAX = 255;

/**
 * Firefighter titles embed a Sentry error string, which is routinely longer
 * than 255 characters and may carry newlines — both of which Jira rejects.
 */
function jiraSummary(title: string): string {
  return truncate(oneLine(orElse(title, 'Incident')), JIRA_SUMMARY_MAX);
}

/**
 * Jira 400s on a label containing whitespace, so `checkout service` becomes
 * `checkout-service`. Empties are dropped and duplicates collapsed.
 */
function jiraLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels ?? []) {
    if (typeof raw !== 'string') continue;
    const label = raw
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, JIRA_LABEL_MAX);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Severity -> Jira's default priority scheme. */
function severityToJiraPriority(severity: Severity): string {
  switch (severity) {
    case 'sev1':
      return 'Highest';
    case 'sev2':
      return 'High';
    default:
      return 'Medium';
  }
}

// --- HTTP ------------------------------------------------------------------

const JIRA_TIMEOUT_MS = 20_000;
const JIRA_MAX_ATTEMPTS = 3; // one attempt + two retries
const JIRA_BACKOFF_BASE_MS = 300;
/** Never park an incident response behind a long `Retry-After`. */
const JIRA_MAX_BACKOFF_MS = 5_000;

/** Deterministic exponential backoff — no jitter, so runs stay reproducible. */
function jiraBackoffMs(attempt: number): number {
  return Math.min(JIRA_BACKOFF_BASE_MS * 2 ** (attempt - 1), JIRA_MAX_BACKOFF_MS);
}

/** `Retry-After` as delta-seconds or an HTTP-date, clamped to the backoff cap. */
function retryAfterMs(value: string | null): number | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, JIRA_MAX_BACKOFF_MS);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(at - nowMs(), 0), JIRA_MAX_BACKOFF_MS);
}

/**
 * One Jira request: JSON in, JSON out, with an AbortController wired to the
 * fetch itself so a hung socket cannot stall the run, and bounded retries on
 * 429/5xx/transport errors that honour `Retry-After`. 4xx comes back to the
 * caller so it can raise a diagnosable, credential-free domain error.
 */
async function jiraRequest(
  method: string,
  url: string,
  body: unknown | null,
  headers: Record<string, string>,
  secrets: string[],
): Promise<HttpResponse> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= JIRA_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JIRA_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < JIRA_MAX_ATTEMPTS) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? jiraBackoffMs(attempt);
        log.warn(`jira ${method} ${res.status} — retry ${attempt}/${JIRA_MAX_ATTEMPTS - 1} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return { status: res.status, body: text };
    } catch (err) {
      lastError = errorText(err);
      if (attempt < JIRA_MAX_ATTEMPTS) {
        log.warn(
          `jira ${method} failed (${redact(lastError, secrets)}) — retry ${attempt}/${JIRA_MAX_ATTEMPTS - 1}`,
        );
        await sleep(jiraBackoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(redact(`Jira ${method} ${url} failed after ${JIRA_MAX_ATTEMPTS} attempts: ${lastError}`, secrets));
}

/** The error envelope Jira returns on every 4xx. */
interface JiraErrorBody {
  errorMessages?: string[];
  errors?: Record<string, unknown>;
  message?: string;
}

/** Best-effort parse of Jira's error envelope; never throws. */
function parseJiraError(body: string): JiraErrorBody {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as JiraErrorBody) : {};
  } catch {
    return {};
  }
}

/**
 * Jira's own complaint, flattened.
 *
 * This is the single most valuable thing in a failure — "Field 'priority'
 * cannot be set. It is not on the appropriate screen" is the difference
 * between a five-second fix and an afternoon — so it is always surfaced, while
 * the credentials never are.
 */
function jiraErrorDetail(body: string): string {
  const parsed = parseJiraError(body);
  const parts: string[] = [];
  for (const m of parsed.errorMessages ?? []) {
    if (typeof m === 'string' && m.trim()) parts.push(m.trim());
  }
  for (const [field, msg] of Object.entries(parsed.errors ?? {})) {
    parts.push(`${field}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (!parts.length && typeof parsed.message === 'string' && parsed.message.trim()) parts.push(parsed.message.trim());
  return parts.length ? parts.join('; ') : truncate(body, 300) || 'no response body';
}

/** The field names Jira named in `errors` (e.g. `priority`, `issuetype`). */
function jiraRejectedFields(body: string): string[] {
  return Object.keys(parseJiraError(body).errors ?? {});
}

// --- client ----------------------------------------------------------------

interface JiraCreateResponse {
  id: string;
  key: string;
  self: string;
}

interface JiraIssueResponse {
  id: string;
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

interface JiraTransition {
  id: string;
  name?: string;
  to?: { name?: string };
}

interface JiraMyself {
  accountId?: string;
  displayName?: string;
}

/** Jira's default issue type for a defect, and the fallback when it is absent. */
const JIRA_ISSUE_TYPE = 'Bug';
const JIRA_FALLBACK_ISSUE_TYPE = 'Task';
/** Optional create fields worth dropping rather than failing the write over. */
const JIRA_DROPPABLE_FIELDS = new Set(['priority', 'labels']);
/** Bounded remediation passes over a rejected create. */
const JIRA_FIELD_FALLBACKS = 2;
/** Status shown when Jira's own value could not be read back. */
const JIRA_DEFAULT_STATE = 'To Do';

/** Normalise a status/transition name: case- and separator-insensitive. */
function normaliseStatus(name: string): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find the transition that reaches `wanted`.
 *
 * Matching on the *target* status first is what makes `In Progress` work: the
 * transition that reaches it is usually called something else entirely, such as
 * `Start Progress`.
 */
function matchTransition(transitions: JiraTransition[], wanted: string): JiraTransition | null {
  const want = normaliseStatus(wanted);
  if (!want) return null;
  const byTarget = transitions.find((t) => normaliseStatus(t.to?.name ?? '') === want);
  if (byTarget) return byTarget;
  const byName = transitions.find((t) => normaliseStatus(t.name ?? '') === want);
  if (byName) return byName;
  return (
    transitions.find(
      (t) => normaliseStatus(t.to?.name ?? '').includes(want) || normaliseStatus(t.name ?? '').includes(want),
    ) ?? null
  );
}

/** Jira Cloud REST v3 with Basic auth (base64 of `email:apiToken`). */
class JiraClient implements TicketClient {
  readonly provider = 'jira';
  /** The credential preflight runs once per client, not once per call. */
  private preflight: Promise<void> | null = null;

  constructor(private readonly cfg: Config) {}

  /**
   * The site root. A URL copied out of a browser arrives with a trailing slash
   * and sometimes without a scheme; neither is worth failing an incident over.
   */
  private get base(): string {
    const raw = orElse(this.cfg.tickets.jiraBaseUrl, '');
    if (!raw) throw new Error('JIRA_BASE_URL is not configured (e.g. https://your-site.atlassian.net)');
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return withScheme.replace(/\/+$/, '');
  }

  /** Jira Cloud project keys are uppercase; accept a lowercase one anyway. */
  private get projectKey(): string {
    const key = orElse(this.cfg.tickets.jiraProjectKey, '').toUpperCase();
    if (!key) throw new Error('JIRA_PROJECT_KEY is not configured (e.g. INC)');
    return key;
  }

  /**
   * Basic auth, plus the two strings that must never escape this module: the
   * API token and the base64 header derived from it.
   */
  private get auth(): { header: Record<string, string>; secrets: string[] } {
    const token = orElse(this.cfg.tickets.jiraApiToken, '');
    const email = orElse(this.cfg.tickets.jiraEmail, '');
    if (!token) throw new Error('JIRA_API_TOKEN is not configured');
    if (!email) {
      throw new Error('JIRA_EMAIL is not configured — Jira Cloud Basic auth is base64(email:apiToken)');
    }
    const basic = Buffer.from(`${email}:${token}`).toString('base64');
    return { header: { authorization: `Basic ${basic}` }, secrets: [token, basic] };
  }

  private issueUrl(key: string, suffix = ''): string {
    return `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}${suffix}`;
  }

  /** Describe a non-2xx response without ever quoting a credential. */
  private describe(res: HttpResponse, what: string): string {
    if (res.status === 401 || res.status === 403) {
      return `Jira rejected the credentials (HTTP ${res.status}) while ${what} — check JIRA_EMAIL and JIRA_API_TOKEN`;
    }
    if (res.status === 404) {
      return `Jira returned 404 while ${what} — check JIRA_BASE_URL and JIRA_PROJECT_KEY (${jiraErrorDetail(res.body)})`;
    }
    return `Jira ${what} failed (HTTP ${res.status}): ${jiraErrorDetail(res.body)}`;
  }

  /** Raise a clear, credential-free error for any non-2xx response. */
  private assertOk(res: HttpResponse, what: string, secrets: string[]): void {
    if (res.status >= 200 && res.status < 300) return;
    throw new Error(redact(this.describe(res, what), secrets));
  }

  /**
   * Cheap credential check before the first write.
   *
   * `GET /myself` costs one request and collapses the three ways Jira is
   * usually misconfigured — wrong site, a password instead of an API token, an
   * email that does not own the token — into one precise error at the top of
   * the run, instead of an opaque 400 on the create call.
   */
  private async ensureCredentials(): Promise<void> {
    if (!this.preflight) this.preflight = this.checkCredentials();
    await this.preflight;
  }

  private async checkCredentials(): Promise<void> {
    const { header, secrets } = this.auth;
    const res = await jiraRequest('GET', `${this.base}/rest/api/3/myself`, null, header, secrets);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Jira rejected the credentials for ${this.base} (HTTP ${res.status}) — JIRA_API_TOKEN must be an API token ` +
          '(id.atlassian.com/manage-profile/security/api-tokens), not a password, and JIRA_EMAIL must be the account that owns it',
      );
    }
    if (res.status === 404) {
      throw new Error(
        `${this.base} did not serve /rest/api/3/myself — JIRA_BASE_URL must be the Jira Cloud site root, ` +
          'e.g. https://your-site.atlassian.net',
      );
    }
    this.assertOk(res, 'verifying the credentials', secrets);
    let who = 'the configured account';
    try {
      who = orElse(parseJson<JiraMyself>(res.body, 'Jira myself').displayName, who);
    } catch {
      /* authenticated is all we needed to learn */
    }
    log.info(`jira authenticated as ${who} on ${this.base}`);
  }

  /** Create an issue in the configured project with an ADF description. */
  async createIncidentTicket(input: TicketInput): Promise<TicketRef> {
    const { header, secrets } = this.auth;
    await this.ensureCredentials();

    const summary = jiraSummary(input.title);
    const labels = jiraLabels(input.labels ?? []);
    const fields: Record<string, unknown> = {
      project: { key: this.projectKey },
      summary,
      issuetype: { name: JIRA_ISSUE_TYPE },
      description: markdownToAdf(input.description),
      ...(labels.length ? { labels } : {}),
      priority: { name: severityToJiraPriority(input.severity) },
    };

    const res = await this.createWithFieldFallback(fields, header, secrets);
    this.assertOk(res, 'creating the issue', secrets);
    const created = parseJson<JiraCreateResponse>(res.body, 'Jira issue create');
    // `key` (INC-42) is the human-facing identifier and the one /browse/ wants;
    // `id` is an opaque number that produces a dead link.
    const key = orElse(created.key, '');
    if (!key) throw new Error('Jira issue create returned no issue key');
    log.info(`ticket (jira) created ${key} in ${this.projectKey}`);
    return {
      id: key,
      identifier: key,
      url: `${this.base}/browse/${key}`,
      provider: this.provider,
      state: await this.readStatus(key, header, secrets),
      title: summary,
    };
  }

  /**
   * POST the issue, retrying without whichever optional fields Jira named.
   *
   * Team-managed projects routinely have no `priority` on the create screen and
   * some have no `Bug` issue type; both answer 400 identifying the field. An
   * incident ticket without a priority beats no incident ticket.
   */
  private async createWithFieldFallback(
    fields: Record<string, unknown>,
    header: Record<string, string>,
    secrets: string[],
  ): Promise<HttpResponse> {
    const url = `${this.base}/rest/api/3/issue`;
    const current = { ...fields };
    let res = await jiraRequest('POST', url, { fields: current }, header, secrets);
    for (let pass = 0; res.status === 400 && pass < JIRA_FIELD_FALLBACKS; pass++) {
      const rejected = jiraRejectedFields(res.body);
      let changed = false;
      for (const field of rejected) {
        if (JIRA_DROPPABLE_FIELDS.has(field) && field in current) {
          delete current[field];
          log.warn(`jira rejected the "${field}" field on create — retrying without it`);
          changed = true;
        }
      }
      const issuetype = current.issuetype as { name?: string } | undefined;
      if (rejected.includes('issuetype') && issuetype?.name === JIRA_ISSUE_TYPE) {
        current.issuetype = { name: JIRA_FALLBACK_ISSUE_TYPE };
        log.warn(
          `jira project ${this.projectKey} has no "${JIRA_ISSUE_TYPE}" issue type — retrying as "${JIRA_FALLBACK_ISSUE_TYPE}"`,
        );
        changed = true;
      }
      if (!changed) break;
      res = await jiraRequest('POST', url, { fields: current }, header, secrets);
    }
    return res;
  }

  /** Best effort: the issue exists, so not knowing its status is not fatal. */
  private async readStatus(key: string, header: Record<string, string>, secrets: string[]): Promise<string> {
    try {
      const res = await jiraRequest('GET', this.issueUrl(key, '?fields=status,summary'), null, header, secrets);
      if (res.status >= 200 && res.status < 300) {
        const issue = parseJson<JiraIssueResponse>(res.body, 'Jira issue read');
        return orElse(issue.fields?.status?.name, JIRA_DEFAULT_STATE);
      }
    } catch {
      /* fall through to the default */
    }
    return JIRA_DEFAULT_STATE;
  }

  /**
   * Apply a description and/or a status change.
   *
   * Deliberately total: a ticket that cannot be edited or transitioned must not
   * fail the incident response — the revert PR and the Slack update matter far
   * more than the ticket's column — so each part is attempted independently and
   * failures are logged rather than thrown.
   */
  async updateTicket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef> {
    const { header, secrets } = this.auth;
    const key = orElse(id, '');
    if (!key) throw new Error('Jira updateTicket requires an issue key');

    if (typeof patch.description === 'string') {
      try {
        const res = await jiraRequest(
          'PUT',
          this.issueUrl(key),
          { fields: { description: markdownToAdf(patch.description) } },
          header,
          secrets,
        );
        this.assertOk(res, `updating ${key}`, secrets);
      } catch (err) {
        log.warn(`jira ${key}: description update failed: ${errorText(err)}`);
      }
    }
    if (patch.state) await this.transition(key, patch.state, header, secrets);
    return this.readRef(key, patch, header, secrets);
  }

  /**
   * Move the issue's status.
   *
   * Jira cannot PUT a status: it is a transition, and only the transitions the
   * workflow currently offers are legal. When none reaches the requested state
   * that is a workflow fact, not an error — say so and carry on.
   */
  private async transition(
    key: string,
    state: string,
    header: Record<string, string>,
    secrets: string[],
  ): Promise<void> {
    try {
      const list = await jiraRequest('GET', this.issueUrl(key, '/transitions'), null, header, secrets);
      this.assertOk(list, `reading transitions for ${key}`, secrets);
      const transitions =
        parseJson<{ transitions?: JiraTransition[] }>(list.body, 'Jira transitions').transitions ?? [];
      const match = matchTransition(transitions, state);
      if (!match) {
        const available = transitions.map((t) => t.name ?? t.to?.name ?? t.id).join(', ') || 'none';
        log.warn(`jira ${key}: no transition reaches "${state}" (available: ${available}) — leaving the status as it is`);
        return;
      }
      const res = await jiraRequest(
        'POST',
        this.issueUrl(key, '/transitions'),
        { transition: { id: match.id } },
        header,
        secrets,
      );
      this.assertOk(res, `transitioning ${key} to "${state}"`, secrets);
      log.info(`jira ${key} transitioned to "${state}" via "${orElse(match.name, match.id)}"`);
    } catch (err) {
      log.warn(`jira ${key}: status change to "${state}" failed: ${errorText(err)}`);
    }
  }

  /** Read the issue back, falling back to what we already know. */
  private async readRef(
    key: string,
    patch: { state?: string; description?: string },
    header: Record<string, string>,
    secrets: string[],
  ): Promise<TicketRef> {
    const ref: TicketRef = {
      id: key,
      identifier: key,
      url: `${this.base}/browse/${key}`,
      provider: this.provider,
      state: orElse(patch.state, JIRA_DEFAULT_STATE),
      title: key,
    };
    try {
      const res = await jiraRequest('GET', this.issueUrl(key, '?fields=status,summary'), null, header, secrets);
      if (res.status >= 200 && res.status < 300) {
        const issue = parseJson<JiraIssueResponse>(res.body, 'Jira issue read');
        const actual = orElse(issue.key, key);
        return {
          ...ref,
          id: actual,
          identifier: actual,
          url: `${this.base}/browse/${actual}`,
          state: orElse(issue.fields?.status?.name, ref.state),
          title: orElse(issue.fields?.summary, key),
        };
      }
      log.warn(`jira ${key}: could not read the issue back (HTTP ${res.status})`);
    } catch (err) {
      log.warn(`jira ${key}: could not read the issue back: ${errorText(err)}`);
    }
    return ref;
  }

  /**
   * Add an ADF comment. A comment annotates the incident rather than driving
   * it, so a failure here is logged and swallowed.
   */
  async addComment(id: string, body: string): Promise<void> {
    try {
      const { header, secrets } = this.auth;
      const res = await jiraRequest(
        'POST',
        this.issueUrl(id, '/comment'),
        { body: markdownToAdf(body) },
        header,
        secrets,
      );
      this.assertOk(res, `commenting on ${id}`, secrets);
    } catch (err) {
      log.warn(`jira ${id}: comment not added: ${errorText(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * The bridge tables are keyed by run. Look up the run for this incident, and
 * fall back to the deterministic run id the repo layer would have minted.
 */
function runIdFor(incidentId: string): string {
  try {
    const run = getRunByIncident(incidentId);
    if (run) return run.id;
  } catch {
    /* DB not open (unit test): fall through to the derived id. */
  }
  return `run_${shortHash(incidentId, 12)}`;
}

/** `PENDING-INC-123` -> `INC-123`; anything else is treated as its own key. */
function incidentIdFromTicketId(id: string): string {
  return id.startsWith('PENDING-') ? id.slice('PENDING-'.length) : id;
}

/**
 * Records the ticket as a durable bridge intent for an external connector to
 * create, and returns a placeholder reference immediately. The connector calls
 * `resolveBridgeIntent()` with the real identifier once it exists.
 */
class BridgeTicketClient implements TicketClient {
  readonly provider = 'bridge';

  /** Queue the create intent and return the `PENDING-<incidentId>` reference. */
  async createIncidentTicket(input: TicketInput): Promise<TicketRef> {
    const incidentId = orElse(input.incidentId, 'unknown-incident');
    try {
      upsertBridgeIntent({
        id: `ticket:${incidentId}`,
        runId: runIdFor(incidentId),
        incidentId,
        kind: 'ticket_create',
        payload: {
          title: input.title,
          description: input.description,
          severity: input.severity,
          labels: input.labels ?? [],
          priority: input.priority ?? severityToPriority(input.severity),
        },
      });
    } catch (err) {
      log.warn(`bridge intent not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      id: `PENDING-${incidentId}`,
      identifier: `PENDING-${incidentId}`,
      url: '',
      provider: this.provider,
      state: 'pending-bridge',
      title: input.title,
    };
  }

  /** Queue the update intent; the reference stays pending until the connector resolves it. */
  async updateTicket(id: string, patch: { state?: string; description?: string }): Promise<TicketRef> {
    const incidentId = incidentIdFromTicketId(id);
    try {
      upsertBridgeIntent({
        id: `ticket-update:${id}:${payloadHash(patch)}`,
        runId: runIdFor(incidentId),
        incidentId,
        kind: 'ticket_update',
        payload: { ticketId: id, ...patch },
      });
    } catch (err) {
      log.warn(`bridge intent not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      id,
      identifier: id,
      url: '',
      provider: this.provider,
      state: orElse(patch.state, 'pending-bridge'),
      title: id,
    };
  }

  /** Queue the comment intent. */
  async addComment(id: string, body: string): Promise<void> {
    const incidentId = incidentIdFromTicketId(id);
    try {
      upsertBridgeIntent({
        id: `ticket-comment:${id}:${payloadHash({ body })}`,
        runId: runIdFor(incidentId),
        incidentId,
        kind: 'ticket_comment',
        payload: { ticketId: id, body },
      });
    } catch (err) {
      log.warn(`bridge intent not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Select the ticketing implementation from config, degrading to the mock when
 * a real provider is configured without credentials (see `effectiveProviders`).
 *
 * @param cfg Optional config override; defaults to the process config.
 */
export function getTicketClient(cfg: Config = defaultConfig): TicketClient {
  const provider = effectiveProviders(cfg).tickets;
  switch (provider) {
    case 'linear':
      return new LinearClient(cfg);
    case 'jira':
      return new JiraClient(cfg);
    case 'bridge':
      return new BridgeTicketClient();
    case 'mock':
    default:
      return new MockLinearClient(cfg);
  }
}
