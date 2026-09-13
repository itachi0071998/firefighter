/**
 * Jira adapter contract tests.
 *
 * Every assertion here encodes a rule the real Jira Cloud REST v3 API enforces
 * with a 400 and no second chance: ADF bodies rather than Markdown, a
 * single-line 255-character summary, whitespace-free labels, and a status that
 * can only be moved by a transition. The API under test is a local fake on
 * 127.0.0.1 — these tests never talk to a real Jira, and never need a token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Config, loadConfig } from '../src/config.ts';
import { buildTicketDescription, getTicketClient, TicketClient, TicketInput } from '../src/tools/tickets.ts';
import { Incident, Investigation, PullRequestRef } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fake Jira
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  /** `path` with the issue key replaced by `:key`, so routes are comparable. */
  route: string;
  auth: string;
  body: unknown;
}

interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Responder = (req: RecordedRequest) => FakeReply;
type JsonObject = Record<string, unknown>;

const KEY = 'INC-42';
const EMAIL = 'firefighter@example.test';
const TOKEN = 'fake-jira-api-token-0123456789';

const requests: RecordedRequest[] = [];
const handlers = new Map<string, Responder[]>();
let base = '';

/** `/rest/api/3/issue/INC-42/transitions` -> `/rest/api/3/issue/:key/transitions`. */
function routeOf(pathname: string): string {
  return pathname.replace(/^(\/rest\/api\/3\/issue)\/[^/]+/, '$1/:key');
}

/** Script a route. Extra replies are consumed in order; the last one repeats. */
function on(method: string, route: string, ...replies: Responder[]): void {
  handlers.set(`${method} ${route}`, [...replies]);
}

function json(status: number, body?: unknown, headers?: Record<string, string>): Responder {
  return () => ({ status, body, headers });
}

function nextResponder(key: string): Responder | null {
  const queue = handlers.get(key);
  if (!queue || !queue.length) return null;
  return queue.length > 1 ? (queue.shift() as Responder) : queue[0];
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      route: routeOf(url.pathname),
      auth: String(req.headers.authorization ?? ''),
      body: raw ? parseBody(raw) : null,
    };
    requests.push(record);
    const responder = nextResponder(`${record.method} ${record.route}`);
    const reply: FakeReply = responder
      ? responder(record)
      : { status: 404, body: { errorMessages: [`fake jira has no route for ${record.method} ${record.route}`] } };
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
});

/** The happy path every test starts from and then overrides one piece of. */
function installDefaults(): void {
  on('GET', '/rest/api/3/myself', json(200, { accountId: 'acc-1', displayName: 'Firefighter Bot' }));
  on('POST', '/rest/api/3/issue', json(201, { id: '10042', key: KEY, self: `${base}/rest/api/3/issue/10042` }));
  on(
    'GET',
    '/rest/api/3/issue/:key',
    json(200, { id: '10042', key: KEY, fields: { summary: 'Checkout failing', status: { name: 'To Do' } } }),
  );
  on('PUT', '/rest/api/3/issue/:key', json(204));
  on(
    'GET',
    '/rest/api/3/issue/:key/transitions',
    json(200, {
      transitions: [
        { id: '21', name: 'Start Progress', to: { name: 'In Progress' } },
        { id: '31', name: 'Resolve', to: { name: 'Done' } },
      ],
    }),
  );
  // Jira answers a successful transition with 204 and an empty body.
  on('POST', '/rest/api/3/issue/:key/transitions', json(204));
  on('POST', '/rest/api/3/issue/:key/comment', json(201, { id: '10100' }));
}

test.before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  // Destroy keep-alive sockets too, or close() waits for fetch's pooled
  // connections and the test process never exits.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test.beforeEach(() => {
  requests.length = 0;
  handlers.clear();
  installDefaults();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A Jira client pointed at the fake, via a config override. */
function jiraClient(overrides: Partial<Config['tickets']> = {}): TicketClient {
  const cfg = loadConfig({
    tickets: {
      provider: 'jira',
      linearApiKey: '',
      linearTeamKey: 'ENG',
      jiraBaseUrl: base,
      jiraEmail: EMAIL,
      jiraApiToken: TOKEN,
      jiraProjectKey: 'INC',
      ...overrides,
    },
  });
  const client = getTicketClient(cfg);
  assert.equal(client.provider, 'jira', 'the config override must select the Jira client');
  return client;
}

function ticketInput(overrides: Partial<TicketInput> = {}): TicketInput {
  return {
    incidentId: 'INC-TEST-1',
    title: '[SEV1] Checkout returns 500 for guest users',
    description: '## Summary\n\nCheckout is failing.',
    severity: 'sev1',
    labels: ['incident', 'firefighter', 'checkout service'],
    ...overrides,
  };
}

function basicHeader(): string {
  return Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
}

function asObject(value: unknown, what: string): JsonObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${what} must be a JSON object`);
  return value as JsonObject;
}

function requestFor(method: string, route: string): RecordedRequest {
  const hit = requests.find((r) => r.method === method && r.route === route);
  assert.ok(hit, `expected a ${method} ${route} request, saw ${requests.map((r) => `${r.method} ${r.route}`).join(', ')}`);
  return hit;
}

function countRequests(method: string, route: string): number {
  return requests.filter((r) => r.method === method && r.route === route).length;
}

function fieldsOf(req: RecordedRequest): JsonObject {
  return asObject(asObject(req.body, 'request body').fields, 'fields');
}

/** Visit every ADF node, failing on anything Jira would reject. */
function walkAdf(node: unknown, visit: (n: JsonObject) => void): void {
  assert.ok(node !== undefined && node !== null, 'the ADF document contained an empty node');
  const obj = asObject(node, 'ADF node');
  assert.equal(typeof obj.type, 'string', 'every ADF node needs a type');
  visit(obj);
  if (obj.content === undefined) return;
  assert.ok(Array.isArray(obj.content), 'ADF content must be an array');
  for (const child of obj.content as unknown[]) walkAdf(child, visit);
}

// ---------------------------------------------------------------------------
// Fixtures for a realistic description
// ---------------------------------------------------------------------------

const INCIDENT: Incident = {
  id: 'INC-TEST-1',
  title: 'Checkout returns 500 for guest users',
  service: 'checkout-service',
  severity: 'sev1',
  detectedAt: '2026-09-14T02:00:00.000Z',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of null (reading 'toUpperCase')",
  stackTrace: [
    "TypeError: Cannot read properties of null (reading 'toUpperCase')",
    '    at CheckoutValidator.country (/app/src/validators/CheckoutValidator.js:34:31)',
    '    at handleCheckout (/app/src/checkout.js:28:31)',
  ].join('\n'),
  logs: [{ ts: '2026-09-14T02:00:01.000Z', level: 'error', msg: 'checkout failed', requestId: 'req_1' }],
  metrics: { errorRatePct: 12.4, affectedRequests: 812, window: 'last 15 minutes' },
  source: 'sentry',
};

const REVERT_PR: PullRequestRef = {
  number: 151,
  url: 'https://github.example.test/acme/checkout/pull/151',
  branch: 'firefighter/revert-pr-142',
  baseBranch: 'main',
  title: 'Revert "Require country on checkout"',
  provider: 'mock',
  kind: 'revert',
  merged: false,
};

const INVESTIGATION: Investigation = {
  suspect: {
    prNumber: 142,
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    title: 'Require country on checkout',
    author: 'dev@example.test',
    deployedAt: '2026-09-14T01:40:00.000Z',
    confidence: 0.92,
    evidence: [
      {
        kind: 'stack_trace',
        description: 'The failing frame is inside `CheckoutValidator.country`',
        weight: 0.4,
        score: 1,
        detail: 'src/validators/CheckoutValidator.js:34 was added by this change',
      },
      { kind: 'temporal', description: 'Deployed 20 minutes before detection', weight: 0.35, score: 0.9 },
    ],
  },
  rankedSuspects: [],
  failingFrame: { fn: 'CheckoutValidator.country', file: '/app/src/validators/CheckoutValidator.js', line: 34, column: 31 },
  affectedFunctionality: 'Guest checkout',
  rootCause: 'country is null for guest customers and is dereferenced without a guard',
  immediateMitigation: 'Revert PR #142',
  permanentFix: 'Default the country before upper-casing it',
  reasoningSource: 'deterministic',
  narrative: 'Execution proved the fault appears at PR #142 and is absent at its parent.',
  inconclusive: false,
  verification: {
    verified: true,
    method: 'bisect-reproduction',
    culpritPr: 142,
    culpritSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    probes: [
      {
        prNumber: 142,
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        title: 'Require country on checkout',
        parentSha: '99887766554433221100aabbccddeeff00112233',
        reproducedAtChange: true,
        reproducedAtParent: false,
        verdict: 'proven',
        note: 'reproduced at the change, clean at the parent',
      },
    ],
    summary: 'PR #142 is the culprit',
    rankedPr: 139,
    // Forces the `> ...` quote line into the description, so the ADF converter
    // is exercised on a blockquote as well.
    overrodeRanking: true,
    skippedReason: null,
    durationMs: 4200,
  },
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('create posts an ADF issue to REST v3 with Basic auth', async () => {
  const ref = await jiraClient().createIncidentTicket(ticketInput());

  // The credential preflight runs before any write.
  assert.ok(requests[0], 'no request reached the fake Jira');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, '/rest/api/3/myself');

  const create = requestFor('POST', '/rest/api/3/issue');
  assert.equal(create.path, '/rest/api/3/issue');
  assert.match(create.auth, /^Basic /, 'Jira Cloud uses Basic auth, not Bearer');
  assert.equal(Buffer.from(create.auth.slice('Basic '.length), 'base64').toString('utf8'), `${EMAIL}:${TOKEN}`);

  const fields = fieldsOf(create);
  assert.equal(asObject(fields.project, 'project').key, 'INC');
  assert.equal(asObject(fields.issuetype, 'issuetype').name, 'Bug');
  assert.equal(typeof fields.summary, 'string');
  assert.ok(String(fields.summary).length <= 255);
  assert.ok(!String(fields.summary).includes('\n'));

  assert.notEqual(typeof fields.description, 'string', 'v3 rejects a plain-string description with a 400');
  const doc = asObject(fields.description, 'description');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.content) && (doc.content as unknown[]).length > 0);

  assert.equal(ref.identifier, KEY, 'the human-facing identifier is the Jira key');
  assert.equal(ref.id, KEY);
  assert.equal(ref.url, `${base}/browse/${KEY}`, 'the browse URL is what a human clicks');
  assert.equal(ref.provider, 'jira');
  assert.equal(ref.state, 'To Do');
});

test('a long, multi-line title is truncated to a legal summary', async () => {
  const longTitle = `[SEV1] TypeError: Cannot read properties of null\n  at CheckoutValidator ${'x'.repeat(400)}`;
  const ref = await jiraClient().createIncidentTicket(ticketInput({ title: longTitle }));

  const summary = String(fieldsOf(requestFor('POST', '/rest/api/3/issue')).summary);
  assert.ok(summary.length <= 255, `summary was ${summary.length} characters`);
  assert.ok(!summary.includes('\n'), 'Jira 400s on a multi-line summary');
  assert.ok(summary.startsWith('[SEV1] TypeError'), 'the useful prefix must survive truncation');
  assert.notEqual(summary, longTitle);
  assert.equal(ref.title, summary, 'the reference reports what Jira actually holds');
});

test('labels containing spaces are sanitised, since Jira rejects them', async () => {
  await jiraClient().createIncidentTicket(
    ticketInput({ labels: ['incident', 'firefighter', 'checkout service', '   ', 'checkout service', 'multi  word'] }),
  );

  const labels = fieldsOf(requestFor('POST', '/rest/api/3/issue')).labels;
  assert.deepEqual(labels, ['incident', 'firefighter', 'checkout-service', 'multi-word']);
  for (const label of labels as string[]) assert.ok(!/\s/.test(label), `"${label}" still contains whitespace`);
});

test('a trailing slash on JIRA_BASE_URL does not produce a broken link', async () => {
  const ref = await jiraClient({ jiraBaseUrl: `${base}/` }).createIncidentTicket(ticketInput());
  assert.equal(ref.url, `${base}/browse/${KEY}`);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a 400 surfaces the error messages Jira returned, and never the credentials', async () => {
  on(
    'POST',
    '/rest/api/3/issue',
    json(400, {
      errorMessages: ["Field 'customfield_10010' cannot be set. It is not on the appropriate screen, or unknown."],
      errors: {},
    }),
  );

  await assert.rejects(
    () => jiraClient().createIncidentTicket(ticketInput()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /customfield_10010/, "Jira's own complaint is what makes this diagnosable");
      assert.match(err.message, /HTTP 400/);
      assert.ok(!err.message.includes(TOKEN), 'the API token must never reach an Error message');
      assert.ok(!err.message.includes(basicHeader()), 'the Basic header must never reach an Error message');
      return true;
    },
  );
  assert.equal(countRequests('POST', '/rest/api/3/issue'), 1, 'an unfixable 400 must not be retried');
});

test('a 429 is retried and then succeeds', async () => {
  on(
    'POST',
    '/rest/api/3/issue',
    json(429, { errorMessages: ['Rate limit exceeded'] }, { 'retry-after': '0' }),
    json(201, { id: '10042', key: KEY, self: '' }),
  );

  const ref = await jiraClient().createIncidentTicket(ticketInput());
  assert.equal(ref.identifier, KEY);
  assert.equal(countRequests('POST', '/rest/api/3/issue'), 2, 'the 429 should have been retried exactly once');
});

test('a field Jira refuses on the create screen is dropped rather than failing the write', async () => {
  on(
    'POST',
    '/rest/api/3/issue',
    json(400, {
      errorMessages: [],
      errors: { priority: "Field 'priority' cannot be set. It is not on the appropriate screen, or unknown." },
    }),
    json(201, { id: '10042', key: KEY, self: '' }),
  );

  const ref = await jiraClient().createIncidentTicket(ticketInput());
  const posts = requests.filter((r) => r.method === 'POST' && r.route === '/rest/api/3/issue');
  assert.equal(posts.length, 2);
  assert.ok('priority' in fieldsOf(posts[0]), 'the first attempt should ask for a priority');
  assert.ok(!('priority' in fieldsOf(posts[1])), 'the retry must drop the field Jira named');
  assert.equal(asObject(fieldsOf(posts[1]).description, 'description').type, 'doc', 'the retry keeps the real body');
  assert.equal(ref.identifier, KEY);
});

test('a credential failure is explained and stops before any write', async () => {
  on(
    'GET',
    '/rest/api/3/myself',
    json(401, { errorMessages: ['Client must be authenticated to access this resource.'] }),
  );

  await assert.rejects(
    () => jiraClient().createIncidentTicket(ticketInput()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 401/);
      assert.match(err.message, /API token/i, 'the fix must be stated, not just the status code');
      assert.ok(!err.message.includes(TOKEN));
      return true;
    },
  );
  assert.equal(countRequests('POST', '/rest/api/3/issue'), 0, 'bad credentials must not attempt to create an issue');
});

test('a missing JIRA_EMAIL fails with the reason, not a 401', async () => {
  await assert.rejects(() => jiraClient({ jiraEmail: '' }).createIncidentTicket(ticketInput()), /JIRA_EMAIL/);
  assert.equal(requests.length, 0, 'a configuration error must not hit the network');
});

test('the credential preflight is spent once per client, not once per write', async () => {
  // One client is built per run, so an uncached preflight would add a round
  // trip to every write for no new information.
  const client = jiraClient();
  await client.createIncidentTicket(ticketInput());
  await client.createIncidentTicket(ticketInput({ incidentId: 'INC-TEST-2' }));

  assert.equal(countRequests('POST', '/rest/api/3/issue'), 2, 'both writes should have been attempted');
  assert.equal(countRequests('GET', '/rest/api/3/myself'), 1, 'the credentials are checked once, then cached');
});

// ---------------------------------------------------------------------------
// Update / transitions / comments
// ---------------------------------------------------------------------------

test('a status change is executed as a transition, not a field update', async () => {
  on(
    'GET',
    '/rest/api/3/issue/:key',
    json(200, { id: '10042', key: KEY, fields: { summary: 'Checkout failing', status: { name: 'In Progress' } } }),
  );

  const ref = await jiraClient().updateTicket(KEY, { state: 'In Progress' });

  assert.equal(countRequests('PUT', '/rest/api/3/issue/:key'), 0, 'a status cannot be PUT on a Jira issue');
  const post = requestFor('POST', '/rest/api/3/issue/:key/transitions');
  // "In Progress" is reached by a transition named "Start Progress": the match
  // has to be on the target status, not the transition's own name.
  assert.equal(asObject(asObject(post.body, 'body').transition, 'transition').id, '21');
  assert.equal(ref.state, 'In Progress');
  assert.equal(ref.identifier, KEY);
  assert.equal(ref.url, `${base}/browse/${KEY}`);
});

test('a description update sends ADF and an unavailable transition does not throw', async () => {
  on('GET', '/rest/api/3/issue/:key/transitions', json(200, { transitions: [{ id: '31', name: 'Resolve', to: { name: 'Done' } }] }));

  const ref = await jiraClient().updateTicket(KEY, { state: 'Triage', description: '## Update\n\n- still open' });

  const put = requestFor('PUT', '/rest/api/3/issue/:key');
  assert.equal(asObject(fieldsOf(put).description, 'description').type, 'doc');
  assert.equal(countRequests('POST', '/rest/api/3/issue/:key/transitions'), 0, 'no transition reaches "Triage"');
  assert.equal(ref.identifier, KEY, 'the ticket reference survives a refused transition');
});

test('a transition endpoint failure does not fail the incident response', async () => {
  on('GET', '/rest/api/3/issue/:key/transitions', json(500, { errorMessages: ['Internal server error'] }));

  const ref = await jiraClient().updateTicket(KEY, { state: 'In Progress' });
  assert.equal(ref.identifier, KEY);
  assert.equal(ref.state, 'To Do', 'the state read back from Jira wins over the requested one');
});

test('an unreadable issue still yields a usable ticket reference', async () => {
  // The transition succeeded; only the read-back is broken. Losing the key and
  // the browse URL here would strand a ticket that Jira actually holds.
  on('GET', '/rest/api/3/issue/:key', json(500, { errorMessages: ['Internal server error'] }));

  const ref = await jiraClient().updateTicket(KEY, { state: 'In Progress' });

  assert.equal(countRequests('POST', '/rest/api/3/issue/:key/transitions'), 1, 'the transition itself should run');
  assert.equal(ref.identifier, KEY);
  assert.equal(ref.id, KEY);
  assert.equal(ref.url, `${base}/browse/${KEY}`, 'the human still needs a link to the ticket');
  assert.equal(ref.provider, 'jira');
  assert.equal(ref.state, 'In Progress', 'with no read-back, the requested state is the best answer available');
});

test('a rejected comment is logged, not thrown', async () => {
  on('POST', '/rest/api/3/issue/:key/comment', json(400, { errorMessages: ['Comment body is not valid.'] }));

  await assert.doesNotReject(() => jiraClient().addComment(KEY, 'Revert PR opened.'));
  assert.equal(countRequests('POST', '/rest/api/3/issue/:key/comment'), 1);
});

test('a comment body is posted as ADF', async () => {
  await jiraClient().addComment(KEY, 'Revert PR [#151](https://example.test/pr/151) is open. **Not merged.**');

  const comment = requestFor('POST', '/rest/api/3/issue/:key/comment');
  const doc = asObject(asObject(comment.body, 'body').body, 'comment body');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.content) && (doc.content as unknown[]).length > 0);
});

// ---------------------------------------------------------------------------
// ADF conversion
// ---------------------------------------------------------------------------

test('a real ticket description converts to a valid ADF document', async () => {
  const description = buildTicketDescription({
    incident: INCIDENT,
    investigation: INVESTIGATION,
    revertPr: REVERT_PR,
    fixPr: null,
  });
  assert.ok(description.includes('## Summary'), 'the fixture must exercise the real body');

  await jiraClient().createIncidentTicket(ticketInput({ description }));
  const doc = asObject(fieldsOf(requestFor('POST', '/rest/api/3/issue')).description, 'description');

  const types = new Set<string>();
  const texts: string[] = [];
  const hrefs: string[] = [];
  walkAdf(doc, (node) => {
    types.add(String(node.type));
    if (node.type === 'text') {
      assert.equal(typeof node.text, 'string');
      assert.ok(String(node.text).length > 0, 'ADF rejects an empty text node');
      texts.push(String(node.text));
    }
    if (node.marks !== undefined) {
      assert.ok(Array.isArray(node.marks), 'marks must be an array');
      for (const raw of node.marks as unknown[]) {
        const mark = asObject(raw, 'mark');
        assert.equal(typeof mark.type, 'string');
        if (mark.type === 'link') {
          const href = asObject(mark.attrs, 'link attrs').href;
          assert.equal(typeof href, 'string');
          assert.ok(String(href).length > 0, 'a link mark with an empty href is invalid ADF');
          hrefs.push(String(href));
        }
      }
    }
  });

  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.ok((doc.content as unknown[]).length > 0);
  for (const required of ['heading', 'paragraph', 'bulletList', 'codeBlock', 'blockquote', 'rule']) {
    assert.ok(types.has(required), `the document should contain a ${required} node`);
  }
  assert.ok(
    hrefs.some((h) => h.includes('/pull/151')),
    'the revert PR link must become a link mark, not literal markdown',
  );

  const joined = texts.join('\n');
  assert.ok(!joined.includes('**'), 'bold markers must become strong marks');
  assert.ok(!joined.includes('## '), 'headings must become heading nodes');
  assert.ok(joined.includes('CheckoutValidator.country'), 'the failing frame must survive conversion');
});

test('a pull request with no URL yet becomes plain text, not an empty link', async () => {
  // buildTicketDescription emits `[#151]()` when the PR carries no URL, and a
  // link mark with an empty href is invalid ADF — Jira 400s the whole create.
  const description = buildTicketDescription({
    incident: INCIDENT,
    investigation: INVESTIGATION,
    revertPr: { ...REVERT_PR, url: '' },
    fixPr: null,
  });
  assert.ok(description.includes('[#151]()'), 'the fixture must actually exercise the empty-href case');

  await jiraClient().createIncidentTicket(ticketInput({ description }));
  const doc = asObject(fieldsOf(requestFor('POST', '/rest/api/3/issue')).description, 'description');

  let sawLabel = false;
  walkAdf(doc, (node) => {
    if (node.type === 'text' && node.text === '#151') {
      sawLabel = true;
      assert.equal(node.marks, undefined, 'a PR with no URL must carry no link mark at all');
    }
    for (const raw of (node.marks ?? []) as unknown[]) {
      const mark = asObject(raw, 'mark');
      if (mark.type === 'link') {
        assert.ok(String(asObject(mark.attrs, 'link attrs').href ?? '').length > 0, 'ADF rejects an empty href');
      }
    }
  });
  assert.ok(sawLabel, 'the PR number must survive as readable text');
});

test('markdown the converter does not understand degrades to paragraphs', async () => {
  const odd = [
    '<table><tr><td>not markdown</td></tr></table>',
    '',
    '| column | column |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '***',
    '',
    '1. a numbered item with an unclosed `backtick',
    '',
    'a snake_case_identifier must not be mangled',
  ].join('\n');

  await jiraClient().createIncidentTicket(ticketInput({ description: odd }));
  const doc = asObject(fieldsOf(requestFor('POST', '/rest/api/3/issue')).description, 'description');

  const texts: string[] = [];
  walkAdf(doc, (node) => {
    if (node.type === 'text') {
      assert.ok(String(node.text).length > 0);
      texts.push(String(node.text));
    }
  });
  assert.equal(doc.type, 'doc');
  assert.ok((doc.content as unknown[]).length > 0, 'unknown markdown must still produce a body');
  assert.ok(texts.join('\n').includes('snake_case_identifier'), 'snake_case must not be read as emphasis');
});
