import {
  duplicateWriteCount,
  getIncident,
  listBridgeIntents,
  listRuns,
  listSafetyEvents,
  listSteps,
  listTimeline,
  listToolCalls,
  listMutations,
  getRunByIncident,
  unsafeActionCount,
} from '../db/repo.ts';
import { hydrateContext } from '../workflow/engine.ts';
import { STEP_TITLES } from '../workflow/steps.ts';
import { CulpritVerification, Incident, StepName, WorkflowRun } from '../types.ts';

export interface DashboardState {
  incident: Incident | null;
  run: WorkflowRun | null;
  steps: {
    step: StepName;
    title: string;
    status: string;
    attempts: number;
    error: string | null;
    durationMs: number | null;
  }[];
  timeline: ReturnType<typeof listTimeline>;
  toolCalls: ReturnType<typeof listToolCalls>;
  investigation: unknown;
  /** Causal proof of which change introduced the fault. Not the test/lint `verification` below. */
  culpritVerification: CulpritVerification | null;
  ticket: unknown;
  revertPr: unknown;
  fixPr: unknown;
  slack: unknown;
  repro: unknown;
  fixPlan: unknown;
  verification: { revert: unknown; fix: unknown };
  summary: unknown;
  metrics: {
    retries: number;
    duplicateWrites: number;
    unsafeActions: number;
    blockedAttempts: number;
    mutations: number;
    replays: number;
    toolCalls: number;
  };
  safetyEvents: ReturnType<typeof listSafetyEvents>;
  bridgeIntents: ReturnType<typeof listBridgeIntents>;
}

/** Assemble everything the dashboard renders for one incident, from the DB alone. */
export function buildDashboardState(incidentId: string): DashboardState | null {
  const incident = getIncident(incidentId);
  if (!incident) return null;
  const run = getRunByIncident(incidentId);
  if (!run) {
    return {
      incident,
      run: null,
      steps: [],
      timeline: [],
      toolCalls: [],
      investigation: null,
      culpritVerification: null,
      ticket: null,
      revertPr: null,
      fixPr: null,
      slack: null,
      repro: null,
      fixPlan: null,
      verification: { revert: null, fix: null },
      summary: null,
      metrics: { retries: 0, duplicateWrites: 0, unsafeActions: 0, blockedAttempts: 0, mutations: 0, replays: 0, toolCalls: 0 },
      safetyEvents: [],
      bridgeIntents: [],
    };
  }

  const stepRecords = listSteps(run.id);
  const ctx = hydrateContext(incident, stepRecords);
  const toolCalls = listToolCalls(run.id);
  const safetyEvents = listSafetyEvents(run.id);

  return {
    incident,
    run,
    steps: stepRecords.map((s) => ({
      step: s.step,
      title: STEP_TITLES[s.step]?.gerund ?? s.step,
      status: s.status,
      attempts: s.attempts,
      error: s.error,
      durationMs: s.durationMs,
    })),
    timeline: listTimeline(run.id),
    toolCalls,
    investigation: ctx.investigation ?? null,
    culpritVerification: ctx.culpritVerification ?? null,
    ticket: ctx.ticket ?? null,
    revertPr: ctx.revertPr ?? null,
    fixPr: ctx.fixPr ?? null,
    slack: ctx.slack ?? null,
    repro: ctx.repro ?? null,
    fixPlan: ctx.fixPlan ?? null,
    verification: { revert: ctx.revertVerification ?? null, fix: ctx.fixVerification ?? null },
    summary: ctx.summary ?? null,
    metrics: {
      retries: run.retryCount,
      duplicateWrites: duplicateWriteCount(incidentId),
      unsafeActions: unsafeActionCount(run.id),
      blockedAttempts: safetyEvents.filter((e) => e.blocked).length,
      mutations: listMutations(incidentId).length,
      replays: toolCalls.filter((t) => t.replayed).length,
      toolCalls: toolCalls.length,
    },
    safetyEvents,
    bridgeIntents: listBridgeIntents().filter((b) => b.incidentId === incidentId),
  };
}

export function listDashboardIncidents(): { incident: Incident; run: WorkflowRun | null }[] {
  return listRuns().map((run) => ({ incident: getIncident(run.incidentId)!, run }));
}
