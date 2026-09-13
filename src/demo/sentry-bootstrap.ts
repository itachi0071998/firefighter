/**
 * One-command Sentry bootstrap for a fresh account.
 *
 * Setting this up by hand is fiddly and every fiddly part is a way to get a
 * demo that silently does not work:
 *   - the project must exist and you need its DSN, not just an auth token;
 *   - the event's stack frames must match the repository Firefighter will
 *     investigate, down to the line numbers, or nothing correlates;
 *   - Sentry clamps event timestamps, so a hand-written one drifts;
 *   - issue ids are not stable, so a pinned id goes stale.
 *
 * So the frames are not written by hand: the failing request is executed
 * against the real demo repository and the resulting stack is captured, then
 * rewritten to look like it came from a production container.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, config as defaultConfig } from '../config.ts';
import { SampleRequest } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('sentry-bootstrap');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Container prefix used so captured paths read like production. */
const PROD_PREFIX = '/app';

/** The request that triggers the seeded regression in the demo service. */
export const LOYALTY_REQUEST: SampleRequest = {
  method: 'POST',
  path: '/api/checkout',
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_7c1f4d2b' },
  body: {
    customer: { id: 'cus_9', email: 'member@example.com', country: 'US', loyalty: null },
    items: [{ sku: 'SKU-1', qty: 1, unitPrice: 2000 }],
    payment: { type: 'card', token: 'tok_visa' },
    applyLoyaltyDiscount: true,
  },
};

interface CapturedFrame {
  filename: string;
  abs_path: string;
  function: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

export interface BootstrapResult {
  org: string;
  project: string;
  projectCreated: boolean;
  issueId: string | null;
  shortId: string | null;
  frames: CapturedFrame[];
  errorType: string;
  errorMessage: string;
}

/**
 * Execute the failing request against the repo and capture the real stack.
 *
 * Capturing beats hand-writing: the frames cannot drift out of sync with the
 * source, which is the failure mode that makes an investigation silently
 * inconclusive.
 */
export function captureFrames(
  repoPath: string,
  request: SampleRequest,
): { frames: CapturedFrame[]; errorType: string; errorMessage: string } {
  const driver = path.join(os.tmpdir(), `ff-capture-${process.pid}.mjs`);
  fs.writeFileSync(
    driver,
    `import { CheckoutService } from ${JSON.stringify(path.join(repoPath, 'src/checkout/checkout.service.ts'))};
     try {
       new CheckoutService().createOrder(${JSON.stringify(request.body)});
       process.stdout.write(JSON.stringify({ threw: false }));
     } catch (err) {
       process.stdout.write(JSON.stringify({ threw: true, name: err.name, message: err.message, stack: err.stack }));
     }`,
    'utf8',
  );
  try {
    const out = execFileSync(process.execPath, [driver], { cwd: repoPath, encoding: 'utf8', timeout: 30000 });
    const parsed = JSON.parse(out) as { threw: boolean; name?: string; message?: string; stack?: string };
    if (!parsed.threw || !parsed.stack) {
      throw new Error('the demo service did not throw — is the repository seeded with the regression?');
    }
    const frames: CapturedFrame[] = [];
    for (const line of parsed.stack.split('\n').slice(1)) {
      const m = /at\s+(?:(.+?)\s+)?\(?(?:file:\/\/)?([^()]+?):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!m) continue;
      const abs = m[2];
      if (!abs.startsWith(repoPath)) continue; // skip node internals and the driver
      frames.push({
        filename: path.relative(repoPath, abs),
        abs_path: `${PROD_PREFIX}/${path.relative(repoPath, abs)}`,
        function: m[1] ?? '<anonymous>',
        lineno: Number(m[3]),
        colno: Number(m[4]),
        in_app: true,
      });
    }
    // Sentry stores frames oldest-first; V8 prints newest-first.
    frames.reverse();
    return { frames, errorType: parsed.name ?? 'Error', errorMessage: parsed.message ?? '' };
  } finally {
    fs.rmSync(driver, { force: true });
  }
}

async function api<T>(cfg: Config, pathname: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${cfg.incidents.sentryUrl}/api/0${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.incidents.sentryAuthToken}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, body };
}

/**
 * Create the project if needed, ingest one realistic incident, and return the
 * issue id to pin.
 *
 * @param projectSlug project to create or reuse
 * @param cfg configuration; defaults to the process-wide config
 */
export async function bootstrapSentry(projectSlug: string, cfg: Config = defaultConfig): Promise<BootstrapResult> {
  const org = cfg.incidents.sentryOrg;
  if (!cfg.incidents.sentryAuthToken) throw new Error('SENTRY_AUTH_TOKEN (or SENTRY_TOKEN) is not set');
  if (!org) throw new Error('SENTRY_ORG is not set');

  const { frames, errorType, errorMessage } = captureFrames(cfg.demoRepoPath, LOYALTY_REQUEST);
  if (!frames.length) throw new Error('captured no application frames from the demo repository');
  log.info(`captured ${frames.length} frames, innermost ${frames[frames.length - 1].function}`);

  // 1. Project — reuse when it already exists.
  const existing = await api<{ slug: string }>(cfg, `/projects/${org}/${projectSlug}/`);
  let projectCreated = false;
  if (existing.status === 404) {
    const teams = await api<{ slug: string }[]>(cfg, `/organizations/${org}/teams/`);
    const team = teams.body?.[0]?.slug;
    if (!team) throw new Error(`no team found in organization "${org}"`);
    const created = await api<{ slug: string }>(cfg, `/teams/${org}/${team}/projects/`, {
      method: 'POST',
      body: JSON.stringify({ name: projectSlug, slug: projectSlug, platform: 'node' }),
    });
    if (created.status >= 400) throw new Error(`could not create project: ${created.status}`);
    projectCreated = true;
    log.info(`created project ${org}/${projectSlug}`);
  } else if (existing.status >= 400) {
    throw new Error(`could not read project ${org}/${projectSlug}: ${existing.status}`);
  }

  // 2. DSN — required to ingest; the auth token alone cannot send events.
  const keys = await api<{ dsn?: { public?: string } }[]>(cfg, `/projects/${org}/${projectSlug}/keys/`);
  const dsn = keys.body?.[0]?.dsn?.public;
  if (!dsn) throw new Error('no client key (DSN) available on the project');
  const u = new URL(dsn);

  // 3. Ingest. The timestamp is left to Sentry rather than set here: a
  //    hand-written one gets clamped and then disagrees with the commit dates.
  const event = {
    platform: 'node',
    level: 'error',
    environment: 'production',
    release: 'checkout-service@1.9.0',
    server_name: 'checkout-5a2c',
    transaction: `${LOYALTY_REQUEST.method} ${LOYALTY_REQUEST.path}`,
    exception: {
      values: [
        {
          type: errorType,
          value: errorMessage,
          mechanism: { type: 'onuncaughtexception', handled: false },
          stacktrace: { frames },
        },
      ],
    },
    request: {
      url: `https://shop.example.com${LOYALTY_REQUEST.path}`,
      method: LOYALTY_REQUEST.method,
      headers: Object.entries(LOYALTY_REQUEST.headers ?? {}),
      data: LOYALTY_REQUEST.body,
    },
    tags: { service: projectSlug, route: LOYALTY_REQUEST.path, customer_type: 'loyalty-member' },
  };
  const ingest = await fetch(`https://${u.host}/api/${u.pathname.replace('/', '')}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=firefighter/1.0, sentry_key=${u.username}`,
    },
    body: JSON.stringify(event),
  });
  if (!ingest.ok) throw new Error(`event ingest failed: ${ingest.status}`);
  log.info('event accepted — waiting for Sentry to index it');

  // 4. Poll for the issue. Indexing is not instant.
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const issues = await api<{ id: string; shortId: string; title: string }[]>(
      cfg,
      `/projects/${org}/${projectSlug}/issues/`,
    );
    const hit = (issues.body ?? []).find((x) => x.title?.includes(errorMessage.slice(0, 24)));
    if (hit) {
      return { org, project: projectSlug, projectCreated, issueId: hit.id, shortId: hit.shortId, frames, errorType, errorMessage };
    }
  }
  return { org, project: projectSlug, projectCreated, issueId: null, shortId: null, frames, errorType, errorMessage };
}
