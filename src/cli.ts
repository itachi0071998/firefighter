#!/usr/bin/env node
/**
 * Firefighter CLI.
 *
 *   npm run seed                     seed the demo repository
 *   npm run demo                     seed + run the canonical incident end to end
 *   npm run run-incident -- <name>   run one incident fixture
 *   npm run reset                    wipe durable state (db, tickets, slack outbox)
 *   tsx src/cli.ts status            print the state of the latest run
 *   tsx src/cli.ts bridge            list pending connector-bridge intents
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, effectiveProviders } from './config.ts';
import { openDb, resetDb } from './db/index.ts';
import { listIncidents, listTimeline, getRunByIncident, listSteps, duplicateWriteCount, listBridgeIntents, resolveBridgeIntent, listMutations } from './db/repo.ts';
import { runWorkflow } from './workflow/engine.ts';
import { seedDemoRepo, isSeeded } from './demo/seed.ts';
import { INCIDENT_FIXTURES, buildCheckoutIncident } from './demo/incidents.ts';
import { getIncidentSource, resolveIncident } from './tools/sentry.ts';
import { setupGitHubDemo, ensureOriginRemote } from './demo/github-setup.ts';
import { bootstrapSentry } from './demo/sentry-bootstrap.ts';
import { verifyCulprit } from './agent/bisect.ts';
import { analyze } from './agent/analyzer.ts';
import { parseStackTrace, topAppFrame } from './agent/stacktrace.ts';
import { getGitHubClient } from './tools/github.ts';
import { preflight } from './tools/preflight.ts';
import { getTestRunner } from './tools/tests.ts';
import { hydrateContext } from './workflow/engine.ts';
import { StepName } from './types.ts';

const c = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  o: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`,
  cy: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const ICON: Record<string, string> = {
  step_succeeded: c.g('✓'),
  step_failed: c.r('✗'),
  retry: c.y('↻'),
  step_started: c.cy('▶'),
  step_skipped: c.dim('⊘'),
  info: c.dim('·'),
  replay: c.y('⟳'),
  unsafe_blocked: c.r('🛡'),
};

async function cmdSeed(force: boolean, variant: 'js' | 'sentry' = 'js'): Promise<void> {
  console.log(c.o(`🔥 seeding demo repository (${variant})…`));
  const r = await seedDemoRepo({ force, variant });
  // A forced re-seed rebuilds .git and drops the remote; restore it so remote
  // providers can still fetch agent-created branches for verification.
  if (effectiveProviders(config).github !== 'mock' && config.github.repo.includes('/')) {
    ensureOriginRemote(config.github.repo, r.repoPath);
  }
  console.log(`   repo:  ${r.repoPath}`);
  console.log(`   head:  ${r.headSha.slice(0, 10)}`);
  for (const cm of r.commits) console.log(`   PR #${cm.prNumber}  ${cm.sha.slice(0, 10)}`);
}

async function cmdRun(fixtureName: string, opts: { stopBefore?: StepName } = {}): Promise<void> {
  if (!isSeeded(config.demoRepoPath)) await cmdSeed(false);
  // A fixture name resolves locally; anything else is looked up in the
  // configured incident source (Sentry when it is connected).
  const incident = INCIDENT_FIXTURES[fixtureName]
    ? INCIDENT_FIXTURES[fixtureName]()
    : await resolveIncident(fixtureName, config);
  const eff = effectiveProviders(config);
  console.log(
    c.dim(`providers: github=${eff.github} slack=${eff.slack} tickets=${eff.tickets} llm=${eff.llm}`),
  );
  console.log(c.o(`\n🔥 incident ${incident.id}: ${c.b(incident.title)}\n`));

  const outcome = await runWorkflow({
    incident,
    scenario: fixtureName,
    stopBefore: opts.stopBefore,
    onEvent: (ev) => {
      if (ev.type === 'step_succeeded') console.log(`  ${c.g('✓')} ${ev.message}`);
      else if (ev.type === 'step_failed') console.log(`  ${c.r('✗')} ${ev.message}`);
      else if (ev.type === 'retry') console.log(`  ${c.y('↻')} ${ev.step}: ${ev.message}`);
      else if (ev.type === 'step_skipped') console.log(`  ${c.dim('⊘')} ${ev.step}: ${ev.message}`);
      else if (ev.type === 'resume') console.log(`  ${c.y('⟳')} ${ev.message}`);
      else if (ev.type === 'blocked') console.log(`  ${c.r('⛔')} ${ev.step} blocked: ${ev.message}`);
    },
  });
  printSummary(outcome.run.incidentId);
}

function printSummary(incidentId: string): void {
  const run = getRunByIncident(incidentId);
  if (!run) return;
  const steps = listSteps(run.id);
  const incident = listIncidents().find((i) => i.id === incidentId)!;
  const ctx = hydrateContext(incident, steps);
  const inv = ctx.investigation;

  console.log(c.b('\n── Investigation ───────────────────────────────────'));
  if (inv?.suspect) {
    console.log(`  Suspected change : ${c.o(`PR #${inv.suspect.prNumber}`)} — ${inv.suspect.title}`);
    console.log(`  Confidence       : ${c.b(String(Math.round(inv.suspect.confidence * 100)) + '%')}`);
    console.log(`  Affected         : ${inv.affectedFunctionality}`);
    console.log(`  Root cause       : ${inv.rootCause}`);
    console.log('  Evidence:');
    for (const e of inv.suspect.evidence.slice(0, 6)) console.log(`    ${c.dim('•')} [${e.kind}] ${e.description}`);
    if (inv.rankedSuspects.length > 1) {
      console.log('  Ranked candidates:');
      for (const s of inv.rankedSuspects)
        console.log(`    ${String(Math.round(s.confidence * 100)).padStart(3)}%  PR #${s.prNumber} ${c.dim(s.title.slice(0, 50))}`);
    }
  } else {
    console.log(c.y('  inconclusive — no candidate cleared the confidence floor; no revert proposed'));
  }

  console.log(c.b('\n── Artifacts ───────────────────────────────────────'));
  console.log(`  Incident ticket : ${ctx.ticket ? c.g(ctx.ticket.identifier) + ' ' + c.dim(ctx.ticket.url) : c.dim('none')}`);
  console.log(`  Revert PR       : ${ctx.revertPr ? c.g('#' + ctx.revertPr.number) + ' ' + c.dim(ctx.revertPr.url) : c.dim('none')}`);
  console.log(`  Fix PR          : ${ctx.fixPr ? c.g('#' + ctx.fixPr.number) + ' ' + c.dim(ctx.fixPr.url) : c.dim('none')}`);
  console.log(`  Slack           : ${ctx.slack ? c.g(ctx.slack.channel + ' @ ' + ctx.slack.ts) : c.dim('none')}`);
  if (ctx.fixVerification)
    console.log(
      `  Fix verified    : ${ctx.fixVerification.tests.passed}/${ctx.fixVerification.tests.total} tests, lint ${ctx.fixVerification.lint.ok ? 'clean' : 'failing'}`,
    );

  const dupes = duplicateWriteCount(incidentId);
  console.log(c.b('\n── Reliability ─────────────────────────────────────'));
  console.log(`  status          : ${run.status === 'succeeded' ? c.g(run.status) : c.y(run.status)}`);
  console.log(`  external writes : ${listMutations(incidentId).length}`);
  console.log(`  duplicates      : ${dupes === 0 ? c.g('0') : c.r(String(dupes))}`);
  console.log(`  retries         : ${run.retryCount}`);
  console.log(`  steps           : ${steps.filter((s) => s.status === 'succeeded').length}/${steps.length} succeeded`);
  const notDone = steps.filter((s) => s.status !== 'succeeded');
  if (notDone.length) for (const s of notDone) console.log(`    ${c.y('•')} ${s.step}: ${s.status}${s.error ? ' — ' + s.error : ''}`);
  console.log(c.dim('\n  🛡 no PR merged, no deploy performed — human approval required.\n'));
}

function cmdStatus(): void {
  const incidents = listIncidents();
  if (!incidents.length) return console.log(c.dim('no incidents recorded'));
  const incident = incidents[0];
  const run = getRunByIncident(incident.id);
  if (!run) return console.log(c.dim('no run recorded'));
  console.log(c.b(`\n${incident.id} — ${incident.title}  [${run.status}]\n`));
  for (const e of listTimeline(run.id)) {
    console.log(`  ${ICON[e.kind] ?? '·'} ${c.dim(e.ts.slice(11, 19))} ${e.message}`);
  }
  printSummary(incident.id);
}

function cmdReset(): void {
  resetDb(config.dbPath);
  for (const p of ['tickets.json', 'slack-outbox']) {
    const full = path.join(config.dataDir, p);
    if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
  }
  console.log(c.g('✓ durable state reset'));
}

/** List the live incidents the configured source can see. */
async function cmdSentry(): Promise<void> {
  const eff = effectiveProviders(config);
  for (const n of eff.notes) console.log(c.y('  ! ' + n));
  const source = getIncidentSource(config);
  console.log(c.dim(`incident source: ${source.provider}`));
  const items = await source.listIncidents(10);
  if (!items.length) return console.log(c.dim('  no unresolved incidents'));
  for (const i of items) {
    console.log(`${c.o(i.id.padEnd(14))} ${c.b(i.title.slice(0, 62))}`);
    console.log(c.dim(`  ${i.level}  last seen ${i.lastSeen}  ${i.count} events  ${i.url}`));
  }
  console.log(c.dim(`\n  run one with: npm run run-incident -- <id>`));
}

function cmdBridge(args: string[]): void {
  if (args[0] === 'resolve') {
    const [, id, externalId, url] = args;
    const intent = resolveBridgeIntent(id, externalId, url ?? null);
    console.log(intent ? c.g(`✓ resolved ${id} -> ${externalId}`) : c.r(`unknown intent ${id}`));
    return;
  }
  const intents = listBridgeIntents();
  if (!intents.length) return console.log(c.dim('no bridge intents'));
  for (const i of intents) {
    console.log(`${i.status === 'pending' ? c.y('○') : c.g('●')} ${i.id}  ${i.kind}  ${i.status}  ${i.externalId ?? ''}`);
  }
  console.log(c.dim('\nresolve with: tsx src/cli.ts bridge resolve <id> <externalId> [url]'));
}

/** Greedy word-wrap so a long check detail stays inside the terminal. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * Verify every configured credential with one read-only call each.
 *
 * Diagnostic, never a gate: it always exits 0, so it is safe to run during an
 * incident and cannot fail a pipeline just because an integration is
 * deliberately mocked. `✓` is a working credential, `✗` a broken one, `–` an
 * integration that is intentionally mocked and therefore has nothing to prove.
 */
async function cmdPreflight(): Promise<void> {
  console.log(c.o('\n🔥 preflight — verifying every configured credential (read-only)\n'));
  const results = await preflight(config);
  const indent = ' '.repeat(12);
  const width = Math.max(56, (process.stdout.columns || 100) - indent.length - 2);

  for (const r of results) {
    const mark = r.ok ? (r.configured ? c.g('✓') : c.dim('–')) : c.r('✗');
    const name = r.configured ? c.b(r.name.padEnd(7)) : c.dim(r.name.padEnd(7));
    const lines = wrapText(r.detail, width);
    const paint = (s: string): string => (r.ok ? s : c.y(s));
    console.log(`  ${mark} ${name} ${paint(lines[0])}`);
    for (const line of lines.slice(1)) console.log(`${indent}${paint(line)}`);
    if (r.scopes?.length) console.log(c.dim(`${indent}scopes: ${r.scopes.join(', ')}`));
  }

  const live = results.filter((r) => r.configured);
  const failing = results.filter((r) => !r.ok);
  console.log(
    `\n  ${c.b(String(live.length))} live, ${c.b(String(results.length - live.length))} mocked, ` +
      (failing.length ? c.r(`${failing.length} failing`) : c.g('0 failing')),
  );
  if (failing.length) console.log(c.y(`  fix ${failing.map((r) => r.name).join(', ')} — setup instructions are in SETUP.md`));
  console.log(c.dim('  nothing was created: every check is a read-only identity lookup.\n'));
}


/**
 * Show causal verification working, probe by probe.
 *
 * Exists so the proof can be watched rather than taken on trust: it prints the
 * correlation ranking, then replays the failure at each candidate and its
 * parent, printing each verdict as it is decided.
 *
 * `--sabotage` deliberately promotes an innocent change to the top of the
 * ranking, so the self-correcting behaviour is visible: the wrong candidate is
 * ruled out by execution and the real culprit is still found.
 */
async function cmdBisect(idOrFixture: string, sabotage: boolean): Promise<void> {
  if (!isSeeded(config.demoRepoPath)) await cmdSeed(false);
  const incident = INCIDENT_FIXTURES[idOrFixture]
    ? INCIDENT_FIXTURES[idOrFixture]()
    : await resolveIncident(idOrFixture, config);

  const gh = getGitHubClient(config);
  const runner = getTestRunner(config);
  const [repo, commits, pullRequests, deployments] = await Promise.all([
    gh.getRepoInfo(),
    gh.getRecentCommits(30),
    gh.getRecentPullRequests(10),
    gh.getDeployments(10),
  ]);
  const failingFrame = topAppFrame(
    parseStackTrace(incident.stackTrace),
    [...new Set(commits.flatMap((x) => x.files))],
  );
  const investigation = analyze({
    incident,
    context: { repo, commits, pullRequests, deployments, codeMatches: [], failingFrame },
  });

  console.log(c.o(`\n🔥 ${incident.id}`));
  console.log(`   ${c.b(incident.title)}`);
  console.log(c.dim(`   failing frame: ${failingFrame?.fn} (${failingFrame?.file}:${failingFrame?.line})`));

  let candidates = investigation.rankedSuspects;
  console.log(c.b('\n── Step 1: correlation ranks candidates ────────────'));
  console.log(c.dim('   (a hypothesis — stack overlap, deploy timing, symbol matches)'));
  for (const s of candidates) {
    console.log(`   ${String(Math.round(s.confidence * 100)).padStart(3)}%  PR #${s.prNumber}  ${c.dim(s.title.slice(0, 48))}`);
  }

  if (sabotage) {
    const worst = [...candidates].sort((a, b) => a.confidence - b.confidence)[0];
    candidates = [worst, ...candidates.filter((x) => x.sha !== worst.sha)];
    console.log(c.y(`\n   ⚠ --sabotage: forcing PR #${worst.prNumber} (the weakest candidate) to the top`));
    console.log(c.dim('     to show that execution, not the score, decides the answer.'));
  }

  console.log(c.b('\n── Step 2: prove it by re-running the failure ──────'));
  const verification = await verifyCulprit({
    incident,
    candidates,
    repoPath: config.demoRepoPath,
    reproduce: (cwd) => runner.reproduce(incident, { cwd }),
    maxCandidates: candidates.length,
    onBaseline: (reproduced) =>
      console.log(
        reproduced
          ? `   ${c.g('✓')} baseline: the failure reproduces at HEAD`
          : `   ${c.r('✗')} baseline: the failure does NOT reproduce at HEAD — nothing to bisect`,
      ),
    onProbeStart: (cand) => console.log(`\n   ${c.cy('▶')} probing PR #${cand.prNumber} ${c.dim(cand.title.slice(0, 44))}`),
    onProbe: (p) => {
      const at = (label: string, yes: boolean | null): string =>
        yes === null ? c.dim(`     ${label}  (not probed)`) : `     ${label}  ${yes ? c.r('FAILS') : c.g('passes')}`;
      console.log(at(`${(p.parentSha ?? '(root)').slice(0, 10)}  parent `, p.reproducedAtParent));
      console.log(at(`${p.sha.slice(0, 10)}  change `, p.reproducedAtChange));
      const mark = p.verdict === 'proven' ? c.g('✓ PROVEN') : c.y('✗ ruled out');
      console.log(`     ${mark} ${c.dim(p.note)}`);
    },
  });

  console.log(c.b('\n── Verdict ─────────────────────────────────────────'));
  if (verification.verified) {
    console.log(`   ${c.g('CULPRIT PROVEN')}: PR #${verification.culpritPr}`);
    console.log(c.dim(`   ${verification.summary}`));
    if (verification.overrodeRanking) {
      console.log(
        c.y(`   ⚠ correlation ranked PR #${verification.rankedPr} first — execution disproved it.`),
      );
    }
  } else {
    console.log(`   ${c.y('NOT PROVEN')} — ${verification.summary}`);
  }
  console.log(c.dim(`   probed ${verification.probes.length} candidate(s) in ${verification.durationMs}ms\n`));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  openDb(config.dbPath);
  switch (cmd) {
    case 'seed': {
      const vi = args.indexOf('--variant');
      const variant = vi >= 0 && args[vi + 1] === 'sentry' ? 'sentry' : 'js';
      return cmdSeed(args.includes('--force'), variant);
    }
    case 'run': {
      const fixture = args.find((a) => !a.startsWith('--')) ?? 'checkout-guest-null-country';
      const stopIdx = args.indexOf('--stop-before');
      const stopBefore = stopIdx >= 0 ? (args[stopIdx + 1] as StepName) : undefined;
      return cmdRun(fixture, { stopBefore });
    }
    case 'demo':
      await cmdSeed(true);
      cmdReset();
      openDb(config.dbPath);
      return cmdRun('checkout-guest-null-country');
    case 'status':
      return cmdStatus();
    case 'reset':
      return cmdReset();
    case 'bridge':
      return cmdBridge(args);
    case 'sentry':
      return cmdSentry();
    case 'sentry-bootstrap': {
      const slug = args.find((a) => !a.startsWith('--')) ?? 'checkout-demo';
      const r = await bootstrapSentry(slug, config);
      console.log(c.g(`\n✓ ${r.projectCreated ? 'created' : 'reused'} ${r.org}/${r.project}`));
      console.log(c.dim(`  captured ${r.frames.length} frames from the real repository:`));
      for (const f of [...r.frames].reverse()) {
        console.log(c.dim(`    ${f.function} (${f.filename}:${f.lineno})`));
      }
      if (r.issueId) {
        console.log(c.g(`  issue ${r.shortId} (id ${r.issueId})`));
        console.log(c.dim(`\n  put these in .env:`));
        console.log(`    INCIDENT_SOURCE=sentry`);
        console.log(`    SENTRY_ORG=${r.org}`);
        console.log(`    SENTRY_PROJECT=${r.project}`);
        console.log(`    SENTRY_ISSUE_ID=${r.issueId}`);
        console.log(c.dim(`\n  then: npm run run-incident -- ${r.issueId}`));
      } else {
        console.log(c.y('  the event was accepted but has not been indexed yet — run "npm run sentry" shortly'));
      }
      return;
    }
    case 'preflight':
      return cmdPreflight();
    case 'bisect': {
      const target = args.find((a) => !a.startsWith('--')) ?? 'checkout-guest-null-country';
      return cmdBisect(target, args.includes('--sabotage'));
    }
    case 'github-setup': {
      const slug = args.find((a) => !a.startsWith('--')) ?? config.github.repo;
      if (!slug || !slug.includes('/')) {
        console.log(c.r('usage: tsx src/cli.ts github-setup <owner>/<name> [--public]'));
        return;
      }
      if (!isSeeded(config.demoRepoPath)) await cmdSeed(false);
      const r = await setupGitHubDemo(slug, { private: !args.includes('--public') });
      console.log(c.g(`\n✓ ${r.created ? 'created' : 'reused'} ${r.url}`));
      console.log(c.dim(`  pushed ${r.commits.length} commits to ${r.branch}`));
      for (const cm of r.commits) console.log(c.dim(`    ${cm.sha.slice(0, 10)}  ${cm.subject}`));
      console.log(c.dim(`\n  set GITHUB_PROVIDER=gh-cli and GITHUB_REPO=${r.repo} in .env`));
      return;
    }
    default:
      console.log(`firefighter — AI incident response

  seed [--force]                seed the demo repository
  demo                          full clean end-to-end demo run
  run [fixture|incident-id] [--stop-before <step>]
                                run one incident fixture, or a live incident id
                                fixtures: ${Object.keys(INCIDENT_FIXTURES).join(', ')}
  sentry                        list live incidents from the configured source
  sentry-bootstrap [project]    create a Sentry project + ingest a matching incident
  preflight                     check every configured credential (read-only)
  bisect [id] [--sabotage]      prove the culprit by execution, probe by probe
  github-setup <owner>/<name>   create + push the demo repo to real GitHub
  status                        print the latest run's timeline and summary
  reset                         wipe durable state
  bridge [resolve <id> <extId>] inspect/resolve connector bridge intents
`);
  }
}

main().catch((err) => {
  console.error(c.r(`\n✗ ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
