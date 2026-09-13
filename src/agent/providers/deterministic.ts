/**
 * The no-network provider.
 *
 * It exists so every caller has exactly ONE code path:
 *
 *   const out = await llm.completeJson<T>(messages, hint);
 *   if (out === null) return deterministicAnalyzer(...);
 *
 * `available: false` advertises up front that nothing will come back, and
 * `completeJson` resolves to `null` without touching the network, the clock, or
 * the entropy pool — so a run with no API key is byte-for-byte reproducible.
 */

import type { LlmClient, LlmMessage } from '../../types.ts';
import { llmLog } from './shared.ts';

/** LLM client that always declines, handing control to the deterministic analyzer. */
export class DeterministicLlmClient implements LlmClient {
  readonly name = 'deterministic' as const;
  readonly available = false;

  /**
   * Always resolves to `null`. Present only to satisfy {@link LlmClient} so the
   * caller's fallback branch is the single, always-exercised path.
   */
  async completeJson<T>(messages: LlmMessage[], schemaHint: string): Promise<T | null> {
    llmLog.debug(
      `deterministic provider: declining ${messages.length} message(s) (${schemaHint.length} byte schema hint)`,
    );
    return null;
  }
}

/** Construct the deterministic (offline) LLM client. */
export function createDeterministicLlmClient(): DeterministicLlmClient {
  return new DeterministicLlmClient();
}
