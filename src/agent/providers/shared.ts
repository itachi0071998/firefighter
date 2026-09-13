/**
 * Shared plumbing for the real (network-backed) LLM providers.
 *
 * Everything in here is deliberately dependency-free and deterministic:
 *  - no `Math.random()` (so no jitter — reproducibility beats thundering-herd
 *    avoidance for a single-tenant incident agent),
 *  - no `Date.now()` (the injectable clock in `util/clock.ts` is used instead),
 *  - no throwing (every failure path funnels into a `warn` log + `null`).
 *
 * The contract every provider upholds: `completeJson` NEVER throws. A provider
 * outage, a timeout, a rate limit, or a malformed body all degrade to `null`,
 * and the caller falls back to the deterministic analyzer.
 */

import type { LlmMessage } from '../../types.ts';
import { nowMs } from '../../util/clock.ts';
import { logger } from '../../util/log.ts';

const log = logger('llm');

/** Wall-clock budget for a single LLM HTTP request when FF_LLM_TIMEOUT_MS is unset. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/** Upper bound on any single backoff sleep, including a server-supplied Retry-After. */
export const MAX_RETRY_DELAY_MS = 10_000;

/** Total attempts (1 initial + 2 retries) for a retryable failure. */
export const MAX_LLM_ATTEMPTS = 3;

/** Longest error-body excerpt written to the log. Keeps provider errors readable. */
const MAX_LOGGED_BODY = 300;

/**
 * Per-request timeout in milliseconds, overridable with `FF_LLM_TIMEOUT_MS`.
 * Read on every call so evals can retune it between runs.
 */
export function llmTimeoutMs(): number {
  const raw = (process.env.FF_LLM_TIMEOUT_MS ?? '').trim();
  if (raw === '') return DEFAULT_LLM_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_TIMEOUT_MS;
}

/**
 * Test hook used by the eval harness to simulate a provider outage without
 * touching the network. When `FF_LLM_FORCE_FAIL=1`, real clients return `null`.
 */
export function llmForceFailEnabled(): boolean {
  return process.env.FF_LLM_FORCE_FAIL === '1';
}

/** Promise-returning `setTimeout`. Never unref'd: the caller is awaiting it. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, Math.trunc(ms)));
  });
}

/**
 * Exponential backoff with no jitter: `base * 2^(attempt-1)`, clamped to
 * {@link MAX_RETRY_DELAY_MS}. Deterministic by design.
 *
 * @param attempt 1-based attempt number that just failed.
 * @param baseMs Base delay, normally `config.retryBaseMs`.
 */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 150;
  const raw = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(raw));
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns `null` when the header is absent or unparseable. Clamped to
 * [0, {@link MAX_RETRY_DELAY_MS}]; the HTTP-date branch uses `nowMs()` so a
 * frozen clock stays deterministic.
 */
export function retryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const raw = headerValue.trim();
  if (raw === '') return null;
  const clamp = (ms: number): number => Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(ms)));
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return clamp(at - nowMs());
  return null;
}

/** Strip ```json / ``` fences and surrounding prose noise from a model reply. */
export function stripJsonFences(text: string): string {
  let out = text.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(out);
  if (match && match[1] !== undefined) out = match[1].trim();
  return out;
}

/**
 * Parse model output into `T`. Tolerates code fences and leading/trailing prose
 * by falling back to the outermost `{...}` / `[...]` span. Returns `null` (and
 * logs) instead of throwing on unparseable output.
 *
 * @param text Raw text emitted by the model.
 * @param provider Provider label used in the failure log.
 */
export function parseJsonPayload<T>(text: string, provider: string): T | null {
  const cleaned = stripJsonFences(text);
  const attempt = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };
  const direct = attempt(cleaned);
  if (direct !== null) return direct;

  const first = cleaned.search(/[[{]/);
  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const last = Math.max(lastBrace, lastBracket);
  if (first !== -1 && last > first) {
    const salvaged = attempt(cleaned.slice(first, last + 1));
    if (salvaged !== null) return salvaged;
  }
  log.warn(`${provider} returned a non-JSON payload; falling back to deterministic analyzer`, {
    excerpt: truncate(cleaned, MAX_LOGGED_BODY),
  });
  return null;
}

/** Trim a string for logging, appending an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Render the JSON-shape instruction appended to the system prompt. Mentioning
 * "JSON" explicitly is also what OpenAI's `response_format: json_object` mode
 * requires of the prompt.
 */
export function schemaInstruction(schemaHint: string): string {
  return [
    'Respond with a single valid JSON object and nothing else.',
    'Do not wrap it in markdown fences and do not add commentary.',
    'The JSON must match this shape:',
    schemaHint.trim(),
  ].join('\n');
}

/**
 * Copy `messages`, appending the schema instruction to the last system message
 * (or prepending a new system message when the caller supplied none).
 */
export function applySchemaHint(
  messages: readonly LlmMessage[],
  schemaHint: string,
): LlmMessage[] {
  const out: LlmMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const hint = schemaInstruction(schemaHint);
  let lastSystem = -1;
  for (let i = 0; i < out.length; i += 1) if (out[i].role === 'system') lastSystem = i;
  if (lastSystem === -1) {
    out.unshift({ role: 'system', content: hint });
  } else {
    out[lastSystem] = { role: 'system', content: `${out[lastSystem].content}\n\n${hint}` };
  }
  return out;
}

/** A single POST to a provider's JSON endpoint. */
export interface LlmHttpRequest {
  /** Provider label for logs. Never contains credentials. */
  provider: string;
  url: string;
  /** Auth headers. These are never logged. */
  headers: Record<string, string>;
  body: unknown;
  /** Base backoff delay, normally `config.retryBaseMs`. */
  retryBaseMs: number;
  /** Total attempts including the first. Defaults to {@link MAX_LLM_ATTEMPTS}. */
  maxAttempts?: number;
}

/** Outcome of {@link postForJson}: either a parsed envelope or a described failure. */
export type LlmHttpResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; errorText: string };

/**
 * POST JSON to a provider endpoint with an abort-based timeout and bounded,
 * deterministic exponential backoff.
 *
 * Retries: HTTP 429, any 5xx, and transport-level failures (including timeouts),
 * up to `maxAttempts`. A server-supplied `Retry-After` wins over the computed
 * backoff. All other statuses fail fast. This function never throws and never
 * logs credentials.
 */
export async function postForJson(req: LlmHttpRequest): Promise<LlmHttpResult> {
  const attempts = Math.max(1, req.maxAttempts ?? MAX_LLM_ATTEMPTS);
  let last: LlmHttpResult = { ok: false, status: null, errorText: 'no attempt was made' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = llmTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (res.ok) {
        try {
          return { ok: true, body: JSON.parse(text) as unknown };
        } catch {
          return { ok: false, status: res.status, errorText: 'response body was not valid JSON' };
        }
      }

      last = { ok: false, status: res.status, errorText: truncate(text, MAX_LOGGED_BODY) };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === attempts) {
        log.warn(
          `${req.provider} request failed with HTTP ${res.status} after ${attempt} attempt(s)`,
          last.errorText || undefined,
        );
        return last;
      }
      const delay = retryAfterMs(res.headers.get('retry-after')) ?? backoffDelayMs(attempt, req.retryBaseMs);
      log.warn(
        `${req.provider} HTTP ${res.status} on attempt ${attempt}/${attempts}; retrying in ${delay}ms`,
      );
      await sleep(delay);
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const message = aborted
        ? `request aborted after ${timeoutMs}ms timeout`
        : err instanceof Error
          ? err.message
          : String(err);
      last = { ok: false, status: null, errorText: message };
      if (attempt === attempts) {
        log.warn(`${req.provider} transport failure after ${attempt} attempt(s): ${message}`);
        return last;
      }
      const delay = backoffDelayMs(attempt, req.retryBaseMs);
      log.warn(
        `${req.provider} transport failure on attempt ${attempt}/${attempts} (${message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * True when a 400 response looks like "this model rejects the `temperature`
 * parameter". Newer reasoning models removed sampling parameters, so the real
 * clients retry once without `temperature` rather than silently degrading.
 */
export function isTemperatureRejection(result: LlmHttpResult): boolean {
  return !result.ok && result.status === 400 && /temperature/i.test(result.errorText);
}

/** Log a provider outage forced by the eval harness, then let the caller return null. */
export function logForcedFailure(provider: string): void {
  log.warn(`${provider}: FF_LLM_FORCE_FAIL=1 — simulating provider outage, returning null`);
}

/** Shared logger for the provider layer, so key material never reaches a log call. */
export const llmLog = log;
