import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isSeeded, seedDemoRepo } from '../src/demo/seed.ts';
import { readMeta, writeMeta } from '../src/demo/meta.ts';
import { DEMO_COMMITS } from '../src/demo/fixtures.ts';

function tmpRepo(name: string): string {
  return path.join(os.tmpdir(), `ff-seedtest-${name}-${process.pid}`);
}

/**
 * Regression: isSeeded() once compared pullRequests.length to DEMO_COMMITS.length.
 * The agent appends its own PRs to that same array, so handling one incident made
 * isSeeded() false, and every `if (!isSeeded()) seedDemoRepo()` call site then
 * wiped the repository — destroying the branches the open PRs referred to.
 */
test('a repo stays "seeded" after the agent opens its own pull requests', async () => {
  const repoPath = tmpRepo('agentprs');
  fs.rmSync(repoPath, { recursive: true, force: true });
  await seedDemoRepo({ repoPath, force: true });
  assert.equal(isSeeded(repoPath), true, 'freshly seeded repo must be seeded');

  const meta = readMeta(repoPath)!;
  const seededCount = meta.pullRequests.length;
  meta.pullRequests.push({
    number: 151,
    title: '[MITIGATION] Revert something',
    body: '',
    author: 'firefighter',
    createdAt: '2026-09-13T10:00:00.000Z',
    mergedAt: '',
    mergeCommitSha: '',
    baseRef: 'main',
    headRef: 'firefighter/revert-pr-142-inc-1',
    labels: ['incident'],
  });
  meta.nextPrNumber = 152;
  writeMeta(repoPath, meta);

  assert.equal(readMeta(repoPath)!.pullRequests.length, seededCount + 1);
  assert.equal(
    isSeeded(repoPath),
    true,
    'a repo with agent-created PRs is still seeded and must NOT be rebuilt',
  );
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('a genuinely incomplete repo is still reported as not seeded', async () => {
  const repoPath = tmpRepo('partial');
  fs.rmSync(repoPath, { recursive: true, force: true });
  await seedDemoRepo({ repoPath, force: true });

  const meta = readMeta(repoPath)!;
  meta.pullRequests = meta.pullRequests.filter((p) => p.number !== DEMO_COMMITS[0].prNumber);
  writeMeta(repoPath, meta);

  assert.equal(isSeeded(repoPath), false, 'a missing seeded PR means the repo must be rebuilt');
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('seeding refuses to wipe a repo holding firefighter branches unless forced', async () => {
  const repoPath = tmpRepo('branches');
  fs.rmSync(repoPath, { recursive: true, force: true });
  await seedDemoRepo({ repoPath, force: true });
  execFileSync('git', ['branch', 'firefighter/fix-inc-1'], { cwd: repoPath });

  // A fully seeded repo is never rebuilt at all, so drive the dangerous path:
  // make the repo LOOK unseeded while agent branches are still present. That is
  // the state in which an unguarded seed would destroy real work.
  const partial = readMeta(repoPath)!;
  partial.pullRequests = partial.pullRequests.filter((p) => p.number !== DEMO_COMMITS[0].prNumber);
  writeMeta(repoPath, partial);
  assert.equal(isSeeded(repoPath), false, 'precondition: repo must look unseeded');

  await assert.rejects(
    () => seedDemoRepo({ repoPath, force: false }),
    /refusing to wipe|firefighter/i,
    'a non-forced seed must not destroy agent branches',
  );
  const branches = execFileSync('git', ['branch', '--list'], { cwd: repoPath, encoding: 'utf8' });
  assert.match(branches, /firefighter\/fix-inc-1/, 'the agent branch must survive');

  // force:true is the explicit escape hatch and must still work.
  await seedDemoRepo({ repoPath, force: true });
  assert.equal(isSeeded(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});
