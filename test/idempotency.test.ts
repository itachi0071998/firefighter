import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db/index.ts';
import {
  upsertIncident,
  getOrCreateRun,
  withIdempotency,
  duplicateWriteCount,
  listMutations,
  markStepStarted,
  markStepSucceeded,
  recoverStaleSteps,
  listSteps,
} from '../src/db/repo.ts';
import { buildCheckoutIncident } from '../src/demo/incidents.ts';
import { hydrateContext } from '../src/workflow/engine.ts';

function fresh() {
  closeDb();
  openDb(':memory:');
  const incident = buildCheckoutIncident({ id: 'INC-TEST-1' });
  const { incident: stored } = upsertIncident(incident);
  const { run } = getOrCreateRun(stored.id);
  return { incident: stored, run };
}

test('identical incidents collapse onto one id and one run', () => {
  const { incident, run } = fresh();
  const again = upsertIncident({ ...incident, id: 'DIFFERENT-ID' });
  assert.equal(again.created, false);
  assert.equal(again.incident.id, incident.id);
  const secondRun = getOrCreateRun(incident.id);
  assert.equal(secondRun.created, false);
  assert.equal(secondRun.run.id, run.id);
});

test('withIdempotency executes the side effect exactly once', async () => {
  const { incident, run } = fresh();
  let calls = 0;
  const op = () =>
    withIdempotency(
      { key: `ticket:${incident.id}`, runId: run.id, incidentId: incident.id, kind: 'create_incident_ticket', subject: 'incident_ticket', payload: { a: 1 } },
      async () => {
        calls++;
        return { externalId: `INC-${calls}`, externalUrl: 'https://example.test/1' };
      },
    );

  const first = await op();
  const second = await op();
  const third = await op();

  assert.equal(calls, 1, 'side effect ran more than once');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(third.replayed, true);
  assert.equal(second.result.externalId, first.result.externalId);
  assert.equal(listMutations(incident.id).length, 1);
  assert.equal(duplicateWriteCount(incident.id), 0);
});

test('a changed payload still cannot create a second external entity', async () => {
  const { incident, run } = fresh();
  let calls = 0;
  const make = (payload: unknown) =>
    withIdempotency(
      { key: `pr:${incident.id}:revert:branch-a`, runId: run.id, incidentId: incident.id, kind: 'create_pull_request', subject: 'pull_request:revert', payload },
      async () => {
        calls++;
        return { externalId: String(150 + calls), externalUrl: 'u' };
      },
    );
  await make({ title: 'first' });
  const second = await make({ title: 'changed after a retry' });
  assert.equal(calls, 1);
  assert.equal(second.replayed, true);
  assert.equal(second.result.externalId, '151');
  assert.equal(duplicateWriteCount(incident.id), 0);
});

test('duplicateWriteCount detects a genuine duplicate', async () => {
  const { incident, run } = fresh();
  for (const key of ['k1', 'k2']) {
    await withIdempotency(
      { key, runId: run.id, incidentId: incident.id, kind: 'create_incident_ticket', subject: 'incident_ticket', payload: {} },
      async () => ({ externalId: `TICKET-${key}`, externalUrl: null }),
    );
  }
  assert.equal(duplicateWriteCount(incident.id), 1, 'two tickets for one incident must count as a duplicate');
});

test('a step left running by a crash is recovered to pending', () => {
  const { incident, run } = fresh();
  markStepStarted(run.id, 'collect_context');
  assert.equal(listSteps(run.id).find((s) => s.step === 'collect_context')!.status, 'running');
  const recovered = recoverStaleSteps(run.id);
  assert.deepEqual(recovered, ['collect_context']);
  assert.equal(listSteps(run.id).find((s) => s.step === 'collect_context')!.status, 'pending');
});

test('context is rebuilt losslessly from persisted step outputs', () => {
  const { incident, run } = fresh();
  markStepStarted(run.id, 'create_incident_ticket');
  markStepSucceeded(run.id, 'create_incident_ticket', { ticket: { id: 't1', identifier: 'INC-9' } }, 5);
  markStepStarted(run.id, 'create_revert_pr');
  markStepSucceeded(run.id, 'create_revert_pr', { revertPr: { number: 151 } }, 5);

  const ctx = hydrateContext(incident, listSteps(run.id));
  assert.equal(ctx.ticket?.identifier, 'INC-9');
  assert.equal(ctx.revertPr?.number, 151);
  assert.equal(ctx.incident.id, incident.id);
});


test('two branches and two PRs for one incident are not duplicates', async () => {
  const { incident, run } = fresh();
  const write = (key: string, subject: string, kind: string, externalId: string) =>
    withIdempotency({ key, runId: run.id, incidentId: incident.id, kind, subject, payload: {} }, async () => ({
      externalId,
      externalUrl: null,
    }));

  await write('branch:a', 'branch:revert', 'create_branch', 'firefighter/revert-pr-142');
  await write('branch:b', 'branch:fix', 'create_branch', 'firefighter/fix-inc-1');
  await write('pr:a', 'pull_request:revert', 'create_pull_request', '151');
  await write('pr:b', 'pull_request:fix', 'create_pull_request', '152');
  await write('ticket:a', 'incident_ticket', 'create_incident_ticket', 'INC-1');
  await write('slack:a', 'slack_update', 'post_slack_update', '1757754000.0017');

  assert.equal(duplicateWriteCount(incident.id), 0, 'a revert and a fix are distinct logical entities');
  assert.equal(listMutations(incident.id).length, 6);

  // ...but a SECOND revert PR under a different key is a real duplicate.
  await write('pr:c', 'pull_request:revert', 'create_pull_request', '153');
  assert.equal(duplicateWriteCount(incident.id), 1, 'two revert PRs must be flagged');
});
