/**
 * Incident source adapter.
 *
 * Firefighter is triggered by a production incident. That incident either comes
 * from a real error tracker (Sentry) or from the built-in fixtures used by the
 * demo and the evals. Both satisfy one interface, so switching is an env change.
 *
 * Nothing here mutates anything: an incident source is strictly read-only.
 */
import { Config, config as defaultConfig, effectiveProviders } from '../config.ts';
import { Incident, LogLine, SampleRequest, Severity } from '../types.ts';
import { INCIDENT_FIXTURES, buildCheckoutIncident } from '../demo/incidents.ts';
import { logger } from '../util/log.ts';

const log = logger('incidents');

/** Sentry issue endpoints allow only a handful of requests per second. */
const MAX_SENTRY_ATTEMPTS = 4;
const SENTRY_BACKOFF_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface IncidentRef {
  id: string;
  title: string;
  culprit: string | null;
  level: string;
  lastSeen: string;
  count: number;
  url: string;
}

export interface IncidentSource {
  readonly provider: string;
  /** Most recent unresolved incidents, newest first. */
  listIncidents(limit?: number): Promise<IncidentRef[]>;
  /** Full incident, including stack trace and the request that triggered it. */
  getIncident(id: string): Promise<Incident | null>;
}

// ---------------------------------------------------------------------------
// Fixture source (default; powers the demo and the deterministic evals)
// ---------------------------------------------------------------------------

class FixtureIncidentSource implements IncidentSource {
  readonly provider = 'fixture';

  async listIncidents(): Promise<IncidentRef[]> {
    return Object.entries(INCIDENT_FIXTURES).map(([key, make]) => {
      const i = make();
      return {
        id: key,
        title: i.title,
        culprit: i.service,
        level: i.severity === 'sev1' ? 'fatal' : 'error',
        lastSeen: i.detectedAt,
        count: i.metrics?.affectedRequests ?? 1,
        url: `fixture://${key}`,
      };
    });
  }


  async getIncident(id: string): Promise<Incident | null> {
    const make = INCIDENT_FIXTURES[id];
    return make ? make() : null;
  }
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string | null;
  level?: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: string | number;
  userCount?: number;
  permalink?: string;
  metadata?: { type?: string; value?: string; filename?: string };
  project?: { slug?: string; name?: string };
}

interface SentryFrame {
  filename?: string;
  absPath?: string;
  abs_path?: string;
  module?: string;
  function?: string;
  lineNo?: number | null;
  lineno?: number | null;
  colNo?: number | null;
  colno?: number | null;
  inApp?: boolean;
  in_app?: boolean;
}

interface SentryEntry {
  type: string;
  data?: Record<string, unknown>;
}

interface SentryEvent {
  eventID?: string;
  id?: string;
  dateCreated?: string;
  message?: string;
  entries?: SentryEntry[];
  tags?: { key: string; value: string }[];
}

/** Sentry severity levels mapped onto incident severities. */
function severityFrom(level: string | undefined): Severity {
  switch ((level ?? '').toLowerCase()) {
    case 'fatal':
    case 'error':
      return 'sev1';
    case 'warning':
      return 'sev2';
    default:
      return 'sev3';
  }
}

/**
 * Rebuild a V8-style stack trace from Sentry's structured frames.
 *
 * Sentry stores frames oldest-first; V8 prints newest-first, and the analyzer's
 * parser expects the V8 shape, so the order is reversed here.
 */
export function stackTraceFromSentry(
  errorType: string,
  errorMessage: string,
  frames: SentryFrame[],
): string {
  const lines = [...frames].reverse().map((f) => {
    const file = f.filename ?? f.absPath ?? f.abs_path ?? f.module ?? '<anonymous>';
    const line = f.lineNo ?? f.lineno ?? 0;
    const col = f.colNo ?? f.colno ?? 0;
    const fn = f.function && f.function !== '?' ? f.function : null;
    const loc = `${file}:${line}:${col}`;
    return fn ? `    at ${fn} (${loc})` : `    at ${loc}`;
  });
  return [`${errorType}: ${errorMessage}`, ...lines].join('\n');
}

function findEntry(event: SentryEvent, type: string): Record<string, unknown> | null {
  return (event.entries ?? []).find((e) => e.type === type)?.data ?? null;
}

/** Pull the request that produced the error, so the bug can be reproduced. */
export function sampleRequestFromSentry(event: SentryEvent): SampleRequest | undefined {
  const req = findEntry(event, 'request');
  if (!req) return undefined;
  const url = typeof req.url === 'string' ? req.url : '';
  let path = url;
  try {
    if (url) path = new URL(url).pathname;
  } catch {
    /* relative URL already */
  }
  const headers: Record<string, string> = {};
  const rawHeaders = req.headers;
  if (Array.isArray(rawHeaders)) {
    for (const h of rawHeaders) {
      if (Array.isArray(h) && typeof h[0] === 'string') headers[h[0].toLowerCase()] = String(h[1] ?? '');
    }
  }
  // Never carry credentials out of the error tracker and into a PR body.
  for (const k of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) delete headers[k];
  return {
    method: typeof req.method === 'string' ? req.method : 'GET',
    path: path || '/',
    headers,
    body: req.data ?? undefined,
  };
}

function logsFromSentry(event: SentryEvent, fallbackTs: string): LogLine[] {
  const crumbs = findEntry(event, 'breadcrumbs');
  const values = Array.isArray(crumbs?.values) ? (crumbs!.values as Record<string, unknown>[]) : [];
  return values.slice(-12).map((c) => ({
    ts: typeof c.timestamp === 'string' ? c.timestamp : fallbackTs,
    level: c.level === 'error' ? 'error' : c.level === 'warning' ? 'warn' : 'info',
    msg: String(c.message ?? c.category ?? 'breadcrumb'),
  }));
}

class SentryIncidentSource implements IncidentSource {
  readonly provider = 'sentry';
  private readonly base: string;
  private readonly token: string;
  private readonly org: string;
  private readonly project: string;

  constructor(cfg: Config) {
    this.base = cfg.incidents.sentryUrl;
    this.token = cfg.incidents.sentryAuthToken;
    this.org = cfg.incidents.sentryOrg;
    this.project = cfg.incidents.sentryProject;
  }

  /**
   * Sentry rate-limits aggressively (5 requests/second on issue endpoints), so
   * 429 and 5xx are retried with backoff that honours Retry-After. A 4xx other
   * than 429 is a real error and is surfaced immediately.
   */
  private async api<T>(path: string, attempt = 1): Promise<T> {
    const url = `${this.base}/api/0${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      // A transport failure (DNS, connection reset, timeout) has no HTTP status
      // and so never reached the status check below. Left unhandled it aborts
      // the whole incident response before the workflow even starts.
      clearTimeout(timer);
      if (attempt >= MAX_SENTRY_ATTEMPTS) {
        throw new Error(
          `Sentry request to ${path} failed after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const waitMs = SENTRY_BACKOFF_MS * attempt;
      log.warn(`Sentry transport error for ${path}; retrying in ${waitMs}ms (${attempt}/${MAX_SENTRY_ATTEMPTS})`);
      await sleep(waitMs);
      return this.api<T>(path, attempt + 1);
    }
    try {
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_SENTRY_ATTEMPTS) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : SENTRY_BACKOFF_MS * attempt;
          log.warn(`Sentry ${res.status} for ${path}; retrying in ${waitMs}ms (${attempt}/${MAX_SENTRY_ATTEMPTS})`);
          clearTimeout(timer);
          await sleep(waitMs);
          return this.api<T>(path, attempt + 1);
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Never echo the token; surface only what the operator needs.
        throw new Error(`Sentry ${res.status} ${res.statusText} for ${path}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async listIncidents(limit = 10): Promise<IncidentRef[]> {
    const issues = await this.api<SentryIssue[]>(
      `/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/issues/` +
        `?query=${encodeURIComponent('is:unresolved')}&statsPeriod=24h&limit=${limit}`,
    );
    return issues.map((i) => ({
      id: i.id,
      title: i.title,
      culprit: i.culprit ?? null,
      level: i.level ?? 'error',
      lastSeen: i.lastSeen ?? new Date().toISOString(),
      count: Number(i.count ?? 0),
      url: i.permalink ?? `${this.base}/organizations/${this.org}/issues/${i.id}/`,
    }));
  }


  /**
   * Path to one issue.
   *
   * Newer Sentry organisations only resolve issues under the org-scoped route;
   * the global `/issues/{id}/` returns 404 for them, while older orgs accept
   * both. Preferring the org-scoped form works everywhere.
   */
  private issuePath(id: string, suffix = ''): string {
    return `/organizations/${encodeURIComponent(this.org)}/issues/${encodeURIComponent(id)}/${suffix}`;
  }

  /** Fetch an issue-scoped resource, falling back to the legacy global route. */
  private async issueApi<T>(id: string, suffix = ''): Promise<T> {
    try {
      return await this.api<T>(this.issuePath(id, suffix));
    } catch (err) {
      if (!/\b404\b/.test((err as Error).message)) throw err;
      return this.api<T>(`/issues/${encodeURIComponent(id)}/${suffix}`);
    }
  }

  async getIncident(id: string): Promise<Incident | null> {
    let issue: SentryIssue;
    try {
      issue = await this.issueApi<SentryIssue>(id);
    } catch (err) {
      // Issue ids are not stable: a project that is re-seeded, or whose events
      // age out, retires them. Falling back to the newest unresolved issue
      // keeps a pinned demo working instead of dying on a 404.
      if (!/\b404\b/.test((err as Error).message)) throw err;
      log.warn(`Sentry issue ${id} no longer exists; falling back to the most recent unresolved issue`);
      const recent = await this.listIncidents(1);
      if (!recent.length) return null;
      issue = await this.issueApi<SentryIssue>(recent[0].id);
    }
    // Always use the RESOLVED issue's id: when a stale pin fell back above,
    // the original id no longer exists and would lose the stack trace.
    const issueId = issue.id ?? id;
    let event: SentryEvent | null = null;
    try {
      event = await this.issueApi<SentryEvent>(issueId, 'events/latest/');
    } catch (err) {
      log.warn(`could not load latest event for Sentry issue ${issueId}: ${(err as Error).message}`);
    }

    const exception = event ? findEntry(event, 'exception') : null;
    const values = Array.isArray(exception?.values) ? (exception!.values as Record<string, unknown>[]) : [];
    const top = values[values.length - 1] ?? {};
    const errorType = String(top.type ?? issue.metadata?.type ?? 'Error');
    const errorMessage = String(top.value ?? issue.metadata?.value ?? issue.title);
    const frames = Array.isArray((top.stacktrace as Record<string, unknown>)?.frames)
      ? (((top.stacktrace as Record<string, unknown>).frames as SentryFrame[]) ?? [])
      : [];

    const detectedAt = event?.dateCreated ?? issue.lastSeen ?? new Date().toISOString();

    return {
      id: `INC-SENTRY-${issue.shortId ?? issue.id}`,
      title: issue.title,
      service: issue.project?.slug ?? this.project,
      severity: severityFrom(issue.level),
      detectedAt,
      errorType,
      errorMessage,
      stackTrace: frames.length
        ? stackTraceFromSentry(errorType, errorMessage, frames)
        : `${errorType}: ${errorMessage}`,
      sampleRequest: event ? sampleRequestFromSentry(event) : undefined,
      logs: event ? logsFromSentry(event, detectedAt) : [],
      metrics: {
        errorRatePct: 0,
        affectedRequests: Number(issue.count ?? 0),
        window: '24h',
      },
      source: 'sentry',
    };
  }
}

export function getIncidentSource(cfg: Config = defaultConfig): IncidentSource {
  const eff = effectiveProviders(cfg);
  if (eff.incidents === 'sentry') return new SentryIncidentSource(cfg);
  return new FixtureIncidentSource();
}

/** Convenience for the CLI/server: resolve an id from whichever source is active. */
export async function resolveIncident(id: string, cfg: Config = defaultConfig): Promise<Incident> {
  const source = getIncidentSource(cfg);
  const found = await source.getIncident(id);
  if (found) return found;
  if (INCIDENT_FIXTURES[id]) return INCIDENT_FIXTURES[id]();
  log.warn(`unknown incident "${id}", falling back to the canonical demo incident`);
  return buildCheckoutIncident();
}
