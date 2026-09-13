import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db/index.ts';
import {
  assertSafeAction,
  assertSafeGitCommand,
  assertSafeHttp,
  checkAction,
  isProtectedBranch,
  UnsafeActionError,
} from '../src/tools/guard.ts';
import { unsafeActionCount, listSafetyEvents } from '../src/db/repo.ts';

test.beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

test('production-changing actions are refused', () => {
  for (const action of ['merge_pull_request', 'deploy', 'force_push', 'delete_branch', 'rollout']) {
    assert.throws(() => assertSafeAction(action, 'main', null), UnsafeActionError, `${action} should be blocked`);
    assert.equal(checkAction(action, 'main').allowed, false);
  }
});

test('the actions the agent legitimately needs are permitted', () => {
  for (const action of [
    'create_incident_ticket',
    'create_branch',
    'generate_revert',
    'apply_patch',
    'create_pull_request',
    'post_slack_update',
    'run_tests',
    'run_lint',
  ]) {
    assert.doesNotThrow(() => assertSafeAction(action, 'firefighter/fix-inc-1', null), `${action} should be allowed`);
  }
});

test('git force-push and protected-branch writes are refused', () => {
  const blocked = [
    ['push', '--force', 'origin', 'main'],
    ['push', 'origin', 'HEAD:main'],
    ['push', 'origin', 'main'],
    ['branch', '-D', 'main'],
    ['reset', '--hard', 'origin/main'],
  ];
  for (const argv of blocked) {
    assert.throws(() => assertSafeGitCommand(argv, null), UnsafeActionError, argv.join(' '));
  }
});

test('ordinary git reads and firefighter branch work are permitted', () => {
  const allowed = [
    ['log', '--oneline', '-n', '20'],
    ['show', '--numstat', 'HEAD'],
    ['status', '--porcelain'],
    ['worktree', 'add', '--detach', '/tmp/x', 'main'],
    ['branch', 'firefighter/revert-pr-142', 'main'],
    ['revert', '--no-edit', 'abc1234'],
  ];
  for (const argv of allowed) {
    assert.doesNotThrow(() => assertSafeGitCommand(argv, null), argv.join(' '));
  }
});

test('GitHub merge and deployment endpoints are refused', () => {
  assert.throws(() => assertSafeHttp('PUT', 'https://api.github.com/repos/o/r/pulls/1/merge', null), UnsafeActionError);
  assert.throws(() => assertSafeHttp('POST', 'https://api.github.com/repos/o/r/deployments', null), UnsafeActionError);
  assert.doesNotThrow(() => assertSafeHttp('GET', 'https://api.github.com/repos/o/r/pulls/1', null));
  assert.doesNotThrow(() => assertSafeHttp('POST', 'https://api.github.com/repos/o/r/pulls', null));
});

test('every refusal is written to the audit trail and none are recorded as executed', () => {
  try {
    assertSafeAction('merge_pull_request', '#142', null);
  } catch {
    /* expected */
  }
  const events = listSafetyEvents();
  assert.ok(events.length >= 1, 'refusal should be audited');
  assert.equal(events.every((e) => e.blocked), true);
  assert.equal(unsafeActionCount(), 0, 'no unsafe action may ever be recorded as executed');
});

test('protected branches are recognised', () => {
  for (const b of ['main', 'master', 'production', 'prod', 'release/2026.09']) {
    assert.equal(isProtectedBranch(b), true, b);
  }
  for (const b of ['firefighter/fix-inc-1', 'feature/x']) {
    assert.equal(isProtectedBranch(b), false, b);
  }
});

test('the GitHub client exposes no merge, deploy or force-push capability', async () => {
  const { getGitHubClient } = await import('../src/tools/github.ts');
  const client = getGitHubClient() as unknown as Record<string, unknown>;
  const surface = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(client);
  while (proto && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) surface.add(k);
    proto = Object.getPrototypeOf(proto);
  }
  for (const k of Object.keys(client)) surface.add(k);

  // Read-only members are fine: reading deployment history is how the temporal
  // signal works, and isMerge() classifies a commit. What must not exist is any
  // member that PERFORMS a merge, deploy, force-push or delete.
  const readOnly = /^(get|is|list|read|search|inspect|fetch|has|count|parse|normalise|normalize|derive|map|resolve)/;
  const forbidden = /merge|deploy|release|force.?push|rollout|delete|revert.?merge/i;
  const offenders = [...surface].filter((k) => !readOnly.test(k) && forbidden.test(k));
  assert.deepEqual(offenders, [], `GitHub client must not expose a mutating: ${offenders.join(', ')}`);
});

test('the tool registry exposes no merge or deploy tool', async () => {
  const { createTools } = await import('../src/tools/index.ts');
  const { config } = await import('../src/config.ts');
  const tools = createTools({ runId: 'r', incidentId: 'i', cfg: config, step: null });
  const readOnly = /^(get|is|list|read|search|inspect|fetch)/;
  const offenders = Object.keys(tools).filter(
    (k) => !readOnly.test(k) && /merge|deploy|release|rollout/i.test(k),
  );
  assert.deepEqual(offenders, [], `tool registry must not expose a mutating: ${offenders.join(', ')}`);
});
