import { getDb, json } from './index.ts';
import { nowIso } from '../util/clock.ts';
import { payloadHash, shortHash } from '../util/hash.ts';
import {
  Incident,
  MutationRecord,
  RunStatus,
  StepName,
  StepRecord,
  StepStatus,
  STEP_NAMES,
  ToolCallRecord,
  WorkflowRun,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export function incidentFingerprint(i: Incident): string {
  return payloadHash({
    title: i.title,
    service: i.service,
    errorType: i.errorType,
    errorMessage: i.errorMessage,
    stackTrace: i.stackTrace,
    detectedAt: i.detectedAt,
  });
}

export function upsertIncident(incident: Incident): { incident: Incident; created: boolean } {
  const db = getDb();
  const fingerprint = incidentFingerprint(incident);
  const existing = db
    .prepare('SELECT id, payload FROM incidents WHERE fingerprint = ?')
    .get(fingerprint) as { id: string; payload: string } | undefined;

  if (existing) {
    return { incident: json<Incident>(existing.payload, incident), created: false };
  }

  const id = incident.id || `INC-${shortHash(fingerprint, 8).toUpperCase()}`;
  const stored: Incident = { ...incident, id };
  db.prepare(
    `INSERT INTO incidents (id, fingerprint, title, service, severity, source, payload, detected_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fingerprint,
    stored.title,
    stored.service,
    stored.severity,
    stored.source,
    JSON.stringify(stored),
    stored.detectedAt,
    nowIso(),
  );
  return { incident: stored, created: true };
}

export function getIncident(id: string): Incident | null {
  const row = getDb().prepare('SELECT payload FROM incidents WHERE id = ?').get(id) as
    | { payload: string }
    | undefined;
  return row ? json<Incident | null>(row.payload, null) : null;
}

export function listIncidents(): Incident[] {
  const rows = getDb()
    .prepare('SELECT payload FROM incidents ORDER BY received_at DESC')
    .all() as { payload: string }[];
  return rows.map((r) => json<Incident>(r.payload, {} as Incident));
}

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: row.id as string,
    incidentId: row.incident_id as string,
    status: row.status as RunStatus,
    currentStep: (row.current_step as StepName | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

/**
 * One run per incident. Calling this again for the same incident returns the
 * existing run, which is what makes "restart the workflow" resume rather than
 * duplicate.
 */
export function getOrCreateRun(
  incidentId: string,
  scenario?: string,
): { run: WorkflowRun; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM workflow_runs WHERE incident_id = ?')
    .get(incidentId) as Record<string, unknown> | undefined;
  if (existing) return { run: rowToRun(existing), created: false };

  const id = `run_${shortHash(incidentId, 12)}`;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO workflow_runs (id, incident_id, status, current_step, retry_count, scenario, created_at, updated_at)
     VALUES (?, ?, 'pending', NULL, 0, ?, ?, ?)`,
  ).run(id, incidentId, scenario ?? null, ts, ts);

  // Materialise the full step list so the UI can render the plan immediately.
  const insertStep = db.prepare(
    `INSERT OR IGNORE INTO workflow_steps (run_id, step, idx, status, attempts) VALUES (?, ?, ?, 'pending', 0)`,
  );
  STEP_NAMES.forEach((step, idx) => insertStep.run(id, step, idx));

  return { run: rowToRun(db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Record<string, unknown>), created: true };
}

export function getRun(runId: string): WorkflowRun | null {
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

export function getRunByIncident(incidentId: string): WorkflowRun | null {
  const row = getDb()
    .prepare('SELECT * FROM workflow_runs WHERE incident_id = ?')
    .get(incidentId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(): WorkflowRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToRun);
}

export function updateRun(
  runId: string,
  patch: Partial<Pick<WorkflowRun, 'status' | 'currentStep' | 'retryCount' | 'lastError' | 'startedAt' | 'finishedAt'>>,
): void {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const vals: (string | number | null)[] = [nowIso()];
  const map: Record<string, string> = {
    status: 'status',
    currentStep: 'current_step',
    retryCount: 'retry_count',
    lastError: 'last_error',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      vals.push((patch as Record<string, string | number | null>)[k] ?? null);
    }
  }
  vals.push(runId);
  db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function rowToStep(row: Record<string, unknown>): StepRecord {
  return {
    runId: row.run_id as string,
    step: row.step as StepName,
    status: row.status as StepStatus,
    attempts: Number(row.attempts ?? 0),
    error: (row.error as string | null) ?? null,
    output: json<unknown>(row.output as string | null, null),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  };
}

export function getStep(runId: string, step: StepName): StepRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM workflow_steps WHERE run_id = ? AND step = ?')
    .get(runId, step) as Record<string, unknown> | undefined;
  return row ? rowToStep(row) : null;
}

export function listSteps(runId: string): StepRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY idx')
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToStep);
}

export function markStepStarted(runId: string, step: StepName): number {
  const db = getDb();
  db.prepare(
    `UPDATE workflow_steps SET status='running', attempts = attempts + 1, started_at = ?, error = NULL
     WHERE run_id = ? AND step = ?`,
  ).run(nowIso(), runId, step);
  const row = db
    .prepare('SELECT attempts FROM workflow_steps WHERE run_id = ? AND step = ?')
    .get(runId, step) as { attempts: number } | undefined;
  return Number(row?.attempts ?? 1);
}

export function markStepSucceeded(runId: string, step: StepName, output: unknown, durationMs: number): void {
  getDb()
    .prepare(
      `UPDATE workflow_steps SET status='succeeded', output = ?, finished_at = ?, duration_ms = ?, error = NULL
       WHERE run_id = ? AND step = ?`,
    )
    .run(JSON.stringify(output ?? null), nowIso(), Math.round(durationMs), runId, step);
}

export function markStepFailed(runId: string, step: StepName, error: string, durationMs: number): void {
  getDb()
    .prepare(
      `UPDATE workflow_steps SET status='failed', error = ?, finished_at = ?, duration_ms = ?
       WHERE run_id = ? AND step = ?`,
    )
    .run(error.slice(0, 4000), nowIso(), Math.round(durationMs), runId, step);
}

export function markStepSkipped(runId: string, step: StepName, reason: string): void {
  getDb()
    .prepare(
      `UPDATE workflow_steps SET status='skipped', error = ?, finished_at = ? WHERE run_id = ? AND step = ?`,
    )
    .run(reason, nowIso(), runId, step);
}

/**
 * Crash recovery: any step left in 'running' by a hard kill is reset to
 * 'pending' so a restart retries exactly that step and nothing earlier.
 */
export function recoverStaleSteps(runId: string): StepName[] {
  const db = getDb();
  const stale = db
    .prepare(`SELECT step FROM workflow_steps WHERE run_id = ? AND status = 'running'`)
    .all(runId) as { step: StepName }[];
  if (stale.length) {
    db.prepare(`UPDATE workflow_steps SET status='pending' WHERE run_id = ? AND status='running'`).run(runId);
  }
  return stale.map((s) => s.step);
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

export function findMutation(key: string): MutationRecord | null {
  const row = getDb().prepare('SELECT * FROM mutations WHERE idempotency_key = ?').get(key) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    idempotencyKey: row.idempotency_key as string,
    runId: row.run_id as string,
    incidentId: row.incident_id as string,
    kind: row.kind as string,
    subject: (row.subject as string | null) ?? (row.kind as string),
    externalId: row.external_id as string,
    externalUrl: (row.external_url as string | null) ?? null,
    payloadHash: row.payload_hash as string,
    result: json<unknown>(row.result as string, null),
    createdAt: row.created_at as string,
  };
}

export interface IdempotencyArgs {
  key: string;
  runId: string;
  incidentId: string;
  kind: string;
  /**
   * The logical entity being created, independent of any generated name or id
   * (e.g. "incident_ticket", "pull_request:revert", "branch:fix"). Duplicate
   * detection groups on this, so a rerun that generated a *different* branch
   * name for the same role would still be caught.
   */
  subject: string;
  payload: unknown;
}

export interface ExternalResult {
  externalId: string;
  externalUrl?: string | null;
  [k: string]: unknown;
}

/**
 * The single choke point for every external mutation.
 *
 * Guarantees: for a given idempotency key the side effect executes at most
 * once, ever, across process restarts. A second call returns the recorded
 * result and is reported as a replay.
 */
export async function withIdempotency<T extends ExternalResult>(
  args: IdempotencyArgs,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const existing = findMutation(args.key);
  if (existing) {
    return { result: existing.result as T, replayed: true };
  }
  const result = await fn();
  const db = getDb();
  // INSERT OR IGNORE guards against a concurrent writer having won the race.
  db.prepare(
    `INSERT OR IGNORE INTO mutations
       (idempotency_key, run_id, incident_id, kind, subject, external_id, external_url, payload_hash, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.key,
    args.runId,
    args.incidentId,
    args.kind,
    args.subject,
    String(result.externalId),
    result.externalUrl ?? null,
    payloadHash(args.payload),
    JSON.stringify(result),
    nowIso(),
  );
  const settled = findMutation(args.key);
  return { result: (settled?.result as T) ?? result, replayed: false };
}

export function listMutations(incidentId?: string): MutationRecord[] {
  const db = getDb();
  const rows = (
    incidentId
      ? db.prepare('SELECT * FROM mutations WHERE incident_id = ? ORDER BY created_at').all(incidentId)
      : db.prepare('SELECT * FROM mutations ORDER BY created_at').all()
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    idempotencyKey: row.idempotency_key as string,
    runId: row.run_id as string,
    incidentId: row.incident_id as string,
    kind: row.kind as string,
    subject: (row.subject as string | null) ?? (row.kind as string),
    externalId: row.external_id as string,
    externalUrl: (row.external_url as string | null) ?? null,
    payloadHash: row.payload_hash as string,
    result: json<unknown>(row.result as string, null),
    createdAt: row.created_at as string,
  }));
}

/**
 * Duplicate-write detection.
 *
 * Groups on `subject` — the logical entity — rather than on `kind`. One
 * incident legitimately produces two branches and two pull requests (a revert
 * and a fix), so grouping on kind would report those as duplicates. Two
 * *incident tickets*, or two revert PRs, are genuine duplicates and are what
 * this must catch.
 */
export function duplicateWriteCount(incidentId?: string): number {
  const bySubject = new Map<string, Set<string>>();
  for (const m of listMutations(incidentId)) {
    const bucket = `${m.incidentId}::${m.subject}`;
    if (!bySubject.has(bucket)) bySubject.set(bucket, new Set());
    bySubject.get(bucket)!.add(m.externalId);
  }
  let dupes = 0;
  for (const ids of bySubject.values()) if (ids.size > 1) dupes += ids.size - 1;
  return dupes;
}

// ---------------------------------------------------------------------------
// Tool calls / timeline / safety
// ---------------------------------------------------------------------------

export function recordToolCall(rec: {
  runId: string | null;
  step: StepName | null;
  tool: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  mutating?: boolean;
  idempotencyKey?: string | null;
  replayed?: boolean;
  error?: string | null;
  durationMs: number;
}): void {
  const truncate = (v: unknown): string => {
    const s = JSON.stringify(v ?? null);
    return s.length > 20000 ? s.slice(0, 20000) + '..."[truncated]"' : s;
  };
  getDb()
    .prepare(
      `INSERT INTO tool_calls (run_id, step, tool, args, result, ok, mutating, idempotency_key, replayed, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.runId,
      rec.step,
      rec.tool,
      truncate(rec.args),
      truncate(rec.result),
      rec.ok ? 1 : 0,
      rec.mutating ? 1 : 0,
      rec.idempotencyKey ?? null,
      rec.replayed ? 1 : 0,
      rec.error ?? null,
      Math.round(rec.durationMs),
      nowIso(),
    );
}

export function listToolCalls(runId: string): ToolCallRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY id')
    .all(runId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id as string,
    step: (row.step as StepName | null) ?? null,
    tool: row.tool as string,
    args: json<unknown>(row.args as string | null, null),
    result: json<unknown>(row.result as string | null, null),
    ok: Number(row.ok) === 1,
    mutating: Number(row.mutating) === 1,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    replayed: Number(row.replayed) === 1,
    durationMs: Number(row.duration_ms ?? 0),
    createdAt: row.created_at as string,
  }));
}

export type TimelineKind =
  | 'step_started'
  | 'step_succeeded'
  | 'step_failed'
  | 'step_skipped'
  | 'retry'
  | 'replay'
  | 'info'
  | 'unsafe_blocked';

export interface TimelineEntry {
  id: number;
  runId: string;
  ts: string;
  kind: TimelineKind;
  step: StepName | null;
  message: string;
  detail: string | null;
}

export function addTimeline(
  runId: string,
  kind: TimelineKind,
  message: string,
  step: StepName | null = null,
  detail?: string,
): void {
  getDb()
    .prepare('INSERT INTO timeline (run_id, ts, kind, step, message, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, nowIso(), kind, step, message, detail ?? null);
}

export function listTimeline(runId: string): TimelineEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM timeline WHERE run_id = ? ORDER BY id')
    .all(runId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id as string,
    ts: row.ts as string,
    kind: row.kind as TimelineKind,
    step: (row.step as StepName | null) ?? null,
    message: row.message as string,
    detail: (row.detail as string | null) ?? null,
  }));
}

export function recordSafetyEvent(rec: {
  runId: string | null;
  action: string;
  target?: string | null;
  reason: string;
  blocked: boolean;
}): void {
  getDb()
    .prepare('INSERT INTO safety_events (run_id, action, target, reason, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rec.runId, rec.action, rec.target ?? null, rec.reason, rec.blocked ? 1 : 0, nowIso());
}

export function listSafetyEvents(runId?: string): {
  id: number;
  runId: string | null;
  action: string;
  target: string | null;
  reason: string;
  blocked: boolean;
  createdAt: string;
}[] {
  const db = getDb();
  const rows = (
    runId
      ? db.prepare('SELECT * FROM safety_events WHERE run_id = ? ORDER BY id').all(runId)
      : db.prepare('SELECT * FROM safety_events ORDER BY id').all()
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    runId: (row.run_id as string | null) ?? null,
    action: row.action as string,
    target: (row.target as string | null) ?? null,
    reason: row.reason as string,
    blocked: Number(row.blocked) === 1,
    createdAt: row.created_at as string,
  }));
}

/** Count of unsafe actions that were NOT blocked. Must always be zero. */
export function unsafeActionCount(runId?: string): number {
  return listSafetyEvents(runId).filter((e) => !e.blocked).length;
}

// ---------------------------------------------------------------------------
// Bridge intents (connector-delivered integrations)
// ---------------------------------------------------------------------------

export interface BridgeIntent {
  id: string;
  runId: string;
  incidentId: string;
  kind: string;
  payload: unknown;
  status: 'pending' | 'resolved' | 'failed';
  externalId: string | null;
  externalUrl: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function upsertBridgeIntent(intent: {
  id: string;
  runId: string;
  incidentId: string;
  kind: string;
  payload: unknown;
}): BridgeIntent {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO bridge_intents (id, run_id, incident_id, kind, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(intent.id, intent.runId, intent.incidentId, intent.kind, JSON.stringify(intent.payload), nowIso());
  return getBridgeIntent(intent.id)!;
}

export function getBridgeIntent(id: string): BridgeIntent | null {
  const row = getDb().prepare('SELECT * FROM bridge_intents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    runId: row.run_id as string,
    incidentId: row.incident_id as string,
    kind: row.kind as string,
    payload: json<unknown>(row.payload as string, null),
    status: row.status as BridgeIntent['status'],
    externalId: (row.external_id as string | null) ?? null,
    externalUrl: (row.external_url as string | null) ?? null,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

export function listBridgeIntents(status?: string): BridgeIntent[] {
  const db = getDb();
  const rows = (
    status
      ? db.prepare('SELECT * FROM bridge_intents WHERE status = ? ORDER BY created_at').all(status)
      : db.prepare('SELECT * FROM bridge_intents ORDER BY created_at').all()
  ) as Record<string, unknown>[];
  return rows.map((r) => getBridgeIntent(r.id as string)!).filter(Boolean);
}

export function resolveBridgeIntent(
  id: string,
  externalId: string,
  externalUrl: string | null,
): BridgeIntent | null {
  getDb()
    .prepare(
      `UPDATE bridge_intents SET status='resolved', external_id = ?, external_url = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(externalId, externalUrl, nowIso(), id);
  return getBridgeIntent(id);
}
