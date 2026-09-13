/**
 * LLM provider selection.
 *
 * One interface ({@link LlmClient}), three implementations, chosen by config:
 *
 *   LLM_PROVIDER=deterministic   -> offline analyzer, always returns null
 *   LLM_PROVIDER=openai          -> OpenAI chat-completions (needs OPENAI_API_KEY)
 *   LLM_PROVIDER=anthropic       -> Anthropic Messages  (needs ANTHROPIC_API_KEY)
 *
 * Selection goes through `effectiveProviders()`, so a provider requested without
 * its key silently degrades to `deterministic` instead of crashing the run.
 * That makes "no key set" the zero-config default and "switch to OpenAI" a
 * two-env-var change with no code edits.
 *
 * Callers always write the same two lines:
 *
 *   const out = await getLlmClient().completeJson<Shape>(messages, SCHEMA_HINT);
 *   if (out === null) return deterministicAnalysis(...);   // never skipped
 */

import { config, effectiveProviders, type Config, type LlmProvider } from '../config.ts';
import type { LlmClient, LlmProviderName } from '../types.ts';
import { AnthropicLlmClient } from './providers/anthropic.ts';
import { DeterministicLlmClient } from './providers/deterministic.ts';
import { OpenAiLlmClient } from './providers/openai.ts';

export { AnthropicLlmClient } from './providers/anthropic.ts';
export { DeterministicLlmClient } from './providers/deterministic.ts';
export { OpenAiLlmClient } from './providers/openai.ts';
export { DEFAULT_LLM_TIMEOUT_MS, MAX_LLM_ATTEMPTS, llmTimeoutMs } from './providers/shared.ts';

/** Which provider actually runs, and why it may differ from what was requested. */
export interface LlmSelection {
  /** Provider requested via LLM_PROVIDER. */
  requested: LlmProvider;
  /** Provider that will actually be used after credential checks. */
  effective: LlmProviderName;
  /** Degradation notes emitted by `effectiveProviders()` (LLM-related only). */
  notes: string[];
}

/**
 * Resolve the provider that will actually be used, together with any
 * degradation notes (e.g. "openai requested but OPENAI_API_KEY is empty").
 *
 * @param cfg Config to inspect. Defaults to the process-wide loaded config.
 */
export function resolveLlmSelection(cfg: Config = config): LlmSelection {
  const eff = effectiveProviders(cfg);
  return {
    requested: cfg.llm.provider,
    effective: eff.llm as LlmProviderName,
    notes: eff.notes.filter((n) => n.startsWith('LLM_PROVIDER=')),
  };
}

/**
 * Build the LLM client for the current configuration.
 *
 * Never throws and never performs I/O at construction time: a missing or empty
 * API key yields {@link DeterministicLlmClient}, whose `completeJson` resolves
 * to `null` so callers exercise their deterministic fallback path.
 *
 * @param cfg Config to select from. Defaults to the process-wide loaded config.
 * @returns A ready-to-use client. Inspect `.name` / `.available` to report it.
 */
export function getLlmClient(cfg: Config = config): LlmClient {
  switch (resolveLlmSelection(cfg).effective) {
    case 'openai':
      return new OpenAiLlmClient(cfg);
    case 'anthropic':
      return new AnthropicLlmClient(cfg);
    default:
      return new DeterministicLlmClient();
  }
}

/**
 * One-line, human-readable description of the active LLM provider — used by the
 * CLI banner, the dashboard, and run summaries.
 *
 * Examples:
 *   "deterministic (no API key configured)"
 *   "deterministic (LLM_PROVIDER=openai but OPENAI_API_KEY is empty -> using deterministic analyzer)"
 *   "openai (model gpt-4o)"
 *
 * @param cfg Config to describe. Defaults to the process-wide loaded config.
 */
export function describeLlm(cfg: Config = config): string {
  const { requested, effective, notes } = resolveLlmSelection(cfg);
  if (effective === 'openai') return `openai (model ${cfg.llm.openaiModel})`;
  if (effective === 'anthropic') return `anthropic (model ${cfg.llm.anthropicModel})`;
  if (requested !== 'deterministic') {
    const why = notes[0] ?? `${requested} requested but no credentials found`;
    return `deterministic (${why})`;
  }
  const hasKey = Boolean(cfg.llm.openaiApiKey || cfg.llm.anthropicApiKey);
  return hasKey
    ? 'deterministic (explicitly selected; no LLM calls will be made)'
    : 'deterministic (no API key configured)';
}
