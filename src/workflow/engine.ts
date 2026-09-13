/**
 * The durable workflow engine.
 *
 * Guarantees:
 *   - Steps are executed in order and persisted individually. A succeeded step
 *     is never re-executed, so restarting after a crash resumes exactly where
 *     it stopped.
 *   - A step left 'running' by a hard kill is recovered to 'pending' and retried.
 *   - Workflow context is rebuilt deterministically from persisted step outputs.
 *   - Failed steps retry with backoff. Non-critical steps degrade to 'blocked'
 *     and the run continues, so a broken fix track never suppresses the
 *     mitigation track or the Slack update.
 */
import { Config, config as defaultConfig } from '../config.ts';
import {
  Incident,
  StepName,
  StepRecord,
  STEP_NAMES,
  WorkflowContext,
  WorkflowRun,
} from '../types.ts';
import {
  addTimeline,
  getOrCreateRun,
  getRunByIncident,
  listSteps,
  markStepFailed,
  markStepSkipped,
  markStepStarted,
  markStepSucceeded,
  recoverStaleSteps,
  updateRun,
  upsertIncident,
} from '../db/repo.ts';
import { createTools, ToolContext, Tools } from '../tools/index.ts';
import { UnsafeActionError } from '../tools/guard.ts';
import { nowMs } from '../util/clock.ts';
import { logger } from '../util/log.ts';
import { STEPS, STEP_TITLES } from './steps.ts';
export type { StepDef, StepHelpers } from './types.ts';

const log = logger('engine');

export interface EngineEvent {
  type: 'step_started' | 'step_succeeded' | 'step_failed' | 'step_skipped' | 'retry' | 'resume' | 'blocked';
  step: StepName;
  attempt?: number;
  message: string;
  error?: string;
}

export interface RunOptions {
  incident: Incident;
  cfg?: Config;
  scenario?: string;
  /** Stop cleanly before this step — used to demo/resume a partial workflow. */
  stopBefore?: StepName;
  onEvent?: (ev: EngineEvent) => void;
}

export interface RunOutcome {
  run: WorkflowRun;
  context: WorkflowContext;
  steps: StepRecord[];
  blocked: { step: StepName; reason: string }[];
  resumed: boolean;
  replayedSteps: StepName[];
}

class InjectedFailure extends Error {
  constructor(step: string, mode: string) {
    super(`injected ${mode} failure in ${step}`);
    this.name = 'InjectedFailure';
  }
}

interface Injection {
  step: string;
  mode: 'transient' | 'always';
  count: number;
}

function parseInjections(spec: string): Injection[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [step, mode = 'transient', count = '1'] = entry.split(':');
      return {
        step: step.trim(),
        mode: (mode.trim() === 'always' ? 'always' : 'transient') as 'transient' | 'always',
        count: Number(count) || 1,
      };
    });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Rebuild accumulated context from the durable record of completed steps.
 * This is what makes resume lossless without keeping anything in memory.
 */
export function hydrateContext(incident: Incident, steps: StepRecord[]): WorkflowContext {
  const ctx: WorkflowContext = { incident };
  for (const s of steps) {
    if (s.status !== 'succeeded' || !s.output || typeof s.output !== 'object') continue;
    Object.assign(ctx, s.output as Partial<WorkflowContext>);
  }
  ctx.incident = incident;
  return ctx;
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const cfg = opts.cfg ?? defaultConfig;
  const emit = (ev: EngineEvent): void => {
    opts.onEvent?.(ev);
  };

  // 1. Incident ingest is itself idempotent: identical incidents collapse onto
  //    one id, so re-posting an alert cannot fork a second investigation.
  const { incident, created: incidentCreated } = upsertIncident(opts.incident);
  const { run, created: runCreated } = getOrCreateRun(incident.id, opts.scenario);
  const resumed = !runCreated;

  if (!incidentCreated && runCreated) {
    log.info(`incident ${incident.id} already known; starting its first run`);
  }

  // 2. Crash recovery.
  const stale = recoverStaleSteps(run.id);
  for (const s of stale) {
    addTimeline(run.id, 'info', `Recovered step left running by an interrupted process`, s);
    emit({ type: 'resume', step: s, message: `Recovered interrupted step: ${s}` });
  }

  if (resumed) {
    addTimeline(run.id, 'info', 'Workflow resumed — completed steps will not re-run');
  }

  updateRun(run.id, {
    status: 'running',
    lastError: null,
    startedAt: run.startedAt ?? new Date(nowMs()).toISOString(),
  });

  let steps = listSteps(run.id);
  const context = hydrateContext(incident, steps);

  const toolCtx: ToolContext = { runId: run.id, incidentId: incident.id, cfg, step: null };
  const tools: Tools = createTools(toolCtx);

  const injections = parseInjections(cfg.failInject);
  const blocked: { step: StepName; reason: string }[] = [];
  const replayedSteps: StepName[] = [];

  for (const stepName of STEP_NAMES) {
    const def = STEPS[stepName];
    const record = steps.find((s) => s.step === stepName);

    if (record?.status === 'succeeded') {
      replayedSteps.push(stepName);
      log.debug(`${stepName}: already succeeded, skipping`);
      continue;
    }
    if (record?.status === 'skipped') continue;

    if (opts.stopBefore && stepName === opts.stopBefore) {
      addTimeline(run.id, 'info', `Paused before ${STEP_TITLES[stepName].gerund}`, stepName);
      updateRun(run.id, { status: 'pending', currentStep: stepName });
      return finish(run.id, incident, blocked, resumed, replayedSteps, 'paused');
    }

    // Preconditions let a failed upstream step short-circuit its dependents
    // without failing the whole run.
    const pre = def.precondition?.(context);
    if (pre && !pre.ok) {
      markStepSkipped(run.id, stepName, pre.reason ?? 'precondition not met');
      addTimeline(run.id, 'step_skipped', `${STEP_TITLES[stepName].skipped}: ${pre.reason ?? ''}`, stepName);
      emit({ type: 'step_skipped', step: stepName, message: pre.reason ?? 'skipped' });
      blocked.push({ step: stepName, reason: pre.reason ?? 'precondition not met' });
      continue;
    }

    toolCtx.step = stepName;
    updateRun(run.id, { currentStep: stepName, status: 'running' });

    let lastError: Error | null = null;
    let succeeded = false;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      const attempts = markStepStarted(run.id, stepName);
      const t0 = nowMs();
      addTimeline(
        run.id,
        'step_started',
        attempts > 1
          ? `${STEP_TITLES[stepName].gerund} (attempt ${attempts})`
          : STEP_TITLES[stepName].gerund,
        stepName,
      );
      emit({ type: 'step_started', step: stepName, attempt: attempts, message: STEP_TITLES[stepName].gerund });

      try {
        const inj = injections.find((i) => i.step === stepName);
        if (inj && (inj.mode === 'always' || attempts <= inj.count)) {
          throw new InjectedFailure(stepName, inj.mode);
        }

        const output = await def.run(context, tools, { attempt: attempts, cfg, runId: run.id });
        Object.assign(context, output);
        markStepSucceeded(run.id, stepName, output, nowMs() - t0);
        addTimeline(run.id, 'step_succeeded', STEP_TITLES[stepName].done(context), stepName);
        emit({ type: 'step_succeeded', step: stepName, message: STEP_TITLES[stepName].done(context) });
        succeeded = true;
        break;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        markStepFailed(run.id, stepName, error.message, nowMs() - t0);
        addTimeline(run.id, 'step_failed', `${STEP_TITLES[stepName].failed}: ${error.message}`, stepName, error.stack ?? undefined);
        emit({ type: 'step_failed', step: stepName, attempt: attempts, message: error.message, error: error.message });
        log.warn(`${stepName} attempt ${attempts} failed: ${error.message}`);

        // An unsafe action is never retried — it is a hard stop by design.
        if (error instanceof UnsafeActionError) {
          updateRun(run.id, { status: 'failed', lastError: error.message, finishedAt: new Date(nowMs()).toISOString() });
          throw error;
        }

        if (attempts < cfg.maxAttempts) {
          const delay = cfg.retryBaseMs * 2 ** (attempts - 1);
          addTimeline(run.id, 'retry', `Retrying ${stepName} in ${delay}ms (${attempts}/${cfg.maxAttempts})`, stepName);
          emit({ type: 'retry', step: stepName, attempt: attempts, message: `retry in ${delay}ms` });
          updateRun(run.id, { retryCount: (getRunByIncident(incident.id)?.retryCount ?? 0) + 1, lastError: error.message });
          await sleep(delay);
        }
      }
    }

    if (!succeeded) {
      const reason = lastError?.message ?? 'unknown failure';
      if (def.critical) {
        updateRun(run.id, {
          status: 'failed',
          lastError: reason,
          finishedAt: new Date(nowMs()).toISOString(),
        });
        addTimeline(run.id, 'step_failed', `Run halted: ${stepName} is critical and exhausted retries`, stepName);
        return finish(run.id, incident, blocked, resumed, replayedSteps, 'failed');
      }
      blocked.push({ step: stepName, reason });
      addTimeline(
        run.id,
        'info',
        `${stepName} could not complete after ${cfg.maxAttempts} attempts — continuing without it`,
        stepName,
      );
      emit({ type: 'blocked', step: stepName, message: reason });
    }
  }

  toolCtx.step = null;
  return finish(run.id, incident, blocked, resumed, replayedSteps, 'succeeded');
}

function finish(
  runId: string,
  incident: Incident,
  blocked: { step: StepName; reason: string }[],
  resumed: boolean,
  replayedSteps: StepName[],
  outcome: 'succeeded' | 'failed' | 'paused',
): RunOutcome {
  if (outcome === 'succeeded') {
    updateRun(runId, {
      status: 'succeeded',
      currentStep: 'complete',
      finishedAt: new Date(nowMs()).toISOString(),
      lastError: null,
    });
    addTimeline(runId, 'info', blocked.length ? 'Workflow complete with blocked steps' : 'Workflow complete');
  }
  const steps = listSteps(runId);
  const run = getRunByIncident(incident.id)!;
  return { run, context: hydrateContext(incident, steps), steps, blocked, resumed, replayedSteps };
}
