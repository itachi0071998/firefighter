/**
 * Slack adapter.
 *
 * One interface, four implementations, selected by config:
 *
 *   mock     - renders the real Block Kit payload and persists it to
 *              <dataDir>/slack-outbox/ so the dashboard and the demo can show
 *              the exact message that would have been posted. No network.
 *   webhook  - POSTs the payload to an incoming webhook URL.
 *   bot      - POSTs to chat.postMessage with a bot token.
 *   bridge   - records a durable bridge intent for an external connector to
 *              deliver. Never touches the network, never blocks the workflow.
 *
 * Message rendering (`buildSlackPayload`) is pure and shared by all four, so
 * what the dashboard shows is byte-for-byte what Slack would receive.
 *
 * Idempotency is deliberately NOT implemented here: every mutating tool is
 * wrapped by `withIdempotency()` in the tool registry. These clients are
 * side-effect-honest — calling one twice really does post twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Config, config as defaultConfig, effectiveProviders } from '../config.ts';
import {
  Evidence,
  Incident,
  Investigation,
  LintResult,
  PullRequestRef,
  SlackMessageRef,
  SuspectScore,
  TestRunResult,
  TicketRef,
} from '../types.ts';
import { getRunByIncident, upsertBridgeIntent } from '../db/repo.ts';
import { nowIso } from '../util/clock.ts';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';

const log = logger('slack');

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface SlackUpdateInput {
  channel: string;
  incident: Incident;
  investigation: Investigation;
  ticket?: TicketRef | null;
  revertPr?: PullRequestRef | null;
  fixPr?: PullRequestRef | null;
  tests?: TestRunResult | null;
  lint?: LintResult | null;
  blocked?: string | null;
}

export interface SlackPayload {
  text: string;
  blocks: unknown[];
}

export interface SlackClient {
  readonly provider: string;
  postIncidentUpdate(input: SlackUpdateInput): Promise<SlackMessageRef>;
}

// ---------------------------------------------------------------------------
// Rendering helpers (pure)
// ---------------------------------------------------------------------------

/** A rendered line: plain fallback text plus an optional link-bearing variant. */
interface Line {
  text: string;
  rich?: string;
}

const LOCK_LINE = ':lock: Human approval required before merge — Firefighter never merges.';

/** Trim to `max` characters, appending an ellipsis when anything was cut. */
function truncate(value: string, max: number): string {
  const s = value.trim();
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Collapse newlines/repeated whitespace so a value is safe on a single line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Return `value` when it is a usable non-empty string, else `fallback`. */
function orElse(value: string | null | undefined, fallback: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : fallback;
}

/** Render a 0..1 confidence as a whole-number percentage, e.g. `92%`. */
function pct(confidence: number): string {
  const n = Number.isFinite(confidence) ? confidence : 0;
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

/** Human label for a suspect: `PR #142 — title`, or the sha when there is no PR. */
function suspectLabel(s: SuspectScore): string {
  const title = orElse(s.title, 'untitled change');
  if (s.prNumber !== null && s.prNumber !== undefined) return `PR #${s.prNumber} — ${oneLine(title)}`;
  const sha = orElse(s.sha, '').slice(0, 7);
  return sha ? `commit ${sha} — ${oneLine(title)}` : oneLine(title);
}

/** `revert`/`fix` PR label, e.g. `Revert PR #151`. */
function prLabel(pr: PullRequestRef): string {
  const kind = pr.kind === 'revert' ? 'Revert' : 'Fix';
  return `${kind} PR #${pr.number}`;
}

/** Slack mrkdwn link, falling back to bare text when there is no URL. */
function link(label: string, url: string | null | undefined): string {
  const u = orElse(url, '');
  return u ? `<${u}|${label}>` : label;
}

/** Rank evidence by its actual contribution (weight x |score|), strongest first. */
function rankEvidence(evidence: Evidence[]): Evidence[] {
  return [...(evidence ?? [])]
    .filter((e) => e && typeof e.description === 'string' && e.description.trim().length > 0)
    .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score));
}

/** `183/183 tests passed`, or an explicit failure count. Null when no run happened. */
function testsPhrase(tests: TestRunResult | null | undefined): string | null {
  if (!tests) return null;
  const total = Number.isFinite(tests.total) ? tests.total : 0;
  const passed = Number.isFinite(tests.passed) ? tests.passed : 0;
  const failed = Number.isFinite(tests.failed) ? tests.failed : 0;
  if (tests.ok) return `${passed}/${total} tests passed`;
  return `${failed}/${total} tests FAILED`;
}

/** `lint clean`, or the error/warning counts. Null when lint never ran. */
function lintPhrase(lint: LintResult | null | undefined): string | null {
  if (!lint) return null;
  if (lint.ok && lint.errors === 0 && lint.warnings === 0) return 'lint clean';
  if (lint.ok) return `lint ok (${lint.warnings} warning${lint.warnings === 1 ? '' : 's'})`;
  return `lint ${lint.errors} error${lint.errors === 1 ? '' : 's'}, ${lint.warnings} warning${lint.warnings === 1 ? '' : 's'}`;
}

/**
 * Build the incident update as both a Block Kit payload and a plain-text
 * fallback.
 *
 * Every optional input may be absent: an inconclusive investigation, no
 * ticket, no revert PR, no fix PR, no test or lint run. Lines that have no
 * data are omitted rather than rendered with a placeholder, so the string
 * `undefined` can never appear in the output. When `input.blocked` is set the
 * message states what is blocked and why and never claims success.
 *
 * @param input Incident, investigation and whatever artefacts exist so far.
 * @returns `{ text, blocks }` — `text` is the notification fallback.
 */
export function buildSlackPayload(input: SlackUpdateInput): SlackPayload {
  const incident = input.incident;
  const inv = input.investigation;
  const blocked = orElse(input.blocked, '');

  const title = orElse(incident?.title, 'Untitled incident');
  const incidentId = orElse(incident?.id, 'unknown-incident');
  const severity = orElse(incident?.severity, 'sev3');
  const service = orElse(incident?.service, 'unknown-service');

  const headline = `:fire: *Incident: ${title}*  (${incidentId}, ${severity})`;
  const blockedLine = blocked ? `:warning: *Blocked — human action required:* ${oneLine(blocked)}` : null;

  // Body lines only; the headline, the blocked warning and the lock line are
  // rendered as their own Block Kit blocks.
  const lines: Line[] = [];

  // --- suspected cause -----------------------------------------------------
  const suspect = inv?.suspect ?? null;
  const topCandidate = suspect ?? (inv?.rankedSuspects?.length ? inv.rankedSuspects[0] : null);
  const inconclusive = !suspect || inv?.inconclusive === true;

  if (inconclusive) {
    lines.push({
      text: '*Suspected cause:* Inconclusive — no recent change cleared the confidence floor; human triage required.',
    });
    if (topCandidate) {
      lines.push({
        text: `*Highest-scoring candidate (not blamed):* ${suspectLabel(topCandidate)} at ${pct(topCandidate.confidence)}`,
      });
    }
  } else {
    const verification = inv?.verification;
    if (verification?.verified) {
      const proven = verification.probes.find((p) => p.verdict === 'proven');
      lines.push({ text: `*Cause (proven):* ${suspectLabel(suspect)}` });
      lines.push({
        text:
          `*Verified by execution:* failure absent at \`${proven?.parentSha?.slice(0, 10)}\`, ` +
          `present at \`${verification.culpritSha?.slice(0, 10)}\` — re-ran the production request on both sides.`,
      });
      if (verification.overrodeRanking) {
        lines.push({
          text: `_Correlation first ranked #${verification.rankedPr}; execution disproved it._`,
        });
      }
    } else {
      lines.push({ text: `*Suspected cause:* ${suspectLabel(suspect)}` });
      lines.push({
        text: `*Confidence:* ${pct(suspect.confidence)}${verification ? ' (correlation only — not proven by execution)' : ''}`,
      });
    }
    const rootCause = oneLine(orElse(inv?.rootCause, ''));
    if (rootCause) lines.push({ text: `*Root cause:* ${truncate(rootCause, 320)}` });
  }

  // --- mitigation / remediation -------------------------------------------
  const mitigationFallback = oneLine(
    orElse(inv?.immediateMitigation, 'Manual mitigation required — no revert was prepared.'),
  );
  if (input.revertPr) {
    // Name BOTH pull requests: "Revert PR #6" alone reads as though #6 were the
    // thing being reverted, which is the opposite of what happened.
    const reverted = suspect?.prNumber != null ? ` — reverts #${suspect.prNumber}` : '';
    lines.push({
      text: `*Immediate mitigation:* ${prLabel(input.revertPr)}${reverted}`,
      rich: `*Immediate mitigation:* ${link(prLabel(input.revertPr), input.revertPr.url)}${reverted}`,
    });
  } else {
    lines.push({ text: `*Immediate mitigation:* ${truncate(mitigationFallback, 320)}` });
  }

  const remediationFallback = oneLine(
    orElse(inv?.permanentFix, 'Not available yet — permanent remediation needs a human.'),
  );
  if (input.fixPr) {
    lines.push({
      text: `*Permanent remediation:* ${prLabel(input.fixPr)}`,
      rich: `*Permanent remediation:* ${link(prLabel(input.fixPr), input.fixPr.url)}`,
    });
  } else {
    lines.push({ text: `*Permanent remediation:* ${truncate(remediationFallback, 320)}` });
  }

  // --- verification --------------------------------------------------------
  const verification = [testsPhrase(input.tests), lintPhrase(input.lint)].filter(
    (p): p is string => p !== null,
  );
  if (verification.length) {
    lines.push({ text: `*Verification:* ${verification.join(' · ')}` });
  }

  // --- ticket --------------------------------------------------------------
  if (input.ticket) {
    const label = orElse(input.ticket.identifier, orElse(input.ticket.id, 'ticket'));
    lines.push({
      text: `*Incident ticket:* ${label}`,
      rich: `*Incident ticket:* ${link(label, input.ticket.url)}`,
    });
  }

  // --- evidence ------------------------------------------------------------
  const evidence = topCandidate ? rankEvidence(topCandidate.evidence ?? []).slice(0, 3) : [];
  if (evidence.length) {
    lines.push({ text: '*Evidence:*' });
    for (const e of evidence) {
      const kind = orElse(e.kind, 'signal').replace(/_/g, ' ');
      lines.push({ text: `• ${kind} — ${truncate(oneLine(e.description), 220)}` });
    }
  }

  const text = [headline, ...(blockedLine ? [blockedLine] : []), ...lines.map((l) => l.text), LOCK_LINE].join(
    '\n',
  );

  // --- Block Kit -----------------------------------------------------------
  const body = lines.map((l) => l.rich ?? l.text).join('\n');
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`🔥 Incident: ${title}`, 150), emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${incidentId}*  |  *${severity.toUpperCase()}*  |  ${service}  |  detected ${orElse(
            incident?.detectedAt,
            'time unknown',
          )}`,
        },
      ],
    },
  ];

  if (blocked) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:warning: *Blocked — human action required*\n${oneLine(blocked)}` },
    });
  }

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(body, 2900) } });
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: LOCK_LINE }] });

  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/**
 * Slack-shaped message timestamp, e.g. `1757754000.001700`.
 *
 * The whole-second part comes from the incident detection time and the
 * micro-second part from a hash of the incident + channel, so the same
 * incident always renders the same `ts` — no clock, no randomness.
 */
function deterministicTs(incidentId: string, channel: string, detectedAt: string): string {
  const parsed = Date.parse(detectedAt);
  const seconds = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  const micros = parseInt(shortHash(`${incidentId}|${channel}`, 8), 16) % 1_000_000;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

/** Canonical permalink shape used by the mock/webhook clients. */
function permalinkFor(ts: string): string {
  return `https://app.slack.com/client/T00000000/C00000000/thread/${ts}`;
}

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

// ---------------------------------------------------------------------------
// HTTP helper: 15s timeout, two retries on 429/5xx
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3; // one attempt + two retries

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never let a token reach a log line, a timeline entry or an Error message. */
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
 * POST JSON with an AbortController timeout and two retries on 429/5xx or a
 * transport error. Non-retryable responses are returned to the caller so it
 * can produce a domain-specific error.
 */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  secrets: string[],
): Promise<HttpResponse> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        lastError = `HTTP ${res.status}`;
        log.warn(`slack POST ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      return { status: res.status, body: text };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        log.warn(`slack POST failed (${redact(lastError, secrets)}) — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(redact(`Slack request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`, secrets));
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

interface OutboxRecord {
  incidentId: string;
  channel: string;
  ts: string;
  permalink: string;
  payload: SlackPayload;
  renderedText: string;
  postedAt: string;
}

const FEED_RULE = '─'.repeat(78);

/**
 * Renders the message and writes it to `<dataDir>/slack-outbox/` instead of
 * calling Slack. One JSON file per incident (overwritten on a re-post) plus a
 * human-readable `feed.txt`, which is regenerated from those files so a
 * re-post replaces its entry rather than appending a duplicate.
 */
class MockSlackClient implements SlackClient {
  readonly provider = 'mock';
  private readonly dir: string;

  constructor(cfg: Config) {
    this.dir = path.join(cfg.dataDir, 'slack-outbox');
  }

  /** Render, persist to the outbox, and return the reference the workflow stores. */
  async postIncidentUpdate(input: SlackUpdateInput): Promise<SlackMessageRef> {
    const payload = buildSlackPayload(input);
    const incidentId = orElse(input.incident?.id, 'unknown-incident');
    const channel = orElse(input.channel, '#incidents');
    const ts = deterministicTs(incidentId, channel, orElse(input.incident?.detectedAt, ''));
    const record: OutboxRecord = {
      incidentId,
      channel,
      ts,
      permalink: permalinkFor(ts),
      payload,
      renderedText: payload.text,
      postedAt: nowIso(),
    };

    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      path.join(this.dir, `${safeFileName(incidentId)}.json`),
      JSON.stringify(record, null, 2) + '\n',
      'utf8',
    );
    this.rewriteFeed();

    log.info(`slack (mock) posted to ${channel} ts=${ts}`);
    return {
      ts,
      channel,
      permalink: record.permalink,
      provider: this.provider,
      text: payload.text,
    };
  }

  /** Rebuild feed.txt from the per-incident files: append-with-dedupe, by construction. */
  private rewriteFeed(): void {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const records: OutboxRecord[] = [];
    for (const f of files) {
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as OutboxRecord);
      } catch {
        /* a partially written file must not break the next post */
      }
    }
    records.sort((a, b) =>
      a.postedAt === b.postedAt ? a.incidentId.localeCompare(b.incidentId) : a.postedAt.localeCompare(b.postedAt),
    );
    const body = records
      .map((r) =>
        [
          FEED_RULE,
          `${r.channel}  ·  ${r.postedAt}  ·  ts=${r.ts}  ·  incident=${r.incidentId}`,
          r.permalink,
          FEED_RULE,
          r.renderedText,
          '',
        ].join('\n'),
      )
      .join('\n');
    fs.writeFileSync(path.join(this.dir, 'feed.txt'), body, 'utf8');
  }
}

/** Keep an incident id usable as a filename without losing its identity. */
function safeFileName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length ? cleaned : `incident_${shortHash(id, 8)}`;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Incoming-webhook delivery. Webhooks return `ok` rather than a message
 * timestamp, so the returned `ts` is the deterministic one — the reference
 * stays stable and the workflow's idempotency ledger stays meaningful.
 */
class WebhookSlackClient implements SlackClient {
  readonly provider = 'webhook';
  constructor(private readonly cfg: Config) {}

  /** POST the rendered payload to the configured webhook URL. */
  async postIncidentUpdate(input: SlackUpdateInput): Promise<SlackMessageRef> {
    const payload = buildSlackPayload(input);
    const url = this.cfg.slack.webhookUrl;
    if (!url) throw new Error('SLACK_WEBHOOK_URL is not configured');
    const res = await postJson(url, { text: payload.text, blocks: payload.blocks }, {}, [url]);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        redact(`Slack webhook rejected the message: HTTP ${res.status} ${truncate(res.body, 300)}`, [url]),
      );
    }
    const incidentId = orElse(input.incident?.id, 'unknown-incident');
    const channel = orElse(input.channel, this.cfg.slack.channel);
    const ts = deterministicTs(incidentId, channel, orElse(input.incident?.detectedAt, ''));
    return { ts, channel, permalink: permalinkFor(ts), provider: this.provider, text: payload.text };
  }
}

// ---------------------------------------------------------------------------
// Bot token
// ---------------------------------------------------------------------------

interface ChatPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/** `chat.postMessage` with a bot token (scope: chat:write). */
class BotSlackClient implements SlackClient {
  readonly provider = 'bot';
  constructor(private readonly cfg: Config) {}

  /** Post the message; a Slack `ok:false` is surfaced as an Error, never swallowed. */
  async postIncidentUpdate(input: SlackUpdateInput): Promise<SlackMessageRef> {
    const payload = buildSlackPayload(input);
    const token = this.cfg.slack.botToken;
    if (!token) throw new Error('SLACK_BOT_TOKEN is not configured');
    const channel = orElse(input.channel, this.cfg.slack.channel);
    const res = await postJson(
      'https://slack.com/api/chat.postMessage',
      { channel, text: payload.text, blocks: payload.blocks, unfurl_links: false },
      { authorization: `Bearer ${token}` },
      [token],
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(redact(`Slack API HTTP ${res.status}: ${truncate(res.body, 300)}`, [token]));
    }
    let parsed: ChatPostMessageResponse;
    try {
      parsed = JSON.parse(res.body) as ChatPostMessageResponse;
    } catch {
      throw new Error(`Slack API returned a non-JSON body: ${truncate(res.body, 200)}`);
    }
    if (!parsed.ok) {
      throw new Error(redact(`Slack API error: ${orElse(parsed.error, 'unknown')}`, [token]));
    }
    const ts = orElse(parsed.ts, deterministicTs(orElse(input.incident?.id, ''), channel, ''));
    const channelId = orElse(parsed.channel, channel);
    return {
      ts,
      channel: channelId,
      permalink: `https://app.slack.com/client/T00000000/${channelId}/thread/${ts}`,
      provider: this.provider,
      text: payload.text,
    };
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Records the message as a durable bridge intent for an external connector to
 * deliver, then returns immediately with `ts: 'pending'`. The connector calls
 * `resolveBridgeIntent()` once Slack has actually accepted it. Delivery
 * problems are the connector's business, so this never blocks the workflow.
 */
class BridgeSlackClient implements SlackClient {
  readonly provider = 'bridge';

  /** Persist the intent (best effort) and return the pending reference. */
  async postIncidentUpdate(input: SlackUpdateInput): Promise<SlackMessageRef> {
    const payload = buildSlackPayload(input);
    const incidentId = orElse(input.incident?.id, 'unknown-incident');
    const channel = orElse(input.channel, '#incidents');
    try {
      upsertBridgeIntent({
        id: `slack:${incidentId}`,
        runId: runIdFor(incidentId),
        incidentId,
        kind: 'slack_message',
        payload: { channel, text: payload.text, blocks: payload.blocks },
      });
    } catch (err) {
      // A bridge is an out-of-band delivery path; failing to queue it must not
      // fail the incident response.
      log.warn(`bridge intent not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      ts: 'pending',
      channel,
      permalink: '',
      provider: this.provider,
      text: payload.text,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Select the Slack implementation from config, degrading to the mock when a
 * real provider is configured without credentials (see `effectiveProviders`).
 *
 * @param cfg Optional config override; defaults to the process config.
 */
export function getSlackClient(cfg: Config = defaultConfig): SlackClient {
  const provider = effectiveProviders(cfg).slack;
  switch (provider) {
    case 'webhook':
      return new WebhookSlackClient(cfg);
    case 'bot':
      return new BotSlackClient(cfg);
    case 'bridge':
      return new BridgeSlackClient();
    case 'mock':
    default:
      return new MockSlackClient(cfg);
  }
}
