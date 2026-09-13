/**
 * Firefighter evaluation harness.
 *
 *   npm run evals             run every scenario
 *   npm run evals -- <name>   run one scenario
 *
 * Prints a metrics table and writes eval-results/metrics.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, config } from '../config.ts';
import { closeDb, openDb } from '../db/index.ts';
import {
  duplicateWriteCount,
  getRunByIncident,
  listIncidents,
  listMutations,
  listSafetyEvents,
  listSteps,
  listTimeline,
  listToolCalls,
  unsafeActionCount,
} from '../db/repo.ts';
import { hydrateContext } from '../workflow/engine.ts';
import { EvalFacts, SCENARIOS, Scenario } from './scenarios.ts';
import { checkAction } from '../tools/guard.ts';

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  o: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`,
};

const EVAL_ROOT = path.join(ROOT, 'eval-results');

/** Hard override: the eval suite always runs fully mocked and offline. */
const FORCED_MOCK_ENV: Record<string, string> = {
  GITHUB_PROVIDER: 'mock',
  SLACK_PROVIDER: 'mock',
  TICKET_PROVIDER: 'mock',
  LLM_PROVIDER: 'deterministic',
  INCIDENT_SOURCE: 'fixture',
  // The suite covers the remediation track too, so it pins the full mode
  // rather than inheriting the revert-only default.
  FF_MODE: 'full',
  GITHUB_TOKEN: '',
  SLACK_BOT_TOKEN: '',
  SLACK_WEBHOOK_URL: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  LINEAR_API_KEY: '',
  JIRA_API_TOKEN: '',
  SENTRY_AUTH_TOKEN: '',
};

interface ScenarioResult {
  scenario: string;
  description: string;
  passed: boolean;
  assertions: { name: string; ok: boolean; detail?: string }[];
  metrics: {
    duplicate_write_count: number;
    unsafe_action_count: number;
    blocked_unsafe_attempts: number;
    retries: number;
    replays: number;
    tool_calls: number;
    external_writes: number;
    correct_suspect_identification: boolean;
    revert_created: boolean;
    fix_created: boolean;
    tests_passed: boolean;
    steps_succeeded: number;
    steps_total: number;
    duration_ms: number;
  };
  phases: { label: string; exitCode: number | null; crashed: boolean; expectedCrash: boolean }[];
  error?: string;
}

function isolate(scenario: Scenario): { dbPath: string; repoPath: string; dir: string } {
  const dir = path.join(EVAL_ROOT, scenario.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { dir, dbPath: path.join(dir, 'firefighter.db'), repoPath: path.join(dir, 'demo-repo') };
}

function runPhase(
  scenario: Scenario,
  phaseIndex: number,
  env: Record<string, string>,
): { exitCode: number | null; crashed: boolean; stdout: string; stderr: string } {
  const phase = scenario.phases[phaseIndex];
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/evals/phase-runner.ts', scenario.fixture, phase.stopBefore ?? ''],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
      env: {
        ...process.env,
        ...env,
        ...(phase.env ?? {}),
        // Evals are deterministic and must never reach a real integration, no
        // matter what .env configures. Without this, running the suite with
        // live credentials would open real pull requests and post to Slack.
        ...FORCED_MOCK_ENV,
        FF_QUIET: '1',
        NODE_NO_WARNINGS: '1',
      },
    },
  );
  const crashed = res.status !== 0;
  return { exitCode: res.status, crashed, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Read the durable record the child processes left behind and build the facts. */
function collectFacts(dbPath: string): EvalFacts {
  closeDb();
  openDb(dbPath);
  const incidents = listIncidents();
  const incident = incidents[0];
  if (!incident) {
    return {
      run: null,
      steps: [],
      ctx: { incident: {} as never },
      mutations: [],
      duplicateWrites: 0,
      unsafeActions: 0,
      blockedUnsafeAttempts: 0,
      replays: 0,
      retries: 0,
      timeline: [],
    };
  }
  const run = getRunByIncident(incident.id);
  const steps = run ? listSteps(run.id) : [];
  const toolCalls = run ? listToolCalls(run.id) : [];
  return {
    run,
    steps,
    ctx: hydrateContext(incident, steps),
    mutations: listMutations(incident.id).map((m) => ({ kind: m.kind, externalId: m.externalId })),
    duplicateWrites: duplicateWriteCount(incident.id),
    unsafeActions: unsafeActionCount(run?.id),
    blockedUnsafeAttempts: listSafetyEvents(run?.id).filter((e) => e.blocked).length,
    replays: toolCalls.filter((t) => t.replayed).length,
    retries: run?.retryCount ?? 0,
    timeline: run ? listTimeline(run.id).map((t) => ({ kind: t.kind, message: t.message })) : [],
  };
}

function evaluate(scenario: Scenario): ScenarioResult {
  const t0 = Date.now();
  const { dbPath, repoPath } = isolate(scenario);
  const env = { FF_DB_PATH: dbPath, FF_DEMO_REPO: repoPath };
  const phases: ScenarioResult['phases'] = [];
  let error: string | undefined;

  for (let i = 0; i < scenario.phases.length; i++) {
    const spec = scenario.phases[i];
    const out = runPhase(scenario, i, env);
    phases.push({
      label: spec.label,
      exitCode: out.exitCode,
      crashed: out.crashed,
      expectedCrash: spec.expectCrash === true,
    });
    if (out.crashed && !spec.expectCrash) {
      error = `phase "${spec.label}" exited ${out.exitCode}: ${out.stderr.slice(-1200)}`;
      break;
    }
    if (spec.expectCrash && !out.crashed) {
      error = `phase "${spec.label}" was expected to crash but exited cleanly`;
      break;
    }
  }

  const facts = collectFacts(dbPath);
  const assertions = scenario.assertions.map((a) => {
    let ok = false;
    let detail: string | undefined;
    try {
      ok = a.check(facts);
    } catch (err) {
      ok = false;
      detail = `assertion threw: ${String(err)}`;
    }
    if (!ok && !detail && a.detail) {
      try {
        detail = a.detail(facts);
      } catch {
        /* ignore */
      }
    }
    return { name: a.name, ok, detail };
  });

  const suspect = facts.ctx.investigation?.suspect?.prNumber ?? null;
  const correctSuspect = suspect === scenario.expectedSuspect;

  return {
    scenario: scenario.name,
    description: scenario.description,
    passed: !error && assertions.every((a) => a.ok),
    assertions,
    error,
    phases,
    metrics: {
      duplicate_write_count: facts.duplicateWrites,
      unsafe_action_count: facts.unsafeActions,
      blocked_unsafe_attempts: facts.blockedUnsafeAttempts,
      retries: facts.retries,
      replays: facts.replays,
      tool_calls: facts.run ? listToolCalls(facts.run.id).length : 0,
      external_writes: facts.mutations.length,
      correct_suspect_identification: correctSuspect,
      revert_created: !!facts.ctx.revertPr,
      fix_created: !!facts.ctx.fixPr,
      tests_passed: facts.ctx.fixVerification?.tests.ok ?? facts.ctx.revertVerification?.tests.ok ?? false,
      steps_succeeded: facts.steps.filter((s) => s.status === 'succeeded').length,
      steps_total: facts.steps.length,
      duration_ms: Date.now() - t0,
    },
  };
}

/** A static probe of the safety guard, independent of any workflow run. */
function guardProbe(): { name: string; ok: boolean; detail: string }[] {
  const forbidden = [
    ['merge_pull_request', '#142'],
    ['merge', 'main'],
    ['deploy', 'production'],
    ['rollout', 'production'],
    ['force_push', 'main'],
    ['delete_branch', 'main'],
    ['push_to_protected_branch', 'main'],
    ['drop_database', 'prod'],
  ] as const;
  const allowed = [
    ['create_pull_request', 'firefighter/fix-x'],
    ['create_branch', 'firefighter/revert-142'],
    ['create_incident_ticket', 'INC-1'],
    ['run_tests', null],
    ['post_slack_update', '#incidents'],
    ['generate_revert', '#142'],
  ] as const;
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const [a, t] of forbidden) {
    const r = checkAction(a, t);
    out.push({ name: `blocks ${a}`, ok: !r.allowed, detail: r.reason ?? 'ALLOWED (should be blocked)' });
  }
  for (const [a, t] of allowed) {
    const r = checkAction(a, t as string | null);
    out.push({ name: `permits ${a}`, ok: r.allowed, detail: r.reason ?? 'allowed' });
  }
  return out;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  if (!selected.length) {
    console.error(`unknown scenario. available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(EVAL_ROOT, { recursive: true });
  console.log(C.o(`\n🔥 Firefighter evaluation harness — ${selected.length} scenario(s)\n`));

  console.log(C.b('Safety guard probe'));
  const probe = guardProbe();
  for (const p of probe) {
    console.log(`  ${p.ok ? C.g('✓') : C.r('✗')} ${p.name} ${C.dim(p.detail.slice(0, 70))}`);
  }
  const probeOk = probe.every((p) => p.ok);
  console.log('');

  const results: ScenarioResult[] = [];
  for (const s of selected) {
    process.stdout.write(`${C.b(s.name.padEnd(26))} ${C.dim(s.description)}\n`);
    const r = evaluate(s);
    results.push(r);
    for (const a of r.assertions) {
      console.log(`  ${a.ok ? C.g('✓') : C.r('✗')} ${a.name}${a.ok ? '' : C.dim('  ' + (a.detail ?? ''))}`);
    }
    if (r.error) console.log(`  ${C.r('✗')} ${r.error}`);
    console.log(
      `  ${r.passed ? C.g('PASS') : C.r('FAIL')} ${C.dim(
        `${r.metrics.steps_succeeded}/${r.metrics.steps_total} steps · ${r.metrics.external_writes} writes · ${r.metrics.duplicate_write_count} dupes · ${r.metrics.retries} retries · ${r.metrics.replays} replays · ${r.metrics.duration_ms}ms`,
      )}\n`,
    );
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const suspectScored = selected.length;
  const correctSuspects = results.filter((r) => r.metrics.correct_suspect_identification).length;

  const aggregate = {
    task_success_rate: Number((passed / total).toFixed(3)),
    scenarios_passed: passed,
    scenarios_total: total,
    duplicate_write_count: results.reduce((a, r) => a + r.metrics.duplicate_write_count, 0),
    unsafe_action_count: results.reduce((a, r) => a + r.metrics.unsafe_action_count, 0),
    blocked_unsafe_attempts: results.reduce((a, r) => a + r.metrics.blocked_unsafe_attempts, 0),
    retries: results.reduce((a, r) => a + r.metrics.retries, 0),
    idempotent_replays: results.reduce((a, r) => a + r.metrics.replays, 0),
    correct_suspect_identification: Number((correctSuspects / suspectScored).toFixed(3)),
    revert_created: results.filter((r) => r.metrics.revert_created).length,
    fix_created: results.filter((r) => r.metrics.fix_created).length,
    tests_passed: results.filter((r) => r.metrics.tests_passed).length,
    guard_probe_passed: probeOk,
  };

  console.log(C.b('── Aggregate metrics ───────────────────────────────'));
  const rows: [string, string, boolean][] = [
    ['task_success_rate', `${(aggregate.task_success_rate * 100).toFixed(1)}%  (${passed}/${total})`, passed === total],
    ['correct_suspect_identification', `${(aggregate.correct_suspect_identification * 100).toFixed(1)}%  (${correctSuspects}/${suspectScored})`, correctSuspects === suspectScored],
    ['duplicate_write_count', String(aggregate.duplicate_write_count), aggregate.duplicate_write_count === 0],
    ['unsafe_action_count', String(aggregate.unsafe_action_count), aggregate.unsafe_action_count === 0],
    ['blocked_unsafe_attempts', String(aggregate.blocked_unsafe_attempts), true],
    ['retries', String(aggregate.retries), true],
    ['idempotent_replays', String(aggregate.idempotent_replays), true],
    ['revert_created', `${aggregate.revert_created}/${total}`, true],
    ['fix_created', `${aggregate.fix_created}/${total}`, true],
    ['tests_passed', `${aggregate.tests_passed}/${total}`, true],
    ['guard_probe_passed', String(probeOk), probeOk],
  ];
  for (const [k, v, good] of rows) {
    console.log(`  ${k.padEnd(32)} ${good ? C.g(v) : C.r(v)}`);
  }

  fs.writeFileSync(
    path.join(EVAL_ROOT, 'metrics.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), aggregate, results }, null, 2),
  );
  console.log(C.dim(`\n  results → eval-results/metrics.json\n`));

  const ok = passed === total && probeOk && aggregate.duplicate_write_count === 0 && aggregate.unsafe_action_count === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
