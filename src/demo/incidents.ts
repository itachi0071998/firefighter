/**
 * Incident fixtures for the demo and the eval harness.
 *
 * The canonical incident is not hand-written: its stack trace is captured by
 * actually executing the buggy demo application, then rewritten to look like it
 * came from a production container. That keeps the investigation honest —
 * the analyzer really is reading a trace the code produced.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Incident, LogLine, SampleRequest } from '../types.ts';
import { config } from '../config.ts';

const PROD_PREFIX = '/app';

export const GUEST_CHECKOUT_REQUEST: SampleRequest = {
  method: 'POST',
  path: '/api/checkout',
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_9f31c2a7' },
  body: {
    customer: { id: null, email: 'guest@example.com', country: null },
    items: [{ sku: 'SKU-1', qty: 1 }],
    payment: { type: 'card', token: 'tok_visa_4242' },
  },
};

const FALLBACK_STACK = [
  "TypeError: Cannot read properties of null (reading 'toUpperCase')",
  '    at CheckoutValidator.country (/app/src/validators/CheckoutValidator.js:34:31)',
  '    at CheckoutValidator.validate (/app/src/validators/CheckoutValidator.js:15:20)',
  '    at handleCheckout (/app/src/checkout.js:28:31)',
  '    at /app/src/server.js:41:20',
].join('\n');

/**
 * Run the demo application against a request and capture the real thrown stack.
 * Returns null when the repo is not seeded or the call unexpectedly succeeds.
 */
export function captureRealStack(request: SampleRequest, repoPath = config.demoRepoPath): string | null {
  if (!fs.existsSync(path.join(repoPath, 'src', 'checkout.js'))) return null;
  const driver = path.join(os.tmpdir(), `ff-capture-${process.pid}.cjs`);
  fs.writeFileSync(
    driver,
    `const { handleCheckout } = require(${JSON.stringify(path.join(repoPath, 'src', 'checkout.js'))});
     try {
       const out = handleCheckout(${JSON.stringify(request)});
       process.stdout.write(JSON.stringify({ threw: false, result: out }));
     } catch (err) {
       process.stdout.write(JSON.stringify({ threw: true, stack: err.stack, name: err.name, message: err.message }));
     }`,
    'utf8',
  );
  try {
    const out = execFileSync(process.execPath, [driver], { cwd: repoPath, encoding: 'utf8', timeout: 20000 });
    const parsed = JSON.parse(out) as { threw: boolean; stack?: string };
    if (!parsed.threw || !parsed.stack) return null;
    return normaliseToProduction(parsed.stack, repoPath);
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(driver, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Rewrite local absolute paths so the trace reads like a production container. */
function normaliseToProduction(stack: string, repoPath: string): string {
  return stack
    .split('\n')
    .filter((l) => !l.includes('node:internal') && !l.includes('ff-capture-'))
    .map((l) => l.split(repoPath).join(PROD_PREFIX))
    .join('\n');
}

function checkoutLogs(detectedAt: string): LogLine[] {
  const base = new Date(detectedAt).getTime();
  const at = (deltaSec: number): string => new Date(base + deltaSec * 1000).toISOString();
  return [
    { ts: at(-185), level: 'info', msg: 'deploy 8f2a1c promoted to production (PR #142)' },
    { ts: at(-40), level: 'error', msg: 'POST /api/checkout 500 — TypeError in CheckoutValidator.country', requestId: 'req_1a2b3c' },
    { ts: at(-31), level: 'error', msg: 'POST /api/checkout 500 — TypeError in CheckoutValidator.country', requestId: 'req_4d5e6f' },
    { ts: at(-22), level: 'warn', msg: 'checkout error rate 18.4% over 1m (threshold 1%)' },
    { ts: at(-12), level: 'error', msg: 'POST /api/checkout 500 — TypeError in CheckoutValidator.country', requestId: 'req_9f31c2a7' },
    { ts: at(-4), level: 'error', msg: 'guest checkout conversion dropped to 0% in EU region' },
    { ts: at(0), level: 'error', msg: 'PagerDuty: SEV1 declared — checkout unavailable for guest users' },
  ];
}

export interface IncidentOptions {
  detectedAt?: string;
  repoPath?: string;
  id?: string;
}

/** The canonical demo incident: guest checkout 500s caused by PR #142. */
export function buildCheckoutIncident(opts: IncidentOptions = {}): Incident {
  const detectedAt = opts.detectedAt ?? '2026-09-13T09:18:00.000Z';
  const stack = captureRealStack(GUEST_CHECKOUT_REQUEST, opts.repoPath ?? config.demoRepoPath) ?? FALLBACK_STACK;
  const firstLine = stack.split('\n')[0] ?? '';
  const [errorType, ...rest] = firstLine.split(': ');
  return {
    id: opts.id ?? 'INC-2026-0913-001',
    title: 'Checkout 500 errors for guest users',
    service: 'checkout-service',
    severity: 'sev1',
    detectedAt,
    errorType: errorType || 'TypeError',
    errorMessage: rest.join(': ') || "Cannot read properties of null (reading 'toUpperCase')",
    stackTrace: stack,
    sampleRequest: GUEST_CHECKOUT_REQUEST,
    logs: checkoutLogs(detectedAt),
    metrics: { errorRatePct: 18.4, affectedRequests: 1247, window: '5m' },
    source: 'sentry-mock',
  };
}

/**
 * An incident whose stack points at long-untouched code. No recent change
 * explains it, so the analyzer must return inconclusive and the workflow must
 * refuse to revert anything.
 */
export function buildInconclusiveIncident(opts: IncidentOptions = {}): Incident {
  const detectedAt = opts.detectedAt ?? '2026-09-13T09:18:00.000Z';
  const stack = [
    'Error: ECONNRESET reading from upstream inventory provider',
    '    at TLSSocket.onError (/app/node_modules/undici/lib/client.js:912:17)',
    '    at TLSSocket.emit (node:events:519:28)',
    '    at emitErrorNT (node:internal/streams/destroy:170:8)',
  ].join('\n');
  return {
    id: opts.id ?? 'INC-2026-0913-002',
    title: 'Intermittent upstream connection resets',
    service: 'checkout-service',
    severity: 'sev2',
    detectedAt,
    errorType: 'Error',
    errorMessage: 'ECONNRESET reading from upstream inventory provider',
    stackTrace: stack,
    logs: [
      { ts: detectedAt, level: 'error', msg: 'upstream inventory provider reset 14 connections in 60s' },
    ],
    metrics: { errorRatePct: 2.1, affectedRequests: 88, window: '5m' },
    source: 'sentry-mock',
  };
}

/**
 * An incident caused by an OLDER pull request (#139, the promo-code change).
 * The most recent deploy is unrelated, so a recency-only heuristic gets this
 * wrong and stack-trace correlation gets it right.
 */
export function buildPricingIncident(opts: IncidentOptions = {}): Incident {
  // Deliberately BEFORE PR #142 shipped (2026-09-13T09:15Z). #142 also touches
  // src/pricing.js, so if this incident post-dated it, blaming #142 would be the
  // correct answer and the scenario would not test what it claims to.
  const detectedAt = opts.detectedAt ?? '2026-09-12T20:00:00.000Z';
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'percentOff')",
    '    at computePrice (/app/src/pricing.js:41:34)',
    '    at handleCheckout (/app/src/checkout.js:34:21)',
    '    at /app/src/server.js:41:20',
  ].join('\n');
  return {
    id: opts.id ?? 'INC-2026-0913-003',
    title: 'Checkout 500s when an unknown promo code is supplied',
    service: 'checkout-service',
    severity: 'sev2',
    detectedAt,
    errorType: 'TypeError',
    errorMessage: "Cannot read properties of undefined (reading 'percentOff')",
    stackTrace: stack,
    sampleRequest: {
      method: 'POST',
      path: '/api/checkout',
      body: {
        customer: { id: 'cus_1', email: 'a@example.com', country: 'US' },
        items: [{ sku: 'SKU-1', qty: 1 }],
        payment: { type: 'card', token: 'tok_visa_4242' },
        promoCode: 'DOES-NOT-EXIST',
      },
    },
    logs: [{ ts: detectedAt, level: 'error', msg: 'POST /api/checkout 500 — TypeError in computePrice' }],
    metrics: { errorRatePct: 3.7, affectedRequests: 210, window: '5m' },
    source: 'sentry-mock',
  };
}

export const INCIDENT_FIXTURES: Record<string, (o?: IncidentOptions) => Incident> = {
  'checkout-guest-null-country': buildCheckoutIncident,
  'upstream-reset-inconclusive': buildInconclusiveIncident,
  'promo-code-undefined': buildPricingIncident,
};
