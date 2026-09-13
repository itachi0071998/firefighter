/**
 * The thirteen workflow steps.
 *
 * Mitigate first, remediate second: the revert track (steps 5-7) runs to
 * completion before the fix track (steps 8-11) begins, so production can be
 * restored while the permanent fix is still being written and tested.
 */
import path from 'node:path';
import {
  FilePatch,
  Incident,
  IncidentSummary,
  LintResult,
  StepName,
  StepOutput,
  TestRunResult,
  WorkflowContext,
} from '../types.ts';
import { config } from '../config.ts';
import { Tools } from '../tools/index.ts';
import { StepDef, StepHelpers, StepTitle } from './types.ts';
import { withWorktree } from './worktree.ts';
import { analyzeWithLlm } from '../agent/analyzer.ts';
import { verifyCulprit } from '../agent/bisect.ts';
import { parseStackTrace, topAppFrame, normalizePath } from '../agent/stacktrace.ts';
import { planFixWithLlm } from '../agent/fixer.ts';
import { getLlmClient } from '../agent/llm.ts';
import { buildTicketDescription } from '../tools/tickets.ts';
import { buildSlackPayload } from '../tools/slack.ts';
import { addTimeline, listSteps } from '../db/repo.ts';
import { logger } from '../util/log.ts';

const log = logger('steps');

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function branchNames(incident: Incident, prNumber: number | null): { revert: string; fix: string } {
  const slug = incident.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    revert: `firefighter/revert-pr-${prNumber ?? 'unknown'}-${slug}`,
    fix: `firefighter/fix-${slug}`,
  };
}

/**
 * Verification always runs in a detached worktree so the demo repository's
 * working tree is never disturbed and two steps can never fight over HEAD.
 */
async function verifyBranch(
  tools: Tools,
  branch: string,
): Promise<{ tests: TestRunResult; lint: LintResult }> {
  return withWorktree(config.demoRepoPath, branch, async (dir) => {
    const tests = await tools.run_tests({ cwd: dir });
    const lint = await tools.run_lint({ cwd: dir });
    return { tests, lint };
  });
}


/**
 * Render the causal-verification evidence.
 *
 * This is the part a reviewer should read first: it is the difference between
 * "we think this PR did it" and "we ran the failure on both sides of this PR".
 */
function verificationSection(ctx: WorkflowContext): string {
  const v = ctx.culpritVerification;
  if (!v) return '_Causal verification was not attempted._';
  if (!v.verified) {
    return [
      `⚠️ **Not proven by execution.** ${v.skippedReason ?? v.summary}`,
      ``,
      `The suspected change below comes from correlation (stack-trace overlap, deploy timing,`,
      `symbol matches) and has **not** been confirmed by re-running the failure. Treat it as a lead.`,
      ...(v.probes.length
        ? ['', '| Candidate | Verdict | Detail |', '|---|---|---|',
           ...v.probes.map((p) => `| #${p.prNumber} | \`${p.verdict}\` | ${p.note} |`)]
        : []),
    ].join('\n');
  }
  const proven = v.probes.find((p) => p.verdict === 'proven');
  return [
    `✅ **Proven by re-running the failure across commits.**`,
    ``,
    '```',
    `commit ${proven?.parentSha?.slice(0, 10)}  (before #${v.culpritPr})   → failure does NOT reproduce`,
    `commit ${v.culpritSha?.slice(0, 10)}  (#${v.culpritPr})            → failure DOES reproduce`,
    '```',
    ``,
    `The production request was replayed against both commits in isolated worktrees. The fault is`,
    `absent before this change and present after it, so this change introduced it. This is a causal`,
    `result, not a correlation.`,
    ...(v.overrodeRanking
      ? [
          ``,
          `> ℹ️ Correlation initially ranked **#${v.rankedPr}** highest; execution disproved that and`,
          `> identified **#${v.culpritPr}** instead.`,
        ]
      : []),
    ...(v.probes.length > 1
      ? ['', '| Candidate | Verdict | Detail |', '|---|---|---|',
         ...v.probes.map((p) => `| #${p.prNumber} | \`${p.verdict}\` | ${p.note} |`)]
      : []),
  ].join('\n');
}

function evidenceBullets(ctx: WorkflowContext, limit = 6): string {
  const ev = ctx.investigation?.suspect?.evidence ?? [];
  if (!ev.length) return '- (no evidence recorded)';
  return ev
    .slice(0, limit)
    .map((e) => `- **${e.kind}** — ${e.description}${e.detail ? ` _(${e.detail})_` : ''}`)
    .join('\n');
}

function testsLine(tests?: TestRunResult | null): string {
  if (!tests) return 'not run';
  return `${tests.passed}/${tests.total} tests passed${tests.failed ? ` — ${tests.failed} FAILED` : ''}`;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

const ingest_incident: StepDef = {
  name: 'ingest_incident',
  critical: true,
  async run(ctx) {
    const i = ctx.incident;
    const missing = (['id', 'title', 'service', 'detectedAt', 'errorType'] as const).filter((k) => !i[k]);
    if (missing.length) throw new Error(`incident is missing required fields: ${missing.join(', ')}`);
    log.info(`ingested ${i.id}: ${i.title} (${i.severity}) from ${i.source}`);
    return {};
  },
};

const collect_context: StepDef = {
  name: 'collect_context',
  critical: true,
  async run(ctx, tools) {
    const repo = await tools.get_repo_info();
    const commits = await tools.get_recent_commits(30);
    const pullRequests = await tools.get_recent_pull_requests(10);
    const deployments = await tools.get_deployments(10);

    const frames = parseStackTrace(ctx.incident.stackTrace);
    const repoFiles = [...new Set(commits.flatMap((c) => c.files))];
    const failingFrame = topAppFrame(frames, repoFiles);

    // Pull the code around the failing frame so the analyzer and the fixer can
    // reason about the actual offending source line, not just the trace.
    let codeMatches = ctx.collected?.codeMatches ?? [];
    if (failingFrame) {
      const symbol = failingFrame.fn.includes('.') ? failingFrame.fn.split('.').pop()! : failingFrame.fn;
      codeMatches = await tools.search_code(symbol);
    }

    return {
      collected: { repo, commits, pullRequests, deployments, codeMatches, failingFrame },
    };
  },
};

const identify_suspect_change: StepDef = {
  name: 'identify_suspect_change',
  critical: true,
  precondition: (ctx) => ({ ok: !!ctx.collected, reason: 'no repository context was collected' }),
  async run(ctx, tools, helpers) {
    const investigation = await analyzeWithLlm(
      { incident: ctx.incident, context: ctx.collected! },
      getLlmClient(helpers.cfg),
    );
    if (investigation.inconclusive) {
      log.warn('investigation inconclusive — no candidate cleared the confidence floor');
      addTimeline(
        helpers.runId,
        'info',
        'No change cleared the confidence floor — mitigation requires human triage',
        'identify_suspect_change',
      );
    } else {
      log.info(
        `suspect: PR #${investigation.suspect?.prNumber} @ ${pct(investigation.suspect?.confidence ?? 0)}`,
      );
    }
    return { investigation };
  },
};


/**
 * Prove — or disprove — the ranked suspect by executing the reproduction on
 * both sides of each candidate change.
 *
 * This is what separates a claim from a guess. It is deliberately NOT critical:
 * an incident with no replayable request still gets the correlation-based
 * answer, clearly labelled as unproven.
 */
const verify_culprit: StepDef = {
  name: 'verify_culprit',
  critical: false,
  precondition: (ctx) => {
    if (!ctx.investigation) return { ok: false, reason: 'no investigation to verify' };
    if (!ctx.investigation.rankedSuspects.length) {
      return { ok: false, reason: 'no candidate changes to verify' };
    }
    return { ok: true };
  },
  async run(ctx, tools) {
    const inv = ctx.investigation!;
    const verification = await verifyCulprit({
      incident: ctx.incident,
      candidates: inv.rankedSuspects,
      repoPath: config.demoRepoPath,
      reproduce: (cwd) => tools.reproduce_bug(ctx.incident, { cwd }),
    });

    if (!verification.verified) {
      log.info(`culprit not proven by execution: ${verification.summary}`);
      return { culpritVerification: verification, investigation: { ...inv, verification } };
    }

    // A proof outranks the heuristic. If execution blames a different change,
    // re-point the investigation at it: the ranking only had to get the
    // verifier close enough to start probing.
    const proven =
      inv.rankedSuspects.find((s) => s.sha === verification.culpritSha) ?? inv.suspect ?? null;
    const wasDifferent = proven && inv.suspect && proven.sha !== inv.suspect.sha;
    if (wasDifferent) {
      log.warn(
        `execution overrides correlation: ranked PR #${inv.suspect?.prNumber}, proved PR #${proven?.prNumber}`,
      );
    }

    // Execution has now empirically falsified any exculpatory inference about
    // this change: keeping "it cannot be the cause" alongside a proof that it
    // IS the cause would ship a flat contradiction into the PR body and the
    // Slack update. A proof supersedes the heuristics that disagree with it.
    const superseded = proven ? proven.evidence.filter((e) => e.kind === 'exculpatory') : [];
    if (superseded.length) {
      log.info(
        `discarding ${superseded.length} exculpatory inference(s) about PR #${proven?.prNumber} — execution disproved them`,
      );
    }
    const suspect = proven
      ? {
          ...proven,
          confidence: 1,
          evidence: [
            {
              kind: 'causal' as const,
              description: verification.summary,
              weight: 1,
              score: 1,
              detail: [
                ...verification.probes
                  .filter((p) => p.verdict !== 'proven')
                  .map((p) => `#${p.prNumber}: ${p.note}`),
                ...superseded.map((e) => `superseded by proof: ${e.description}`),
              ].join('; '),
            },
            ...proven.evidence.filter((e) => e.kind !== 'exculpatory'),
          ],
        }
      : null;

    const investigation = {
      ...inv,
      suspect,
      inconclusive: false,
      immediateMitigation: suspect
        ? `Revert PR #${suspect.prNumber} (${suspect.title})`
        : inv.immediateMitigation,
      rootCause: inv.rootCause,
      verification,
      rankedSuspects: inv.rankedSuspects.map((s) =>
        s.sha === verification.culpritSha ? { ...s, confidence: 1 } : s,
      ),
    };
    return { culpritVerification: verification, investigation };
  },
};

const create_incident_ticket: StepDef = {
  name: 'create_incident_ticket',
  critical: false,
  async run(ctx, tools) {
    const inv = ctx.investigation!;
    const description = buildTicketDescription({
      incident: ctx.incident,
      investigation: inv,
      revertPr: ctx.revertPr ?? null,
      fixPr: ctx.fixPr ?? null,
    });
    const { ref } = await tools.create_incident_ticket({
      incidentId: ctx.incident.id,
      title: `[${ctx.incident.severity.toUpperCase()}] ${ctx.incident.title}`,
      description,
      severity: ctx.incident.severity,
      labels: ['incident', 'firefighter', ctx.incident.service],
    });
    return { ticket: ref };
  },
};

const prepare_revert: StepDef = {
  name: 'prepare_revert',
  // Not critical: a revert that cannot be applied cleanly (because later
  // changes touched the same lines) must block only the mitigation track. The
  // incident ticket, the permanent fix and the Slack update still go out.
  critical: false,
  precondition: (ctx) => {
    const inv = ctx.investigation;
    if (!inv || inv.inconclusive || !inv.suspect) {
      return { ok: false, reason: 'no suspect cleared the confidence floor — human triage required before reverting' };
    }
    if (inv.suspect.prNumber === null) {
      return { ok: false, reason: 'suspected change has no associated pull request to revert' };
    }
    return { ok: true };
  },
  async run(ctx, tools) {
    const suspect = ctx.investigation!.suspect!;
    const base = ctx.collected!.repo.defaultBranch;
    const { revert: branch } = branchNames(ctx.incident, suspect.prNumber);
    await tools.create_branch(branch, base, 'revert');
    const { ref } = await tools.generate_revert(suspect.prNumber!, branch);
    return { revertPrep: ref };
  },
};

const verify_revert: StepDef = {
  name: 'verify_revert',
  critical: false,
  precondition: (ctx) => ({ ok: !!ctx.revertPrep, reason: 'no revert was prepared' }),
  async run(ctx, tools) {
    const result = await verifyBranch(tools, ctx.revertPrep!.branch);
    if (!result.tests.ok) {
      throw new Error(
        `revert branch fails its own test suite (${result.tests.failed} failing) — not safe to propose blindly`,
      );
    }
    return { revertVerification: result };
  },
};

const create_revert_pr: StepDef = {
  name: 'create_revert_pr',
  critical: false,
  precondition: (ctx) => ({ ok: !!ctx.revertPrep, reason: 'no revert was prepared' }),
  async run(ctx, tools) {
    const inv = ctx.investigation!;
    const suspect = inv.suspect!;
    const prep = ctx.revertPrep!;
    const v = ctx.revertVerification;

    const body = [
      `## 🚨 Emergency mitigation — automated revert`,
      ``,
      `> Opened by **Firefighter** while investigating an active production incident.`,
      `> **This PR is not auto-merged.** A human must review and merge it.`,
      ``,
      `| | |`,
      `|---|---|`,
      `| **Incident** | \`${ctx.incident.id}\` — ${ctx.incident.title} |`,
      `| **Severity** | ${ctx.incident.severity.toUpperCase()} |`,
      `| **Detected** | ${ctx.incident.detectedAt} |`,
      `| **Suspected offending PR** | #${suspect.prNumber} — ${suspect.title} |`,
      ctx.culpritVerification?.verified
        ? `| **Confidence** | **Proven by execution** (not inferred) |`
        : `| **Confidence** | ${pct(suspect.confidence)} — correlation only, not proven |`,
      `| **Reverted commit** | \`${prep.revertedSha.slice(0, 10)}\` |`,
      ``,
      `### Reason for revert`,
      inv.rootCause,
      ``,
      `### Evidence`,
      evidenceBullets(ctx),
      ``,
      `### Causal verification`,
      verificationSection(ctx),
      ``,
      `### Affected functionality`,
      inv.affectedFunctionality,
      ``,
      `### Risk assessment`,
      `- Reverting restores the behaviour that was live before #${suspect.prNumber} shipped at ${suspect.deployedAt ?? 'an unrecorded time'}.`,
      `- Functionality introduced by #${suspect.prNumber} will be withdrawn until the permanent fix lands.`,
      `- Files restored: ${prep.filesRestored.length ? prep.filesRestored.map((f) => `\`${f}\``).join(', ') : 'none recorded'}`,
      `- Diff stat: ${prep.diffStat || 'n/a'}`,
      `- ${
        ctx.fixPlan
          ? 'A draft fix PR accompanies this revert.'
          : config.mode === 'full'
            ? 'A permanent fix is being prepared separately.'
            : 'No automated fix was attempted: reverting a proven-bad change is the reliable action, and a synthesised fix would encode a guess about intent. Write the fix deliberately once production is stable.'
      }`,
      ``,
      `### Verification performed`,
      v
        ? [
            `- ${v.tests.ok ? '✅' : '❌'} ${testsLine(v.tests)} on the revert branch`,
            `- ${v.lint.ok ? '✅' : '❌'} lint: ${v.lint.errors} errors, ${v.lint.warnings} warnings`,
          ].join('\n')
        : `- ⚠️ automated verification did not complete; review manually`,
      `- Branch \`${prep.branch}\` cut from \`${prep.baseSha.slice(0, 10)}\``,
      ``,
      `### What Firefighter did *not* do`,
      `- ❌ merge this or any PR`,
      `- ❌ deploy to production`,
      `- ❌ modify any protected branch`,
      ``,
      `_Incident ticket: ${ctx.ticket ? `[${ctx.ticket.identifier}](${ctx.ticket.url})` : 'pending'}_`,
    ].join('\n');

    const { ref } = await tools.create_pull_request({
      title: `[MITIGATION] Revert "${suspect.title}" (#${suspect.prNumber}) — ${ctx.incident.id}`,
      body,
      head: prep.branch,
      base: ctx.collected!.repo.defaultBranch,
      kind: 'revert',
      labels: ['incident', 'emergency-mitigation', 'revert', 'do-not-auto-merge'],
    });
    return { revertPr: ref };
  },
};

const reproduce_bug: StepDef = {
  name: 'reproduce_bug',
  critical: false,
  async run(ctx, tools) {
    const repro = await tools.reproduce_bug(ctx.incident);
    log.info(`reproduction: reproduced=${repro.reproduced} matchedError=${repro.matchedError}`);
    return { repro };
  },
};

const generate_fix: StepDef = {
  name: 'generate_fix',
  critical: false,
  precondition: (ctx) => {
    // Mitigation is proven and mechanical; a synthesised fix is a guess about
    // intent. Revert-only is therefore the default, and remediation is opt-in.
    if (config.mode !== 'full') {
      return {
        ok: false,
        reason:
          'remediation not attempted — running in mitigate-only mode (set FF_MODE=full to also draft a fix)',
      };
    }
    if (!ctx.investigation || ctx.investigation.inconclusive) {
      return { ok: false, reason: 'investigation was inconclusive — a fix cannot be synthesised safely' };
    }
    if (!ctx.investigation.failingFrame) {
      return { ok: false, reason: 'no application stack frame was identified to fix' };
    }
    return { ok: true };
  },
  async run(ctx, tools, helpers) {
    // Pre-load every file the fixer might need so it can stay synchronous.
    //
    // The set must include the repository's EXISTING TESTS, not just the files
    // on the stack: the fixer mines their happy-path fixtures for a known-good
    // field value to build the positive control in the regression test. Without
    // them it falls back to scraping source strings and can pick up nonsense.
    const frames = parseStackTrace(ctx.incident.stackTrace);
    const wanted = new Set<string>();
    for (const f of frames) wanted.add(normalizePath(f.file));
    const suspectPr = ctx.investigation!.suspect?.prNumber;
    if (suspectPr) {
      const pr = ctx.collected!.pullRequests.find((p) => p.number === suspectPr);
      for (const f of pr?.files ?? []) wanted.add(f.path);
    }
    // Everything recent history has touched: a bounded view of the repo's
    // active surface, which is where its test fixtures live.
    for (const pr of ctx.collected!.pullRequests) {
      for (const f of pr.files) wanted.add(f.path);
    }
    const cache = new Map<string, string | null>();
    for (const p of wanted) {
      if (!p) continue;
      cache.set(p, await tools.read_file(p));
    }
    const readFile = (p: string): string | null => {
      if (cache.has(p)) return cache.get(p) ?? null;
      return null;
    };

    const plan = await planFixWithLlm(
      { incident: ctx.incident, investigation: ctx.investigation!, readFile },
      getLlmClient(helpers.cfg),
    );
    if (!plan.patches.length) throw new Error('fix generator produced no patches');

    const patches: FilePatch[] = [...plan.patches];
    if (plan.regressionTest) patches.push(plan.regressionTest);

    // Eval hook: deliberately corrupt the patch to exercise the
    // "tests fail while generating the fix" path end to end.
    if (process.env.FF_CORRUPT_FIX === '1') {
      log.warn('FF_CORRUPT_FIX=1 — emitting a knowingly broken patch to exercise the failure path');
      patches[0] = {
        ...patches[0],
        contents: patches[0].contents.replace(
          /module\.exports\s*=/,
          'if (process.env.FF_CORRUPT_FIX) { throw new Error("corrupted fix"); }\nmodule.exports =',
        ),
      };
    }

    const base = ctx.collected!.repo.defaultBranch;
    const { fix: branch } = branchNames(ctx.incident, suspectPr ?? null);
    await tools.create_branch(branch, base, 'fix');
    await tools.apply_patch(
      branch,
      patches,
      `fix: guard ${ctx.investigation!.failingFrame!.fn} against missing input\n\nIncident: ${ctx.incident.id}\nRoot cause: ${plan.rootCause}`,
      'fix',
    );
    return { fixPlan: plan, fixBranch: branch };
  },
};

const run_fix_tests: StepDef = {
  name: 'run_fix_tests',
  critical: false,
  precondition: (ctx) => ({ ok: !!ctx.fixBranch, reason: 'no fix branch was produced' }),
  async run(ctx, tools) {
    const result = await verifyBranch(tools, ctx.fixBranch!);
    if (!result.tests.ok) {
      const names = result.tests.failures.map((f) => f.name).slice(0, 5).join(', ');
      throw new Error(
        `fix branch fails its test suite: ${result.tests.failed}/${result.tests.total} failing${names ? ` (${names})` : ''}`,
      );
    }
    if (!result.lint.ok) {
      throw new Error(`fix branch fails static analysis: ${result.lint.errors} lint errors`);
    }
    return { fixVerification: result };
  },
};

const create_fix_pr: StepDef = {
  name: 'create_fix_pr',
  critical: false,
  precondition: (ctx) => {
    if (!ctx.fixBranch) return { ok: false, reason: 'no fix branch was produced' };
    if (!ctx.fixVerification?.tests.ok) {
      return { ok: false, reason: 'fix verification did not pass — refusing to open a fix PR with failing tests' };
    }
    return { ok: true };
  },
  async run(ctx, tools) {
    const plan = ctx.fixPlan!;
    const v = ctx.fixVerification!;
    const inv = ctx.investigation!;

    const body = [
      `## 🔧 Proposed remediation (draft)`,
      ``,
      `> Opened by **Firefighter** as a *proposal*, after the incident was mitigated by a revert.`,
      `> **This is a draft and encodes a guess about intent.** The regression test below is the`,
      `> verifiable part — it fails before the patch and passes after. The patch itself is a`,
      `> starting point for a human, not a finished change. **Never auto-merged.**`,
      ``,
      `| | |`,
      `|---|---|`,
      `| **Incident** | \`${ctx.incident.id}\` — ${ctx.incident.title} |`,
      `| **Mitigated by** | ${ctx.revertPr ? `#${ctx.revertPr.number} (revert)` : 'revert pending'} |`,
      `| **Originating change** | ${inv.suspect ? `#${inv.suspect.prNumber} — ${inv.suspect.title}` : 'unknown'} |`,
      ``,
      `### Root cause`,
      plan.rootCause,
      ``,
      `### Causal verification`,
      verificationSection(ctx),
      ``,
      `### Reproduction steps`,
      plan.reproductionSteps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      ``,
      ctx.repro
        ? `Reproduced automatically before the fix: **${ctx.repro.reproduced ? 'yes' : 'no'}** (error matched: ${ctx.repro.matchedError ? 'yes' : 'no'}).`
        : `Automated reproduction was not run.`,
      ``,
      `### The fix`,
      plan.patches.map((p) => `- \`${p.path}\` — ${p.rationale}`).join('\n'),
      ``,
      `### Regression coverage`,
      plan.regressionTest
        ? `- \`${plan.regressionTest.path}\` — ${plan.regressionTest.rationale}\n- This test fails on \`${ctx.collected!.repo.defaultBranch}\` and passes on this branch.`
        : `- ⚠️ no regression test was generated`,
      ``,
      `### Verification`,
      `- ${v.tests.ok ? '✅' : '❌'} ${testsLine(v.tests)}`,
      `- ${v.lint.ok ? '✅' : '❌'} lint / static analysis: ${v.lint.errors} errors, ${v.lint.warnings} warnings`,
      ``,
      `<details><summary>Test output</summary>`,
      ``,
      '```',
      v.tests.output.slice(-2500),
      '```',
      `</details>`,
      ``,
      `### Known risks`,
      plan.risks.length ? plan.risks.map((r) => `- ${r}`).join('\n') : '- none identified',
      ``,
      `### What Firefighter did *not* do`,
      `- ❌ merge this or any PR`,
      `- ❌ deploy to production`,
      ``,
      `_Incident ticket: ${ctx.ticket ? `[${ctx.ticket.identifier}](${ctx.ticket.url})` : 'pending'}_`,
    ].join('\n');

    const { ref } = await tools.create_pull_request({
      title: `[FIX] ${inv.affectedFunctionality} — ${ctx.incident.id}`,
      body,
      head: ctx.fixBranch!,
      base: ctx.collected!.repo.defaultBranch,
      kind: 'fix',
      draft: true,
      labels: ['incident', 'permanent-fix', 'needs-review', 'do-not-auto-merge'],
    });
    return { fixPr: ref };
  },
};

const notify_slack: StepDef = {
  name: 'notify_slack',
  critical: false,
  async run(ctx, tools, helpers) {
    const blockedNotes: string[] = [];
    // Read the durable step record so the message states the ACTUAL reason a
    // track stalled, rather than guessing from what is missing in context.
    const stepStates = new Map(
      listSteps(helpers.runId).map((s) => [s.step, s] as const),
    );
    const reasonFor = (step: StepName): string | null => {
      const rec = stepStates.get(step);
      if (!rec || rec.status === 'succeeded') return null;
      return rec.error ?? rec.status;
    };

    if (!ctx.revertPr) {
      const why = reasonFor('prepare_revert') ?? reasonFor('create_revert_pr');
      blockedNotes.push(
        `Automated revert was NOT opened${why ? ` — ${why}` : ''}. Mitigation needs a human.`,
      );
    }
    if (!ctx.fixPr && helpers.cfg.mode !== 'full') {
      // Not a failure: remediation was intentionally not attempted.
    } else if (!ctx.fixPr) {
      blockedNotes.push(
        ctx.fixBranch
          ? `Permanent fix PR was not opened — ${reasonFor('run_fix_tests') ?? 'automated verification did not pass'}. Fix branch ${ctx.fixBranch} is available for manual review.`
          : `Permanent fix could not be generated automatically — ${reasonFor('generate_fix') ?? 'manual remediation required'}.`,
      );
    }
    if (!ctx.ticket) blockedNotes.push('Incident ticket could not be created.');

    const input = {
      channel: helpers.cfg.slack.channel,
      incident: ctx.incident,
      investigation: ctx.investigation!,
      ticket: ctx.ticket ?? null,
      revertPr: ctx.revertPr ?? null,
      fixPr: ctx.fixPr ?? null,
      tests: ctx.fixVerification?.tests ?? ctx.revertVerification?.tests ?? null,
      lint: ctx.fixVerification?.lint ?? ctx.revertVerification?.lint ?? null,
      blocked: blockedNotes.length ? blockedNotes.join(' ') : null,
    };
    // Render eagerly so a delivery failure still leaves the exact text on the timeline.
    const payload = buildSlackPayload(input);
    addTimeline(helpers.runId, 'info', 'Slack message rendered', 'notify_slack', payload.text);

    const { ref } = await tools.post_slack_update(input);
    return { slack: ref };
  },
};

const complete: StepDef = {
  name: 'complete',
  critical: true,
  async run(ctx, tools) {
    const inv = ctx.investigation;
    const summary: IncidentSummary = {
      incidentId: ctx.incident.id,
      title: ctx.incident.title,
      suspect: inv?.suspect ? `PR #${inv.suspect.prNumber} — ${inv.suspect.title}` : 'inconclusive',
      confidence: inv?.suspect?.confidence ?? 0,
      ticket: ctx.ticket ? `${ctx.ticket.identifier} (${ctx.ticket.url})` : null,
      revertPr: ctx.revertPr ? `#${ctx.revertPr.number} (${ctx.revertPr.url})` : null,
      fixPr: ctx.fixPr ? `#${ctx.fixPr.number} (${ctx.fixPr.url})` : null,
      testsPassed: testsLine(ctx.fixVerification?.tests ?? ctx.revertVerification?.tests),
      humanApprovalRequired: true,
    };

    if (ctx.ticket) {
      try {
        await tools.update_ticket(ctx.ticket.id, {
          state: ctx.revertPr ? 'In Progress' : 'Triage',
          description: buildTicketDescription({
            incident: ctx.incident,
            investigation: inv!,
            revertPr: ctx.revertPr ?? null,
            fixPr: ctx.fixPr ?? null,
          }),
        });
      } catch (err) {
        log.warn(`could not update ticket: ${String(err)}`);
      }
    }
    return { summary };
  },
};

export const STEPS: Record<StepName, StepDef> = {
  ingest_incident,
  collect_context,
  identify_suspect_change,
  verify_culprit,
  create_incident_ticket,
  prepare_revert,
  verify_revert,
  create_revert_pr,
  reproduce_bug,
  generate_fix,
  run_fix_tests,
  create_fix_pr,
  notify_slack,
  complete,
};

export const STEP_TITLES: Record<StepName, StepTitle> = {
  ingest_incident: {
    gerund: 'Receiving incident',
    failed: 'Incident ingest failed',
    skipped: 'Incident ingest skipped',
    done: (c) => `Incident received — ${c.incident.title}`,
  },
  collect_context: {
    gerund: 'Collecting repository and deployment context',
    failed: 'Context collection failed',
    skipped: 'Context collection skipped',
    done: (c) =>
      `Context collected — ${c.collected?.pullRequests.length ?? 0} PRs, ${c.collected?.deployments.length ?? 0} deployments`,
  },
  identify_suspect_change: {
    gerund: 'Identifying the suspect change',
    failed: 'Suspect identification failed',
    skipped: 'Suspect identification skipped',
    done: (c) =>
      c.investigation?.suspect
        ? `Suspect identified — PR #${c.investigation.suspect.prNumber} at ${pct(c.investigation.suspect.confidence)} confidence`
        : 'Investigation inconclusive — human triage required',
  },
  verify_culprit: {
    gerund: 'Proving the culprit by re-running the failure across commits',
    failed: 'Culprit verification failed',
    skipped: 'Culprit verification skipped',
    done: (c) =>
      c.culpritVerification?.verified
        ? `Culprit PROVEN — PR #${c.culpritVerification.culpritPr}: absent at ${c.culpritVerification.probes.find((p) => p.verdict === 'proven')?.parentSha?.slice(0, 10)}, present at ${c.culpritVerification.culpritSha?.slice(0, 10)}`
        : `Culprit not proven by execution — ranking remains correlation-based`,
  },
  create_incident_ticket: {
    gerund: 'Creating incident ticket',
    failed: 'Incident ticket creation failed',
    skipped: 'Incident ticket skipped',
    done: (c) => `Incident ticket created — ${c.ticket?.identifier ?? 'unknown'}`,
  },
  prepare_revert: {
    gerund: 'Preparing revert',
    failed: 'Revert preparation failed',
    skipped: 'Revert skipped',
    done: (c) => `Revert generated on ${c.revertPrep?.branch ?? 'branch'}`,
  },
  verify_revert: {
    gerund: 'Verifying revert',
    failed: 'Revert verification failed',
    skipped: 'Revert verification skipped',
    done: (c) => `Revert verified — ${testsLine(c.revertVerification?.tests)}`,
  },
  create_revert_pr: {
    gerund: 'Opening revert PR',
    failed: 'Revert PR creation failed',
    skipped: 'Revert PR skipped',
    done: (c) => `Revert PR opened — #${c.revertPr?.number ?? '?'} (awaiting human merge)`,
  },
  reproduce_bug: {
    gerund: 'Reproducing the failure',
    failed: 'Reproduction failed',
    skipped: 'Reproduction skipped',
    done: (c) => (c.repro?.reproduced ? 'Failure reproduced locally' : 'Failure could not be reproduced'),
  },
  generate_fix: {
    gerund: 'Generating permanent fix',
    failed: 'Fix generation failed',
    skipped: 'Fix generation skipped',
    done: (c) => `Fix generated — ${c.fixPlan?.patches.length ?? 0} patch(es) + regression test`,
  },
  run_fix_tests: {
    gerund: 'Running tests and static analysis on the fix',
    failed: 'Fix verification failed',
    skipped: 'Fix verification skipped',
    done: (c) => `Fix verified — ${testsLine(c.fixVerification?.tests)}, lint clean`,
  },
  create_fix_pr: {
    gerund: 'Opening fix PR',
    failed: 'Fix PR creation failed',
    skipped: 'Fix PR skipped',
    done: (c) => `Fix PR opened — #${c.fixPr?.number ?? '?'} (awaiting human review)`,
  },
  notify_slack: {
    gerund: 'Posting incident update to Slack',
    failed: 'Slack notification failed',
    skipped: 'Slack notification skipped',
    done: (c) => `Slack notified — ${c.slack?.channel ?? ''}`,
  },
  complete: {
    gerund: 'Finalising incident record',
    failed: 'Finalisation failed',
    skipped: 'Finalisation skipped',
    done: () => 'Incident response complete — human approval required before merge',
  },
};
