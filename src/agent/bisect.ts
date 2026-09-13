/**
 * Culprit verification by execution.
 *
 * The analyzer *ranks* candidates from correlation — stack overlap, deploy
 * timing, symbol matches. That is a hypothesis, and at 3am a hypothesis is not
 * something you act on.
 *
 * This module turns the hypothesis into a proof. Because Firefighter can
 * already replay the production request against an arbitrary checkout of the
 * repository, it can run that reproduction on both sides of a change:
 *
 *     bug MUST reproduce at the suspect commit
 *     bug MUST NOT reproduce at the suspect's parent
 *
 * If both hold, the change introduced the fault — that is a causal claim, not a
 * correlation. If they do not hold, the ranked candidate is wrong and the next
 * one is probed, so verification also *corrects* the analyzer rather than
 * merely grading it.
 *
 * Every probe runs in a detached worktree, so the working tree is untouched and
 * probes cannot interfere with one another.
 */
import { CulpritProbe, CulpritVerification, Incident, ReproResult, SuspectScore } from '../types.ts';
import { withWorktree } from '../workflow/worktree.ts';
import { git } from '../tools/git.ts';
import { nowMs } from '../util/clock.ts';
import { logger } from '../util/log.ts';

const log = logger('agent:bisect');

/** Probing every candidate is wasteful; the ranking is usually close. */
export const DEFAULT_MAX_CANDIDATES = 4;

export interface VerifyCulpritInput {
  incident: Incident;
  /** Candidates in ranked order, best first. */
  candidates: SuspectScore[];
  repoPath: string;
  /** Replays the incident against a checkout. Must never throw. */
  reproduce: (cwd: string) => Promise<ReproResult>;
  maxCandidates?: number;
  /** Called as each candidate is about to be probed. For live output. */
  onProbeStart?: (candidate: SuspectScore) => void;
  /** Called with each probe's verdict as it is decided. */
  onProbe?: (probe: CulpritProbe) => void;
  /** Called once the HEAD baseline has been established. */
  onBaseline?: (reproduced: boolean) => void;
}

/** Resolve a commit's first parent, or null for a root commit. */
function parentOf(repoPath: string, sha: string): string | null {
  const res = git(['rev-parse', '--verify', '--quiet', `${sha}^`], { cwd: repoPath, allowFail: true });
  const parent = res.stdout.trim();
  return res.code === 0 && parent ? parent : null;
}

function commitExists(repoPath: string, sha: string): boolean {
  return git(['cat-file', '-e', `${sha}^{commit}`], { cwd: repoPath, allowFail: true }).code === 0;
}

/**
 * Prove which change introduced the incident.
 *
 * @returns a verification whose `verified` flag is true only when a change was
 *   positively shown to introduce the fault.
 */
export async function verifyCulprit(input: VerifyCulpritInput): Promise<CulpritVerification> {
  const started = nowMs();
  const { incident, repoPath, reproduce } = input;
  const max = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const probes: CulpritProbe[] = [];

  const rankedPr = input.candidates[0]?.prNumber ?? null;
  const base = (skippedReason: string | null): CulpritVerification => ({
    verified: false,
    method: 'bisect-reproduction',
    culpritPr: null,
    culpritSha: null,
    probes,
    summary: skippedReason ?? 'No candidate could be proven to introduce the fault.',
    rankedPr,
    overrodeRanking: false,
    skippedReason,
    durationMs: nowMs() - started,
  });

  if (!input.candidates.length) return base('No candidate changes to verify.');

  // 1. The reproduction must work at HEAD. Without a failing baseline there is
  //    nothing to bisect, and every probe below would be meaningless.
  const head = await safeReproduce(repoPath, 'HEAD', reproduce);
  input.onBaseline?.(head.reproduced);
  if (!head.reproduced) {
    const why = head.matchedError === false && head.output.includes('no sampleRequest')
      ? 'the incident carries no captured request to replay'
      : 'the incident does not reproduce at HEAD';
    log.warn(`skipping culprit verification: ${why}`);
    return base(`Could not verify by execution: ${why}. Falling back to correlation-based ranking.`);
  }
  log.info('reproduction confirmed at HEAD — probing candidates');

  // 2. Probe candidates in ranked order.
  // Cache the whole result: `reproduced` alone cannot distinguish "ran and was
  // clean" from "never ran", and that distinction decides whether a proof is
  // sound.
  const seen = new Map<string, ReproResult>();
  const reproduceAt = async (sha: string): Promise<ReproResult> => {
    const cached = seen.get(sha);
    if (cached !== undefined) return cached;
    const r = await safeReproduce(repoPath, sha, reproduce);
    seen.set(sha, r);
    return r;
  };

  const emit = (probe: CulpritProbe): CulpritProbe => {
    probes.push(probe);
    input.onProbe?.(probe);
    return probe;
  };

  for (const candidate of input.candidates.slice(0, max)) {
    input.onProbeStart?.(candidate);
    const sha = candidate.sha;
    const label = candidate.prNumber !== null ? `PR #${candidate.prNumber}` : sha.slice(0, 10);

    if (!sha || !commitExists(repoPath, sha)) {
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: null,
        reproducedAtChange: false,
        reproducedAtParent: null,
        verdict: 'inconclusive',
        note: `commit ${sha ? sha.slice(0, 10) : '(none)'} is not present in this repository`,
      });
      continue;
    }

    const parent = parentOf(repoPath, sha);
    if (!parent) {
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: null,
        reproducedAtChange: (await reproduceAt(sha)).reproduced,
        reproducedAtParent: null,
        verdict: 'inconclusive',
        note: 'root commit has no parent, so absence before the change cannot be shown',
      });
      continue;
    }

    const atChange = await reproduceAt(sha);
    if (!atChange.executed) {
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: parent,
        reproducedAtChange: false,
        reproducedAtParent: null,
        verdict: 'inconclusive',
        note: `the reproduction could not be executed at ${label}, so nothing can be concluded`,
      });
      log.warn(`${label}: probe could not execute — inconclusive, not ruled out`);
      continue;
    }
    if (!atChange.reproduced) {
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: parent,
        reproducedAtChange: false,
        reproducedAtParent: null,
        verdict: 'not-present-here',
        note: `the incident does not reproduce at ${label}, so it cannot have introduced it`,
      });
      log.info(`${label}: not reproducible at this commit — ruled out`);
      continue;
    }

    const atParent = await reproduceAt(parent);
    if (!atParent.executed) {
      // Critical: without this, a probe that CRASHED at the parent would look
      // exactly like "the fault was absent there" and be reported as a proof.
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: parent,
        reproducedAtChange: true,
        reproducedAtParent: null,
        verdict: 'inconclusive',
        note: `the reproduction could not be executed at the parent ${parent.slice(0, 10)}, so absence before the change cannot be shown`,
      });
      log.warn(`${label}: parent probe could not execute — refusing to claim a proof`);
      continue;
    }
    if (atParent.reproduced) {
      emit({
        prNumber: candidate.prNumber,
        sha,
        title: candidate.title,
        parentSha: parent,
        reproducedAtChange: true,
        reproducedAtParent: true,
        verdict: 'predates-this-change',
        note: `already reproduced at ${parent.slice(0, 10)}, the commit before ${label}`,
      });
      log.info(`${label}: fault already present in its parent — ruled out`);
      continue;
    }

    emit({
      prNumber: candidate.prNumber,
      sha,
      title: candidate.title,
      parentSha: parent,
      reproducedAtChange: true,
      reproducedAtParent: false,
      verdict: 'proven',
      note: `absent at ${parent.slice(0, 10)}, present at ${sha.slice(0, 10)}`,
    });
    log.info(`${label}: PROVEN — absent at parent, present at this commit`);

    const overrodeRanking = rankedPr !== null && candidate.prNumber !== rankedPr;
    if (overrodeRanking) {
      log.warn(`ranking said PR #${rankedPr}, execution proved PR #${candidate.prNumber}`);
    }
    return {
      verified: true,
      method: 'bisect-reproduction',
      culpritPr: candidate.prNumber,
      culpritSha: sha,
      probes,
      rankedPr,
      overrodeRanking,
      summary:
        `Verified by execution: the incident does NOT reproduce at ${parent.slice(0, 10)} ` +
        `(the commit before ${label}) and DOES reproduce at ${sha.slice(0, 10)}. ` +
        `${label} introduced the fault.`,
      skippedReason: null,
      durationMs: nowMs() - started,
    };
  }

  const tried = probes.length;
  return base(
    `Probed ${tried} candidate${tried === 1 ? '' : 's'} by execution; none was shown to introduce the fault. ` +
      `The ranking below is correlation-based and needs human confirmation.`,
  );
}

/** Run the reproduction at a ref in a throwaway worktree; never throws. */
async function safeReproduce(
  repoPath: string,
  ref: string,
  reproduce: (cwd: string) => Promise<ReproResult>,
): Promise<ReproResult> {
  try {
    return await withWorktree(repoPath, ref, (dir) => reproduce(dir));
  } catch (err) {
    return {
      reproduced: false,
      matchedError: false,
      executed: false,
      command: `(worktree at ${ref})`,
      durationMs: 0,
      output: `could not probe ${ref}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One-line human summary for logs, PR bodies and Slack. */
export function describeVerification(v: CulpritVerification | undefined): string {
  if (!v) return 'not attempted';
  if (v.verified) {
    return `proven by bisection (absent at ${v.probes.find((p) => p.verdict === 'proven')?.parentSha?.slice(0, 10)}, present at ${v.culpritSha?.slice(0, 10)})`;
  }
  return v.skippedReason ?? 'not proven';
}
