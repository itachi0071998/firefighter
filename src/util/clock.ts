/**
 * Injectable clock. Evals freeze/advance it so runs are byte-for-byte
 * reproducible and timestamps never leak nondeterminism into idempotency keys.
 */
let frozenAt: number | null = null;
let offsetMs = 0;

export function nowMs(): number {
  return (frozenAt ?? Date.now()) + offsetMs;
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

export function freezeClock(iso: string): void {
  frozenAt = new Date(iso).getTime();
  offsetMs = 0;
}

export function advanceClock(ms: number): void {
  offsetMs += ms;
}

export function unfreezeClock(): void {
  frozenAt = null;
  offsetMs = 0;
}

export function isFrozen(): boolean {
  return frozenAt !== null;
}
