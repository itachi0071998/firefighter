/**
 * OpenAI chat-completions provider.
 *
 * POSTs to /v1/chat/completions with `response_format: {type:'json_object'}` so
 * the model is constrained to a single JSON object. Selected only when
 * `LLM_PROVIDER=openai` AND `OPENAI_API_KEY` is set — `effectiveProviders()`
 * degrades to the deterministic analyzer otherwise, so switching providers is a
 * two-env-var change with no code edits.
 *
 * Failure policy: `completeJson` never throws. Timeouts, rate limits, 5xx, and
 * malformed payloads all return `null`.
 */

import type { Config } from '../../config.ts';
import type { LlmClient, LlmMessage } from '../../types.ts';
import {
  applySchemaHint,
  isTemperatureRejection,
  llmForceFailEnabled,
  llmLog,
  logForcedFailure,
  parseJsonPayload,
  postForJson,
  truncate,
} from './shared.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** Minimal shape of the chat-completions envelope we read. */
interface OpenAiChatEnvelope {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** LLM client backed by the OpenAI chat-completions API. */
export class OpenAiLlmClient implements LlmClient {
  readonly name = 'openai' as const;
  readonly available: boolean;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #retryBaseMs: number;

  /**
   * @param cfg Loaded config. The API key is held privately and never echoed
   *   into logs, errors, or returned objects.
   */
  constructor(cfg: Config) {
    this.#apiKey = cfg.llm.openaiApiKey;
    this.#model = cfg.llm.openaiModel || 'gpt-4o';
    this.#retryBaseMs = cfg.retryBaseMs;
    this.available = this.#apiKey.length > 0;
  }

  /** Model id this client will request. Safe to log. */
  get model(): string {
    return this.#model;
  }

  /**
   * Ask OpenAI for a single JSON object matching `schemaHint`.
   *
   * @param messages System/user turns; the schema hint is appended to the last
   *   system message (one is prepended when absent).
   * @param schemaHint Human-readable description of the required JSON shape.
   * @returns The parsed object, or `null` when the provider is unavailable,
   *   fails, or returns something unparseable.
   */
  async completeJson<T>(messages: LlmMessage[], schemaHint: string): Promise<T | null> {
    if (!this.available) {
      llmLog.warn('openai: no API key configured, returning null');
      return null;
    }
    if (llmForceFailEnabled()) {
      logForcedFailure('openai');
      return null;
    }

    const payload = applySchemaHint(messages, schemaHint).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const body: Record<string, unknown> = {
      model: this.#model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: payload,
    };

    let result = await postForJson({
      provider: 'openai',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body,
      retryBaseMs: this.#retryBaseMs,
    });

    // Newer reasoning models reject sampling parameters outright. Retry once
    // without `temperature` instead of losing the turn to the fallback path.
    if (isTemperatureRejection(result)) {
      llmLog.warn(`openai: model ${this.#model} rejected "temperature"; retrying once without it`);
      const { temperature: _omitted, ...rest } = body;
      result = await postForJson({
        provider: 'openai',
        url: ENDPOINT,
        headers: { authorization: `Bearer ${this.#apiKey}` },
        body: rest,
        retryBaseMs: this.#retryBaseMs,
      });
    }

    if (!result.ok) return null;

    const envelope = result.body as OpenAiChatEnvelope;
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      llmLog.warn('openai: response contained no assistant text', {
        excerpt: truncate(JSON.stringify(envelope ?? null), 300),
      });
      return null;
    }
    return parseJsonPayload<T>(content, 'openai');
  }
}

/** Construct the OpenAI-backed LLM client. */
export function createOpenAiLlmClient(cfg: Config): OpenAiLlmClient {
  return new OpenAiLlmClient(cfg);
}
