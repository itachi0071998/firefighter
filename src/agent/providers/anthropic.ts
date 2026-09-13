/**
 * Anthropic Messages API provider.
 *
 * POSTs to /v1/messages with `x-api-key` + `anthropic-version: 2023-06-01`.
 * The Messages API separates the system prompt from the turn list, so system
 * messages are concatenated into the `system` field and the user turns are sent
 * as `messages`. JSON is requested via the system prompt (there is no
 * `response_format` equivalent), then fences are stripped before parsing.
 *
 * Failure policy: `completeJson` never throws — it returns `null` and the caller
 * falls back to the deterministic analyzer.
 */

import type { Config } from '../../config.ts';
import type { LlmClient, LlmMessage } from '../../types.ts';
import {
  isTemperatureRejection,
  llmForceFailEnabled,
  llmLog,
  logForcedFailure,
  parseJsonPayload,
  postForJson,
  schemaInstruction,
  truncate,
} from './shared.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

/** Fallback turn used when the caller supplied only system messages. */
const EMPTY_USER_PROMPT = 'Produce the JSON object described above now.';

/** Minimal shape of the Messages envelope we read. */
interface AnthropicMessageEnvelope {
  content?: Array<{ type?: string; text?: string }>;
}

/** LLM client backed by the Anthropic Messages API. */
export class AnthropicLlmClient implements LlmClient {
  readonly name = 'anthropic' as const;
  readonly available: boolean;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #retryBaseMs: number;

  /**
   * @param cfg Loaded config. The API key is held privately and never echoed
   *   into logs, errors, or returned objects.
   */
  constructor(cfg: Config) {
    this.#apiKey = cfg.llm.anthropicApiKey;
    this.#model = cfg.llm.anthropicModel || 'claude-sonnet-5';
    this.#retryBaseMs = cfg.retryBaseMs;
    this.available = this.#apiKey.length > 0;
  }

  /** Model id this client will request. Safe to log. */
  get model(): string {
    return this.#model;
  }

  /**
   * Ask Claude for a single JSON object matching `schemaHint`.
   *
   * @param messages System/user turns. System turns are merged into the
   *   `system` parameter (with the schema instruction appended); user turns are
   *   merged into one user message, since the API expects alternating roles.
   * @param schemaHint Human-readable description of the required JSON shape.
   * @returns The parsed object, or `null` on any failure.
   */
  async completeJson<T>(messages: LlmMessage[], schemaHint: string): Promise<T | null> {
    if (!this.available) {
      llmLog.warn('anthropic: no API key configured, returning null');
      return null;
    }
    if (llmForceFailEnabled()) {
      logForcedFailure('anthropic');
      return null;
    }

    const systemParts = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content.trim())
      .filter((s) => s !== '');
    systemParts.push(schemaInstruction(schemaHint));

    const userParts = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.trim())
      .filter((s) => s !== '');

    const body: Record<string, unknown> = {
      model: this.#model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: systemParts.join('\n\n'),
      messages: [
        {
          role: 'user',
          content: userParts.length > 0 ? userParts.join('\n\n') : EMPTY_USER_PROMPT,
        },
      ],
    };

    const headers = { 'x-api-key': this.#apiKey, 'anthropic-version': API_VERSION };

    let result = await postForJson({
      provider: 'anthropic',
      url: ENDPOINT,
      headers,
      body,
      retryBaseMs: this.#retryBaseMs,
    });

    // Newer Claude models removed sampling parameters and reject `temperature`
    // with a 400. Retry once without it rather than losing the turn.
    if (isTemperatureRejection(result)) {
      llmLog.warn(
        `anthropic: model ${this.#model} rejected "temperature"; retrying once without it`,
      );
      const { temperature: _omitted, ...rest } = body;
      result = await postForJson({
        provider: 'anthropic',
        url: ENDPOINT,
        headers,
        body: rest,
        retryBaseMs: this.#retryBaseMs,
      });
    }

    if (!result.ok) return null;

    const envelope = result.body as AnthropicMessageEnvelope;
    const block = envelope.content?.find((b) => b.type === 'text' && typeof b.text === 'string');
    const text = block?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      llmLog.warn('anthropic: response contained no text content block', {
        excerpt: truncate(JSON.stringify(envelope ?? null), 300),
      });
      return null;
    }
    return parseJsonPayload<T>(text, 'anthropic');
  }
}

/** Construct the Anthropic-backed LLM client. */
export function createAnthropicLlmClient(cfg: Config): AnthropicLlmClient {
  return new AnthropicLlmClient(cfg);
}
