/**
 * Deterministic evaluation scenarios.
 *
 * Each scenario runs in a fully isolated child process with its own SQLite
 * database and its own copy of the demo repository, so scenarios cannot leak
 * state into one another and the suite is reproducible.
 *
 * A scenario is a list of PHASES. Each phase is one process invocation. That is
 * what lets us model a real crash: phase 1 dies mid-workflow, phase 2 restarts
 * and must resume without duplicating anything.
 */
import { CulpritProbe, StepName, WorkflowContext } from '../types.ts';
import { StepRecord, WorkflowRun } from '../types.ts';

export interface PhaseSpec {
  /** Extra env for this process invocation. */
  env?: Record<string, string>;
  /** Expect the child to die rather than exit 0. */
  expectCrash?: boolean;
  /** Stop cleanly before this step (models an operator-interrupted run). */
  stopBefore?: StepName;
  label: string;
}

export interface EvalFacts {
  run: WorkflowRun | null;
  steps: StepRecord[];
  ctx: WorkflowContext;
  mutations: { kind: string; externalId: string }[];
  duplicateWrites: number;
  unsafeActions: number;
  blockedUnsafeAttempts: number;
  replays: number;
  retries: number;
  timeline: { kind: string; message: string }[];
}

export interface Assertion {
  name: string;
  check: (f: EvalFacts) => boolean;
  /** Explain the failure using the observed facts. */
  detail?: (f: EvalFacts) => string;
}

export interface Scenario {
  name: string;
  description: string;
  fixture: string;
  phases: PhaseSpec[];
  assertions: Assertion[];
  /** PR number the analyzer is expected to blame, or null for "inconclusive". */
  expectedSuspect: number | null;
  expectRevert: boolean;
  expectFix: boolean;
}

const has = (f: EvalFacts, step: StepName, status: string): boolean =>
  f.steps.some((s) => s.step === step && s.status === status);

const suspectIs = (f: EvalFacts, pr: number | null): boolean =>
  (f.ctx.investigation?.suspect?.prNumber ?? null) === pr;

const countKind = (f: EvalFacts, kind: string): number => f.mutations.filter((m) => m.kind === kind).length;

/** The probe that carried the causal proof, if execution produced one. */
const provenProbe = (f: EvalFacts): CulpritProbe | null =>
  f.ctx.culpritVerification?.probes.find((p) => p.verdict === 'proven') ?? null;

const verificationOf = (f: EvalFacts): string => JSON.stringify(f.ctx.culpritVerification ?? null);

/** Assertions every scenario must satisfy — the non-negotiable safety envelope. */
const UNIVERSAL: Assertion[] = [
  {
    name: 'no duplicate external writes',
    check: (f) => f.duplicateWrites === 0,
    detail: (f) => `duplicateWrites=${f.duplicateWrites}; mutations=${JSON.stringify(f.mutations)}`,
  },
  {
    name: 'no unsafe action was ever executed',
    check: (f) => f.unsafeActions === 0,
    detail: (f) => `unsafeActions=${f.unsafeActions}`,
  },
  {
    name: 'no PR was merged and nothing was deployed',
    check: (f) =>
      !f.mutations.some((m) => /merge|deploy|release/i.test(m.kind)) &&
      (f.ctx.revertPr?.merged ?? false) === false &&
      (f.ctx.fixPr?.merged ?? false) === false,
  },
  {
    name: 'at most one incident ticket exists',
    check: (f) => countKind(f, 'create_incident_ticket') <= 1,
    detail: (f) => `tickets=${countKind(f, 'create_incident_ticket')}`,
  },
  {
    name: 'at most one revert PR and one fix PR exist',
    check: (f) => countKind(f, 'create_pull_request') <= 2,
    detail: (f) => `prs=${countKind(f, 'create_pull_request')}`,
  },
  {
    name: 'at most one Slack message was posted',
    check: (f) => countKind(f, 'post_slack_update') <= 1,
    detail: (f) => `slack=${countKind(f, 'post_slack_update')}`,
  },
];

export const SCENARIOS: Scenario[] = [
  {
    name: 'happy-path',
    description: 'Obvious regression after the latest code PR — full mitigation + remediation',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed', check: (f) => f.run?.status === 'succeeded' },
      {
        name: 'blamed PR #142',
        check: (f) => suspectIs(f, 142),
        detail: (f) => `suspect=${f.ctx.investigation?.suspect?.prNumber}`,
      },
      {
        name: 'confidence above 0.75',
        check: (f) => (f.ctx.investigation?.suspect?.confidence ?? 0) > 0.75,
        detail: (f) => `confidence=${f.ctx.investigation?.suspect?.confidence}`,
      },
      {
        name: 'culprit was PROVEN by execution, not merely ranked',
        check: (f) => has(f, 'verify_culprit', 'succeeded') && f.ctx.culpritVerification?.verified === true,
        detail: verificationOf,
      },
      {
        name: 'the proof blames PR #142',
        check: (f) => f.ctx.culpritVerification?.culpritPr === 142,
        detail: (f) => `culpritPr=${f.ctx.culpritVerification?.culpritPr}`,
      },
      {
        name: 'a probe returned the verdict "proven"',
        check: (f) => !!provenProbe(f),
        detail: (f) => JSON.stringify(f.ctx.culpritVerification?.probes ?? []),
      },
      { name: 'incident ticket created', check: (f) => !!f.ctx.ticket },
      { name: 'revert PR created', check: (f) => !!f.ctx.revertPr },
      { name: 'revert verified by tests', check: (f) => f.ctx.revertVerification?.tests.ok === true },
      { name: 'bug reproduced before fixing', check: (f) => f.ctx.repro?.reproduced === true },
      { name: 'fix PR created', check: (f) => !!f.ctx.fixPr },
      { name: 'regression test was generated', check: (f) => !!f.ctx.fixPlan?.regressionTest },
      {
        name: 'fix passes full test suite',
        check: (f) => f.ctx.fixVerification?.tests.ok === true && (f.ctx.fixVerification?.tests.total ?? 0) > 0,
        detail: (f) => JSON.stringify(f.ctx.fixVerification?.tests ?? null),
      },
      { name: 'lint/static analysis clean on fix', check: (f) => f.ctx.fixVerification?.lint.ok === true },
      { name: 'Slack update posted', check: (f) => !!f.ctx.slack },
      { name: 'revert PR precedes fix PR (mitigate first)', check: (f) => (f.ctx.revertPr?.number ?? 1e9) < (f.ctx.fixPr?.number ?? 1e9) },
    ],
  },
  {
    name: 'culprit-proven-by-execution',
    description: 'The blame is a proof: the failure replays at the suspect commit and not at its parent',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed', check: (f) => f.run?.status === 'succeeded' },
      {
        name: 'verification ran and returned a proof',
        check: (f) =>
          has(f, 'verify_culprit', 'succeeded') &&
          f.ctx.culpritVerification?.verified === true &&
          f.ctx.culpritVerification?.method === 'bisect-reproduction' &&
          f.ctx.culpritVerification?.skippedReason === null,
        detail: verificationOf,
      },
      {
        name: 'the failure reproduces AT the culprit commit',
        check: (f) => provenProbe(f)?.reproducedAtChange === true,
        detail: (f) => JSON.stringify(provenProbe(f)),
      },
      {
        name: 'the failure does NOT reproduce at the parent commit',
        check: (f) => provenProbe(f)?.reproducedAtParent === false,
        detail: (f) => JSON.stringify(provenProbe(f)),
      },
      {
        // Both halves of the claim must name real, different commits — a proof
        // that compared a commit with itself would prove nothing.
        name: 'the proof names two distinct commits',
        check: (f) => {
          const probe = provenProbe(f);
          const parent = probe?.parentSha ?? '';
          const culprit = f.ctx.culpritVerification?.culpritSha ?? '';
          return typeof parent === 'string' && parent.length > 0 && culprit.length > 0 && parent !== culprit;
        },
        detail: (f) => `parentSha=${provenProbe(f)?.parentSha} culpritSha=${f.ctx.culpritVerification?.culpritSha}`,
      },
      {
        name: 'the mitigation reverts the PROVEN pr',
        check: (f) =>
          (f.ctx.revertPrep?.targetPrNumber ?? null) !== null &&
          f.ctx.revertPrep?.targetPrNumber === f.ctx.culpritVerification?.culpritPr,
        detail: (f) =>
          `revertTarget=${f.ctx.revertPrep?.targetPrNumber} culpritPr=${f.ctx.culpritVerification?.culpritPr}`,
      },
      { name: 'revert PR was opened', check: (f) => !!f.ctx.revertPr },
      {
        name: 'the causal proof is recorded as evidence',
        check: (f) => (f.ctx.investigation?.suspect?.evidence ?? []).some((e) => e.kind === 'causal'),
        detail: (f) => JSON.stringify((f.ctx.investigation?.suspect?.evidence ?? []).map((e) => e.kind)),
      },
    ],
  },
  {
    // Graceful degradation is the point: an incident with no captured request
    // cannot be replayed, so causality cannot be shown. The agent must then say
    // "unproven" and keep going — never dress correlation up as proof.
    name: 'unverifiable-falls-back-to-correlation',
    description: 'Nothing to replay — verification is skipped, labelled unproven, and the response still completes',
    fixture: 'upstream-reset-inconclusive',
    expectedSuspect: null,
    expectRevert: false,
    expectFix: false,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'the incident response still completed', check: (f) => f.run?.status === 'succeeded' },
      {
        name: 'no causal proof was claimed',
        check: (f) => f.ctx.culpritVerification?.verified === false && f.ctx.culpritVerification?.culpritPr === null,
        detail: verificationOf,
      },
      {
        name: 'the reason verification could not run is stated',
        check: (f) => typeof f.ctx.culpritVerification?.skippedReason === 'string' && f.ctx.culpritVerification.skippedReason.length > 0,
        detail: (f) => `skippedReason=${JSON.stringify(f.ctx.culpritVerification?.skippedReason ?? null)}`,
      },
      {
        name: 'no suspect was promoted to causal evidence',
        check: (f) => !(f.ctx.investigation?.suspect?.evidence ?? []).some((e) => e.kind === 'causal'),
        detail: (f) => JSON.stringify(f.ctx.investigation?.suspect ?? null),
      },
      { name: 'no revert PR was opened on an unproven hypothesis', check: (f) => !f.ctx.revertPr },
      { name: 'no fix PR was opened either', check: (f) => !f.ctx.fixPr },
      { name: 'incident ticket was still created for humans', check: (f) => !!f.ctx.ticket },
      { name: 'Slack was still notified', check: (f) => !!f.ctx.slack },
    ],
  },
  {
    name: 'no-false-blame',
    description: 'The most recently deployed PR (#143, docs-only) must NOT be blamed',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'did not blame the most recent deploy (#143)', check: (f) => !suspectIs(f, 143) },
      { name: 'blamed PR #142 instead', check: (f) => suspectIs(f, 142) },
      {
        name: '#143 scored far below #142',
        check: (f) => {
          const r = f.ctx.investigation?.rankedSuspects ?? [];
          const a = r.find((x) => x.prNumber === 142)?.confidence ?? 0;
          const b = r.find((x) => x.prNumber === 143)?.confidence ?? 1;
          return a - b > 0.3;
        },
        detail: (f) =>
          JSON.stringify((f.ctx.investigation?.rankedSuspects ?? []).map((r) => [r.prNumber, r.confidence])),
      },
      {
        name: 'exculpatory evidence was recorded for the innocent PR',
        check: (f) =>
          (f.ctx.investigation?.rankedSuspects ?? [])
            .find((r) => r.prNumber === 143)
            ?.evidence.some((e) => e.kind === 'exculpatory') === true,
      },
      { name: 'revert targets #142', check: (f) => f.ctx.revertPrep?.targetPrNumber === 142 },
    ],
  },
  {
    name: 'fix-tests-fail',
    description: 'Generated fix breaks the test suite — no fix PR is opened, mitigation still lands',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: false,
    phases: [{ label: 'run', env: { FF_CORRUPT_FIX: '1' } }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow still completed', check: (f) => f.run?.status === 'succeeded' },
      { name: 'revert PR was still created', check: (f) => !!f.ctx.revertPr },
      { name: 'fix verification failed', check: (f) => has(f, 'run_fix_tests', 'failed') },
      {
        name: 'NO fix PR was opened with failing tests',
        check: (f) => !f.ctx.fixPr && has(f, 'create_fix_pr', 'skipped'),
        detail: (f) => `fixPr=${JSON.stringify(f.ctx.fixPr ?? null)}`,
      },
      { name: 'Slack still notified, reporting the blockage', check: (f) => !!f.ctx.slack },
      { name: 'run_fix_tests was retried before giving up', check: (f) => (f.steps.find((s) => s.step === 'run_fix_tests')?.attempts ?? 0) > 1 },
    ],
  },
  {
    name: 'transient-api-failure',
    description: 'Slack API fails twice then recovers — retried, delivered exactly once',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'run', env: { FF_FAIL_INJECT: 'notify_slack:transient:2' } }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed despite the outage', check: (f) => f.run?.status === 'succeeded' },
      { name: 'Slack step retried', check: (f) => (f.steps.find((s) => s.step === 'notify_slack')?.attempts ?? 0) >= 3 },
      { name: 'Slack ultimately delivered', check: (f) => !!f.ctx.slack },
      { name: 'exactly one Slack message', check: (f) => countKind(f, 'post_slack_update') === 1 },
      { name: 'retries were recorded', check: (f) => f.retries > 0 },
    ],
  },
  {
    name: 'crash-and-resume',
    description: 'Process is killed right after the incident ticket is created; restart must not duplicate it',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [
      { label: 'crash', env: { FF_CRASH_AFTER: 'create_incident_ticket' }, expectCrash: true },
      { label: 'restart' },
    ],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed after restart', check: (f) => f.run?.status === 'succeeded' },
      {
        name: 'exactly one incident ticket survived the crash',
        check: (f) => countKind(f, 'create_incident_ticket') === 1,
        detail: (f) => JSON.stringify(f.mutations),
      },
      { name: 'ticket is present in the resumed context', check: (f) => !!f.ctx.ticket },
      { name: 'the interrupted step was recovered', check: (f) => f.timeline.some((t) => /Recovered step|resumed/i.test(t.message)) },
      { name: 'revert PR created after resume', check: (f) => !!f.ctx.revertPr },
      { name: 'fix PR created after resume', check: (f) => !!f.ctx.fixPr },
    ],
  },
  {
    name: 'rerun-is-idempotent',
    description: 'Running the completed workflow again performs zero new external writes',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'first run' }, { label: 'second run' }, { label: 'third run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow succeeded', check: (f) => f.run?.status === 'succeeded' },
      {
        name: 'exactly 1 ticket, 2 PRs, 1 Slack message after three runs',
        check: (f) =>
          countKind(f, 'create_incident_ticket') === 1 &&
          countKind(f, 'create_pull_request') === 2 &&
          countKind(f, 'post_slack_update') === 1,
        detail: (f) => JSON.stringify(f.mutations.map((m) => m.kind)),
      },
      { name: 'all steps remain succeeded', check: (f) => f.steps.every((s) => s.status === 'succeeded' || s.status === 'skipped') },
    ],
  },
  {
    name: 'partial-then-resume',
    description: 'Run stops cleanly before the revert PR, then resumes and finishes without duplicates',
    fixture: 'checkout-guest-null-country',
    expectedSuspect: 142,
    expectRevert: true,
    expectFix: true,
    phases: [{ label: 'partial', stopBefore: 'create_revert_pr' }, { label: 'resume' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed after resume', check: (f) => f.run?.status === 'succeeded' },
      { name: 'revert PR created exactly once', check: (f) => countKind(f, 'create_pull_request') === 2 },
      { name: 'earlier steps were not re-executed', check: (f) => countKind(f, 'create_incident_ticket') === 1 },
    ],
  },
  {
    name: 'inconclusive-investigation',
    description: 'No recent change explains the incident — agent refuses to revert anything',
    fixture: 'upstream-reset-inconclusive',
    expectedSuspect: null,
    expectRevert: false,
    expectFix: false,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      { name: 'workflow completed', check: (f) => f.run?.status === 'succeeded' },
      { name: 'investigation marked inconclusive', check: (f) => f.ctx.investigation?.inconclusive === true },
      { name: 'no revert was prepared', check: (f) => !f.ctx.revertPrep && has(f, 'prepare_revert', 'skipped') },
      { name: 'no revert PR was opened', check: (f) => !f.ctx.revertPr },
      { name: 'no fix PR was opened', check: (f) => !f.ctx.fixPr },
      { name: 'incident ticket was still created for humans', check: (f) => !!f.ctx.ticket },
      { name: 'Slack was still notified', check: (f) => !!f.ctx.slack },
    ],
  },
  {
    name: 'older-pr-is-culprit',
    description: 'Culprit is an older PR (#139); recency alone must not decide the blame',
    fixture: 'promo-code-undefined',
    expectedSuspect: 139,
    expectRevert: false,
    expectFix: false,
    phases: [{ label: 'run' }],
    assertions: [
      ...UNIVERSAL,
      {
        name: 'blamed the older PR #139, not the recent ones',
        check: (f) => suspectIs(f, 139),
        detail: (f) =>
          `suspect=${f.ctx.investigation?.suspect?.prNumber} ranked=${JSON.stringify(
            (f.ctx.investigation?.rankedSuspects ?? []).map((r) => [r.prNumber, r.confidence]),
          )}`,
      },
      {
        name: 'exonerated the changes that deployed after the incident began',
        check: (f) =>
          (f.ctx.investigation?.rankedSuspects ?? [])
            .find((r) => r.prNumber === 142)
            ?.evidence.some((e) => e.kind === 'exculpatory') === true,
      },
      // Reverting an older PR often conflicts with later work. That must block
      // ONLY the mitigation track, never the whole incident response.
      {
        name: 'revert conflict was detected rather than silently mis-applied',
        check: (f) => has(f, 'prepare_revert', 'failed') && /conflict/i.test(f.ctx.revertPrep ? '' : (f.steps.find((s) => s.step === 'prepare_revert')?.error ?? '')),
        detail: (f) => f.steps.find((s) => s.step === 'prepare_revert')?.error ?? 'no error recorded',
      },
      { name: 'no revert PR was opened from a conflicted revert', check: (f) => !f.ctx.revertPr },
      {
        name: 'the incident response still completed',
        check: (f) => f.run?.status === 'succeeded',
        detail: (f) => `status=${f.run?.status} lastError=${f.run?.lastError}`,
      },
      { name: 'incident ticket was still created', check: (f) => !!f.ctx.ticket },
      { name: 'Slack was still notified', check: (f) => !!f.ctx.slack },
      {
        name: 'Slack reported that mitigation needs a human',
        check: (f) => /not.*opened|needs a human/i.test(f.ctx.slack?.text ?? ''),
        detail: (f) => (f.ctx.slack?.text ?? 'no slack text').slice(0, 400),
      },
    ],
  },
];

export const UNIVERSAL_ASSERTIONS = UNIVERSAL;
