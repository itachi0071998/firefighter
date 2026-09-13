/**
 * Unit tests for culprit verification by bisection.
 *
 * `verifyCulprit` takes the reproduction as an injected function, so the
 * decision logic is tested with a FAKE reproduction and no service, no network
 * and no LLM. It does however drive real `git worktree` operations against
 * `repoPath`, so these tests build a throwaway four-commit repository in the
 * system temp directory and let the fake reproduction read a marker file out of
 * whichever commit the worktree was materialised at. That marker is the whole
 * fixture: it says "the bug exists here", exactly as a real replay would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_MAX_CANDIDATES, describeVerification, verifyCulprit } from '../src/agent/bisect.ts';
import { closeDb, openDb } from '../src/db/index.ts';
import { Incident, ReproResult, SuspectScore } from '../src/types.ts';

/** File the fake reproduction reads; its content decides "does the bug exist here". */
const MARKER = 'behaviour.txt';
const HEALTHY = 'healthy';
const REGRESSED = 'regressed';

/** A sha of the right shape that is deliberately absent from the repository. */
const ABSENT_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const INCIDENT: Incident = {
  id: 'INC-BISECT-1',
  title: 'Checkout 500 errors for guest users',
  service: 'checkout-service',
  severity: 'sev1',
  detectedAt: '2026-09-13T09:18:00.000Z',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of null (reading 'toUpperCase')",
  stackTrace: "TypeError: Cannot read properties of null (reading 'toUpperCase')",
  logs: [],
  source: 'unit-test',
};

let repoPath = '';
/** Commit shas, oldest first. Only `shaBug` flips the marker to REGRESSED. */
let shaBase = '';
let shaDocs = '';
let shaBug = '';
let shaLater = '';

function run(args: string[], date: string | null = null): string {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  return execFileSync('git', args, { cwd: repoPath, env, encoding: 'utf8' }).trim();
}

/** Write `files`, commit them at a fixed date, and return the new sha. */
function commit(message: string, date: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(repoPath, rel), body);
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', message], date);
  return run(['rev-parse', 'HEAD']);
}

function candidate(sha: string, prNumber: number | null, title: string): SuspectScore {
  return {
    prNumber,
    sha,
    title,
    author: 'sam-okafor',
    deployedAt: '2026-09-13T09:15:00.000Z',
    confidence: 0.8,
    evidence: [],
  };
}

function result(reproduced: boolean, output: string): ReproResult {
  return { reproduced, matchedError: reproduced, executed: true, command: `cat ${MARKER}`, output, durationMs: 0 };
}

/** The honest reproduction: the bug exists exactly where the marker says it does. */
async function markerReproduce(cwd: string): Promise<ReproResult> {
  const marker = fs.readFileSync(path.join(cwd, MARKER), 'utf8').trim();
  return result(marker === REGRESSED, marker);
}

/** A reproduction that never fires, i.e. the incident does not replay at all. */
async function neverReproduces(): Promise<ReproResult> {
  return result(false, 'no sampleRequest captured for this incident');
}

test.before(() => {
  // The guard audits refusals to SQLite; an in-memory database keeps these
  // tests from ever touching the real one.
  closeDb();
  openDb(':memory:');

  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bisect-'));
  run(['init', '--quiet', '-b', 'main']);
  run(['config', 'user.email', 'firefighter@example.test']);
  run(['config', 'user.name', 'Firefighter Test']);
  run(['config', 'commit.gpgsign', 'false']);

  shaBase = commit('chore: scaffold checkout service', '2026-09-10T10:00:00Z', {
    [MARKER]: `${HEALTHY}\n`,
    'README.md': 'checkout-service\n',
  });
  shaDocs = commit('docs: document the checkout API', '2026-09-11T10:00:00Z', {
    'README.md': 'checkout-service\n\n## API\n',
  });
  shaBug = commit('feat(checkout): enforce country-specific tax rules', '2026-09-13T09:10:00Z', {
    [MARKER]: `${REGRESSED}\n`,
  });
  shaLater = commit('chore: bump version', '2026-09-13T09:16:00Z', { 'VERSION': '1.4.0\n' });
});

test.after(() => {
  closeDb();
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
});

test('a change that introduces the failure is proven by execution', async () => {
  const v = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    reproduce: markerReproduce,
  });

  assert.equal(v.verified, true);
  assert.equal(v.method, 'bisect-reproduction');
  assert.equal(v.culpritPr, 142);
  assert.equal(v.culpritSha, shaBug);
  assert.equal(v.skippedReason, null);
  assert.equal(v.rankedPr, 142);
  assert.equal(v.overrodeRanking, false);

  assert.equal(v.probes.length, 1);
  const [probe] = v.probes;
  assert.equal(probe.verdict, 'proven');
  assert.equal(probe.reproducedAtChange, true);
  assert.equal(probe.reproducedAtParent, false);
  assert.equal(probe.parentSha, shaDocs);
});

test('execution corrects the ranking when the top candidate is innocent', async () => {
  const v = await verifyCulprit({
    incident: INCIDENT,
    candidates: [
      candidate(shaLater, 143, 'chore: bump version'),
      candidate(shaDocs, 141, 'docs: document the checkout API'),
      candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules'),
    ],
    repoPath,
    reproduce: markerReproduce,
  });

  assert.equal(v.verified, true);
  assert.equal(v.culpritPr, 142, 'the proven culprit, not the ranked one');
  assert.equal(v.culpritSha, shaBug);
  assert.equal(v.rankedPr, 143, 'what correlation put first is preserved for supervision');
  assert.equal(v.overrodeRanking, true);

  assert.deepEqual(
    v.probes.map((p) => [p.prNumber, p.verdict]),
    [
      // Present at #143 AND at its parent, so #143 inherited the fault.
      [143, 'predates-this-change'],
      // Absent at #141 entirely, so it cannot have introduced it.
      [141, 'not-present-here'],
      [142, 'proven'],
    ],
  );
  const ruledOut = v.probes.filter((p) => p.prNumber !== 142);
  assert.equal(
    ruledOut.every((p) => p.verdict === 'predates-this-change' || p.verdict === 'not-present-here'),
    true,
  );
  assert.equal(ruledOut.every((p) => p.note.length > 0), true, 'every refusal must explain itself');
});

test('nothing is blamed when the incident does not reproduce at HEAD', async () => {
  const v = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    reproduce: neverReproduces,
  });

  assert.equal(v.verified, false);
  assert.equal(v.culpritPr, null, 'an unprovable run must never blame a change');
  assert.equal(v.culpritSha, null);
  assert.equal(typeof v.skippedReason, 'string');
  assert.ok((v.skippedReason ?? '').length > 0, 'the fallback must say why it could not prove anything');
  assert.equal(v.probes.length, 0, 'no candidate is probed without a failing baseline');
  assert.equal(v.rankedPr, 142, 'the correlation answer survives as an unproven hypothesis');
});

test('a commit missing from the repository is inconclusive, not fatal', async () => {
  const v = await verifyCulprit({
    incident: INCIDENT,
    candidates: [
      candidate(ABSENT_SHA, 999, 'feat: change that lives in another repository'),
      candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules'),
    ],
    repoPath,
    reproduce: markerReproduce,
  });

  const [missing] = v.probes;
  assert.equal(missing.verdict, 'inconclusive');
  assert.equal(missing.prNumber, 999);
  assert.equal(missing.parentSha, null);
  assert.equal(missing.reproducedAtParent, null);
  assert.match(missing.note, /not present in this repository/);

  assert.equal(v.verified, true, 'probing continues past an unprobeable candidate');
  assert.equal(v.culpritPr, 142);
});

test('maxCandidates caps how many changes are probed', async () => {
  const candidates = [
    candidate(shaLater, 143, 'chore: bump version'),
    candidate(shaDocs, 141, 'docs: document the checkout API'),
    candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules'),
  ];
  const v = await verifyCulprit({ incident: INCIDENT, candidates, repoPath, reproduce: markerReproduce, maxCandidates: 2 });

  assert.ok(v.probes.length <= 2, `probed ${v.probes.length} candidates with a budget of 2`);
  assert.equal(v.probes.length, 2);
  assert.equal(v.verified, false, 'the culprit sat outside the budget, so nothing is proven');
  assert.equal(v.culpritPr, null);
  assert.equal(v.probes.some((p) => p.prNumber === 142), false, 'the third candidate was never reached');
  assert.equal(DEFAULT_MAX_CANDIDATES > 0, true);
});

test('an empty candidate list is reported, not crashed on', async () => {
  const v = await verifyCulprit({ incident: INCIDENT, candidates: [], repoPath, reproduce: markerReproduce });

  assert.equal(v.verified, false);
  assert.equal(v.culpritPr, null);
  assert.equal(v.rankedPr, null);
  assert.ok((v.skippedReason ?? '').length > 0);
  assert.deepEqual(v.probes, []);
});

test('verifyCulprit resolves even when the reproduction rejects', async () => {
  const alwaysThrows = async (): Promise<ReproResult> => {
    throw new Error('replay harness exploded');
  };
  const always = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    reproduce: alwaysThrows,
  });
  assert.equal(always.verified, false, 'a broken harness proves nothing');
  assert.equal(always.culpritPr, null);
  assert.ok((always.skippedReason ?? '').length > 0);

  // A rejection partway through — here only at the parent checkout — is
  // absorbed as "did not reproduce" rather than escaping as an exception.
  const throwsAtParent = async (cwd: string): Promise<ReproResult> => {
    const marker = fs.readFileSync(path.join(cwd, MARKER), 'utf8').trim();
    if (marker === HEALTHY) throw new Error('replay harness exploded at the parent commit');
    return result(true, marker);
  };
  const partial = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    reproduce: throwsAtParent,
  });
  assert.equal(partial.probes.length, 1, 'the run completed rather than propagating the rejection');
  assert.equal(partial.probes[0].reproducedAtChange, true);
});

test('describeVerification states the proof, or why there is none', async () => {
  assert.equal(describeVerification(undefined), 'not attempted');

  const proven = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    reproduce: markerReproduce,
  });
  const line = describeVerification(proven);
  assert.match(line, /proven by bisection/);
  assert.ok(line.includes(shaBug.slice(0, 10)) && line.includes(shaDocs.slice(0, 10)));

  const unproven = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBase, 140, 'chore: scaffold checkout service')],
    repoPath,
    reproduce: neverReproduces,
  });
  assert.equal(describeVerification(unproven), unproven.skippedReason);
});


/**
 * Regression: a probe that CANNOT EXECUTE at the parent commit used to be
 * indistinguishable from "the fault was absent there", and was therefore
 * reported as a proof. A false causal proof is the worst thing this system can
 * emit — it would send someone to revert an innocent change mid-incident.
 */
test('a probe that cannot execute at the parent never yields a proof', async () => {
  const v = await verifyCulprit({
    incident: INCIDENT,
    candidates: [candidate(shaBug, 142, 'feat(checkout): enforce country-specific tax rules')],
    repoPath,
    // Runs fine wherever the regression is present, but the healthy parent
    // checkout fails to execute at all (an unresolvable entry point, say).
    reproduce: async (cwd: string): Promise<ReproResult> => {
      const marker = fs.readFileSync(path.join(cwd, MARKER), 'utf8').trim();
      if (marker === HEALTHY) {
        return {
          reproduced: false,
          matchedError: false,
          executed: false,
          command: '(entry point could not be resolved)',
          durationMs: 1,
          output: 'No callable entry point could be resolved from the stack trace.',
        };
      }
      return { ...result(true, 'TypeError'), executed: true };
    },
  });

  assert.equal(v.verified, false, 'an unexecuted parent probe must never produce a proof');
  assert.equal(v.culpritPr, null, 'nothing may be blamed when the parent was never exercised');
  const probe = v.probes.find((p) => p.prNumber === 142);
  assert.equal(probe?.verdict, 'inconclusive');
  assert.equal(probe?.reproducedAtParent, null, 'the parent result must be null, not false');
  assert.match(String(probe?.note), /could not be executed/i);
});
