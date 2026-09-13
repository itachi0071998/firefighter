/**
 * Credential preflight — "is my configuration actually going to work?"
 *
 * Every integration is probed with a single READ-ONLY call that authenticates
 * and reads back an identity. Nothing here creates a ticket, a branch, a pull
 * request or a Slack message, which is what makes it safe to run at any moment
 * — including in the middle of an incident. It is also why a Slack webhook is
 * reported but never exercised: the only way to "test" a webhook is to post
 * with it, and that would spam the channel.
 *
 * Nothing in here throws. A preflight that aborts on the first broken
 * credential is useless, because the operator needs all five verdicts at once
 * — most of all when several are wrong. A failure is a `CheckResult` with
 * `ok:false` carrying the precise cause and the fix.
 *
 * No credential may appear in a detail string: error bodies are echoed back by
 * the providers themselves, so every result is passed through `scrub()` on the
 * way out as well as being redacted at the point of use.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Config, config as defaultConfig } from '../config.ts';

const execFileAsync = promisify(execFile);

/** Per-check budget. One unreachable host must not stall the whole report. */
const TIMEOUT_MS = 10_000;

export interface CheckResult {
  /** 'github' | 'sentry' | 'slack' | 'jira' | 'linear' */
  name: string;
  /** Is this integration pointed at a real provider (rather than mocked)? */
  configured: boolean;
  /** Did the credential actually work? True for a deliberately mocked provider. */
  ok: boolean;
  /** Identity on success; on failure the precise cause followed by the fix. */
  detail: string;
  /** Granted scopes, when the provider discloses them (GitHub, Slack). */
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Token shapes that must never reach a terminal. Matched by shape rather than
 * by value, so a secret echoed back inside a provider's own error body — which
 * this module never had in hand — is caught too.
 */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /xox[a-z][-.][A-Za-z0-9.\-]{10,}/g,
  /sntry[a-z]_[A-Za-z0-9_.\-]{20,}/g,
  /lin_api_[A-Za-z0-9]{20,}/g,
  /ATATT[A-Za-z0-9_.\-=]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi,
]);

/** Strip anything token-shaped from arbitrary text. */
function scrub(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '***redacted***');
  return out;
}

/** Strip known literal secrets, then anything else that looks like one. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***redacted***');
  }
  return scrub(out);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

interface Probe {
  status: number;
  statusText: string;
  body: string;
  headers: Headers;
}

/** One HTTP call under its own abort timeout. Throws only on transport failure. */
async function probe(url: string, init: RequestInit = {}): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, statusText: res.statusText, body: await res.text(), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function asJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** Turn any thrown value into one readable, credential-free line. */
function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { message?: string; code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return `timed out after ${TIMEOUT_MS / 1000}s`;
  // `fetch` reports every transport problem as "fetch failed"; the useful part
  // (ENOTFOUND, ECONNREFUSED, certificate errors) is on the cause.
  const cause = e?.cause?.code ?? e?.cause?.message;
  const msg = e?.message ?? String(err);
  return scrub(cause ? `${msg} (${cause})` : msg);
}

/**
 * A short, single-line, credential-free excerpt of a response body.
 *
 * `secrets` is mandatory rather than optional on purpose. Shape matching alone
 * is not enough: a classic GitHub PAT is 40 hex characters and a legacy Sentry
 * auth token is 64, neither of which is distinguishable from an ordinary id.
 * Requiring the caller to hand over the credentials it is holding makes the
 * compiler, rather than reviewer discipline, the thing that stops a leak.
 */
function snippet(body: string, secrets: readonly string[], max = 160): string {
  const text = body.trim();
  if (!text) return '';
  // An HTML body means the URL did not reach an API at all; quoting the markup
  // tells the operator nothing useful.
  if (/^\s*<(?:!doctype|html)/i.test(text)) return 'an HTML page rather than JSON';
  // Redact before truncating, so a token near the cut cannot survive in part.
  const flat = redact(text.replace(/\s+/g, ' '), secrets);
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/** "HTTP 502 Bad Gateway", or "HTTP 502" when the server sent no reason phrase. */
function httpStatus(res: Probe): string {
  return res.statusText ? `HTTP ${res.status} ${res.statusText}` : `HTTP ${res.status}`;
}

function firstLine(text: string): string {
  // gh colours its output; the escape codes would corrupt the report.
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return scrub(clean.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '');
}

/** Split a comma-separated scope header/line into a clean list. */
function parseScopes(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return list.length ? list : undefined;
}

const ok = (name: string, detail: string, scopes?: string[]): CheckResult =>
  scopes ? { name, configured: true, ok: true, detail, scopes } : { name, configured: true, ok: true, detail };

const fail = (name: string, detail: string, scopes?: string[]): CheckResult =>
  scopes ? { name, configured: true, ok: false, detail, scopes } : { name, configured: true, ok: false, detail };

/** Mocked or unused: nothing to verify, so this is a pass, not a failure. */
const mocked = (name: string, detail: string): CheckResult => ({ name, configured: false, ok: true, detail });

/**
 * Credentials can be present before the provider is switched on — exactly the
 * state right after creating an API token. The credential is still verified,
 * because that is what a preflight is for, but `configured` must tell the
 * truth: this integration is not the active provider yet.
 */
function notYetActive(result: CheckResult, hint: string): CheckResult {
  const base = result.detail.replace(/\s*\.\s*$/, '');
  return { ...result, configured: false, detail: `${base} — ${hint}` };
}

/** Name the env vars that are still empty, so the fix is unambiguous. */
function missingVars(pairs: Record<string, string>): string[] {
  return Object.entries(pairs)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GhUser {
  login?: string;
}

interface GhRepo {
  full_name?: string;
  default_branch?: string;
  private?: boolean;
}

/** `gh api <path>` as a read-only probe. Never throws. */
async function ghApi<T>(apiPath: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', apiPath, '-H', 'Accept: application/vnd.github+json'], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, data: JSON.parse(stdout) as T };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const text = String(e.stderr ?? e.message ?? '');
    const status = /HTTP (\d{3})/.exec(text)?.[1];
    return { ok: false, error: status ? `HTTP ${status}` : firstLine(text) || 'gh api failed' };
  }
}

/** Confirm the configured repository is visible, given a working identity. */
async function githubRepoLine(slug: string, login: string, scopes?: string[]): Promise<CheckResult> {
  const repo = await ghApi<GhRepo>(`repos/${slug}`);
  if (!repo.ok) {
    return fail(
      'github',
      `authenticated as ${login}, but GITHUB_REPO=${slug} is not reachable (${repo.error}) — ` +
        `check the owner/name spelling and that this account can see the repository.`,
      scopes,
    );
  }
  const branch = repo.data.default_branch ?? '(unknown default branch)';
  return ok('github', `authenticated as ${login} · ${repo.data.full_name ?? slug} reachable, default branch ${branch}`, scopes);
}

async function checkGhCli(slug: string): Promise<CheckResult> {
  let report: string;
  try {
    // `gh auth status` writes its report to stderr on some versions and to
    // stdout on others, so both streams are considered. `--show-token` is
    // deliberately NOT passed: the report must stay credential-free.
    const r = await execFileAsync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: TIMEOUT_MS });
    report = `${r.stdout}\n${r.stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string | number };
    if (e.code === 'ENOENT') {
      return fail(
        'github',
        'the `gh` CLI is not installed — install it (brew install gh) and run `gh auth login`, ' +
          'or set GITHUB_PROVIDER=api with a GITHUB_TOKEN instead.',
      );
    }
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    return fail('github', `gh is not authenticated (${firstLine(out) || 'gh auth status failed'}) — run: gh auth login`);
  }
  const login = /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/.exec(report)?.[1] ?? null;
  const scopes = parseScopes(/Token scopes:\s*(.+)/.exec(report)?.[1]);
  return githubRepoLine(slug, login ?? 'an unrecognised account (gh auth status parsed no login)', scopes);
}

async function checkGitHubApi(cfg: Config, slug: string): Promise<CheckResult> {
  const token = cfg.github.token;
  if (!token) {
    return fail(
      'github',
      'GITHUB_PROVIDER=api but GITHUB_TOKEN is empty — create a fine-grained PAT with ' +
        'Contents: Read & Write, Pull requests: Read & Write, Metadata: Read.',
    );
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'firefighter-preflight',
  };
  let user: Probe;
  try {
    user = await probe('https://api.github.com/user', { headers });
  } catch (err) {
    return fail('github', `could not reach api.github.com: ${describe(err)}`);
  }
  if (user.status === 401) {
    return fail('github', 'GITHUB_TOKEN was rejected (401) — the token is expired, revoked or mistyped.');
  }
  if (user.status !== 200) {
    return fail('github', `GET /user returned ${httpStatus(user)}: ${snippet(user.body, [token])}`);
  }
  // Classic PATs disclose their scopes in a header; fine-grained PATs do not,
  // so an absent header is not a problem to report.
  const scopes = parseScopes(user.headers.get('x-oauth-scopes'));
  const login = asJson<GhUser>(user.body)?.login ?? 'unknown';

  let repo: Probe;
  try {
    repo = await probe(`https://api.github.com/repos/${slug}`, { headers });
  } catch (err) {
    return fail('github', `authenticated as ${login}, but could not reach the repository: ${describe(err)}`, scopes);
  }
  if (repo.status !== 200) {
    const hint =
      repo.status === 404
        ? 'check the owner/name spelling, and that the token grants this repository (a fine-grained PAT must list it).'
        : `${httpStatus(repo)}: ${snippet(repo.body, [token])}`;
    return fail('github', `authenticated as ${login}, but GITHUB_REPO=${slug} is not reachable — ${hint}`, scopes);
  }
  const info = asJson<GhRepo>(repo.body);
  return ok(
    'github',
    `authenticated as ${login} · ${info?.full_name ?? slug} reachable, default branch ${info?.default_branch ?? '(unknown)'}`,
    scopes,
  );
}

async function checkGitHub(cfg: Config): Promise<CheckResult> {
  const provider = cfg.github.provider;
  if (provider === 'mock') {
    return mocked(
      'github',
      'GITHUB_PROVIDER=mock — commits, branches and pull requests are emulated in-process against the local demo repo.',
    );
  }
  const slug = cfg.github.repo;
  if (!slug.includes('/')) {
    return fail('github', `GITHUB_PROVIDER=${provider} but GITHUB_REPO="${slug}" is not owner/name — set GITHUB_REPO=<owner>/<repo>.`);
  }
  return provider === 'gh-cli' ? checkGhCli(slug) : checkGitHubApi(cfg, slug);
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

interface SentryProject {
  slug?: string;
  name?: string;
  organization?: { slug?: string; name?: string };
}

/** Read back the configured project. Assumes the three env vars are present. */
async function probeSentryProject(cfg: Config): Promise<CheckResult> {
  const { sentryUrl, sentryOrg, sentryProject, sentryAuthToken } = cfg.incidents;
  const url = `${sentryUrl}/api/0/projects/${encodeURIComponent(sentryOrg)}/${encodeURIComponent(sentryProject)}/`;
  let res: Probe;
  try {
    res = await probe(url, {
      headers: { Authorization: `Bearer ${sentryAuthToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    return fail('sentry', `could not reach ${sentryUrl}: ${describe(err)} — check SENTRY_URL.`);
  }
  if (res.status === 401) {
    return fail(
      'sentry',
      'SENTRY_AUTH_TOKEN was rejected (401) — create an auth token with project:read, event:read and org:read ' +
        '(Settings → Auth Tokens). SENTRY_TOKEN is accepted as an alias for the same value.',
    );
  }
  if (res.status === 403) {
    return fail('sentry', 'the token authenticated but is missing read scopes (403) — it needs project:read, event:read and org:read.');
  }
  if (res.status === 404) {
    return fail(
      'sentry',
      `no project "${sentryOrg}/${sentryProject}" (404) — SENTRY_ORG and SENTRY_PROJECT must be the URL slugs ` +
        'from sentry.io/organizations/<org>/projects/<project>/, not the display names.',
    );
  }
  if (res.status !== 200) {
    return fail('sentry', `${httpStatus(res)} from ${sentryUrl}: ${snippet(res.body, [sentryAuthToken])}`);
  }
  const project = asJson<SentryProject>(res.body);
  if (!project?.slug) {
    return fail(
      'sentry',
      `the project endpoint returned ${snippet(res.body, [sentryAuthToken], 120) || 'an empty body'} — check SENTRY_URL points at a Sentry API.`,
    );
  }
  const org = project.organization?.slug ?? sentryOrg;
  const named = project.name && project.name !== project.slug ? ` ("${project.name}")` : '';
  return ok('sentry', `project ${org}/${project.slug} readable${named}`);
}

async function checkSentry(cfg: Config): Promise<CheckResult> {
  const { sentryOrg, sentryProject, sentryAuthToken, source } = cfg.incidents;
  const active = source === 'sentry';
  const missing = missingVars({
    SENTRY_AUTH_TOKEN: sentryAuthToken,
    SENTRY_ORG: sentryOrg,
    SENTRY_PROJECT: sentryProject,
  });
  if (missing.length) {
    if (!active) {
      return mocked('sentry', 'INCIDENT_SOURCE=fixture — incidents come from the built-in fixtures; Sentry is never contacted.');
    }
    return fail(
      'sentry',
      `INCIDENT_SOURCE=sentry but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty — ` +
        'see SETUP.md § Sentry. Firefighter falls back to the built-in fixtures until they are set.',
    );
  }
  const result = await probeSentryProject(cfg);
  return active
    ? result
    : notYetActive(result, 'INCIDENT_SOURCE is not "sentry", so live issues are not used yet; set INCIDENT_SOURCE=sentry.');
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

interface SlackAuthTest {
  ok?: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  error?: string;
}

/** Slack error codes worth explaining rather than echoing. */
const SLACK_ERRORS: Record<string, string> = {
  not_authed: 'no token was sent — SLACK_BOT_TOKEN is empty or malformed.',
  invalid_auth: 'the token is not valid for this workspace — re-copy the Bot User OAuth Token from OAuth & Permissions.',
  token_revoked: 'the token has been revoked — reinstall the app to the workspace and copy the new token.',
  token_expired: 'the token has expired — reinstall the app to the workspace and copy the new token.',
  account_inactive: 'the app or workspace account is deactivated.',
  missing_scope: 'the token is missing a required scope — add chat:write under OAuth & Permissions → Bot Token Scopes and reinstall.',
};

/** The xoxe trap: an app-configuration token authenticates but can never post. */
function slackTokenShapeHint(token: string): string {
  if (token.startsWith('xoxb-')) return '';
  if (token.startsWith('xoxe')) {
    return ' The token starts with "xoxe", which is an app-configuration token, NOT a bot token: it can edit the app manifest but can never post a message. Copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions instead.';
  }
  if (token.startsWith('xoxp-')) {
    return ' The token starts with "xoxp-", which is a user token, not a bot token. Copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions.';
  }
  return ' Expected a Bot User OAuth Token beginning "xoxb-".';
}

async function checkSlackBot(cfg: Config): Promise<CheckResult> {
  const token = cfg.slack.botToken;
  if (!token) {
    return fail(
      'slack',
      'SLACK_PROVIDER=bot but SLACK_BOT_TOKEN is empty — paste the Bot User OAuth Token (xoxb-…) from OAuth & Permissions.',
    );
  }
  let res: Probe;
  try {
    // auth.test is a POST by Slack's convention but creates nothing: it only
    // reports who the token belongs to.
    res = await probe('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
    });
  } catch (err) {
    return fail('slack', `could not reach slack.com: ${describe(err)}`);
  }
  const scopes = parseScopes(res.headers.get('x-oauth-scopes'));
  if (res.status !== 200) {
    return fail('slack', redact(`auth.test returned ${httpStatus(res)}: ${snippet(res.body, [token])}`, [token]), scopes);
  }
  const auth = asJson<SlackAuthTest>(res.body);
  if (!auth) {
    return fail('slack', `auth.test returned a non-JSON body: ${snippet(res.body, [token], 120)}`, scopes);
  }
  if (!auth.ok) {
    const code = auth.error ?? 'unknown';
    const explained = SLACK_ERRORS[code] ?? `Slack reported "${code}".`;
    return fail('slack', `auth.test failed: ${explained}${slackTokenShapeHint(token)}`, scopes);
  }

  const who = `${auth.user ?? 'unknown'} in ${auth.team ?? 'unknown workspace'}`;
  // The exact failure the operator already hit once: a token that authenticates
  // perfectly and then fails at post time with missing_scope.
  if (scopes && !scopes.includes('chat:write')) {
    return fail(
      'slack',
      `authenticated as ${who}, but the token is MISSING the chat:write bot scope, so posting will fail with missing_scope. ` +
        `Add chat:write under OAuth & Permissions → Bot Token Scopes, then reinstall the app to the workspace and copy the new token.` +
        slackTokenShapeHint(token),
      scopes,
    );
  }
  const scopeNote = scopes
    ? ''
    : ' (Slack disclosed no scope header; if posting fails with missing_scope, add chat:write under OAuth & Permissions and reinstall.)';
  return ok(
    'slack',
    `authenticated as ${who} · posting to ${cfg.slack.channel} — the bot must be a member, invite it with /invite @${auth.user ?? 'YourApp'}.${scopeNote}`,
    scopes,
  );
}

async function checkSlack(cfg: Config): Promise<CheckResult> {
  const provider = cfg.slack.provider;
  if (provider === 'mock') {
    return mocked('slack', 'SLACK_PROVIDER=mock — the Block Kit payload is rendered into the dashboard and data/slack-outbox/ instead of being posted.');
  }
  if (provider === 'bridge') {
    // No Slack credential is involved, so there is nothing to verify — the same
    // verdict TICKET_PROVIDER=bridge already gets.
    return mocked('slack', 'SLACK_PROVIDER=bridge — messages are queued as bridge intents for an external connector; no Slack credential is used here.');
  }
  if (provider === 'webhook') {
    const raw = cfg.slack.webhookUrl;
    if (!raw) {
      return fail('slack', 'SLACK_PROVIDER=webhook but SLACK_WEBHOOK_URL is empty — create an Incoming Webhook under the app\'s Incoming Webhooks page.');
    }
    let host: string;
    try {
      host = new URL(raw).host;
    } catch {
      return fail('slack', 'SLACK_WEBHOOK_URL is not a valid URL — it should look like https://hooks.slack.com/services/T…/B…/…');
    }
    // Deliberately not verified: the only way to exercise a webhook is to post
    // with it, which would put a message in a real channel.
    return ok(
      'slack',
      `webhook configured on ${host} — not verified, because the only way to test a webhook is to post with it. ` +
        'A webhook is locked to the channel chosen when it was created, so SLACK_CHANNEL is ignored.',
    );
  }
  return checkSlackBot(cfg);
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

interface JiraMyself {
  displayName?: string;
  accountId?: string;
  accountType?: string;
}

interface JiraProject {
  key?: string;
  name?: string;
  projectTypeKey?: string;
}

/** Read back the identity and the project. Assumes the credentials are present. */
async function probeJira(cfg: Config): Promise<CheckResult> {
  const { jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey } = cfg.tickets;
  const base = jiraBaseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return fail('jira', `JIRA_BASE_URL="${base}" must include the scheme and be the site root, e.g. https://your-org.atlassian.net`);
  }
  const basic = Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString('base64');
  const secrets = [jiraApiToken, basic];
  const headers = { Authorization: `Basic ${basic}`, Accept: 'application/json' };

  let me: Probe;
  try {
    me = await probe(`${base}/rest/api/3/myself`, { headers });
  } catch (err) {
    return fail('jira', `could not reach ${base}: ${describe(err)} — check JIRA_BASE_URL.`);
  }
  if (me.status === 401) {
    return fail(
      'jira',
      'Jira rejected the credentials (401) — JIRA_EMAIL must be the Atlassian account that created the token, and ' +
        'JIRA_API_TOKEN must be a current token from id.atlassian.com/manage-profile/security/api-tokens.',
    );
  }
  if (me.status === 403) {
    return fail('jira', 'Jira accepted the token but refused the request (403) — the account may be blocked or require re-consent in the Atlassian site.');
  }
  if (me.status !== 200) {
    return fail('jira', redact(`GET /rest/api/3/myself returned ${httpStatus(me)}: ${snippet(me.body, secrets)}`, secrets));
  }
  const who = asJson<JiraMyself>(me.body);
  if (!who?.displayName) {
    return fail(
      'jira',
      `/rest/api/3/myself returned ${snippet(me.body, secrets, 120) || 'an empty body'} — JIRA_BASE_URL should be the bare site root ` +
        '(https://your-org.atlassian.net), with no /jira or /browse path.',
    );
  }

  let proj: Probe;
  try {
    proj = await probe(`${base}/rest/api/3/project/${encodeURIComponent(jiraProjectKey)}`, { headers });
  } catch (err) {
    return fail('jira', `authenticated as ${who.displayName}, but the project lookup failed: ${describe(err)}`);
  }
  if (proj.status === 404) {
    return fail(
      'jira',
      `authenticated as ${who.displayName}, but project "${jiraProjectKey}" was not found (404) — JIRA_PROJECT_KEY is the short ` +
        'key that prefixes issue ids (INC-12 → INC), and the account needs Browse Projects on it.',
    );
  }
  if (proj.status === 403) {
    return fail(
      'jira',
      `authenticated as ${who.displayName}, but project "${jiraProjectKey}" is not visible to this account (403) — ` +
        'grant it Browse Projects and Create Issues on that project.',
    );
  }
  if (proj.status !== 200) {
    return fail(
      'jira',
      redact(`authenticated as ${who.displayName}, but the project lookup returned ${httpStatus(proj)}: ${snippet(proj.body, secrets)}`, secrets),
    );
  }
  const project = asJson<JiraProject>(proj.body);
  const named = project?.name ? ` ("${project.name}")` : '';
  // Creating an issue is the only way to prove the Create Issues permission,
  // and a preflight must not create anything, so it is named rather than tested.
  return ok(
    'jira',
    `authenticated as ${who.displayName} · project ${project?.key ?? jiraProjectKey}${named} is visible ` +
      '(Create Issues on that project is also required at ticket time and cannot be verified read-only)',
  );
}

async function checkJira(cfg: Config): Promise<CheckResult> {
  const { provider, jiraBaseUrl, jiraEmail, jiraApiToken } = cfg.tickets;
  const active = provider === 'jira';
  const missing = missingVars({ JIRA_BASE_URL: jiraBaseUrl, JIRA_EMAIL: jiraEmail, JIRA_API_TOKEN: jiraApiToken });

  if (missing.length) {
    if (active) {
      return fail(
        'jira',
        `TICKET_PROVIDER=jira but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty — see SETUP.md § Jira. ` +
          'Firefighter writes mock tickets to data/tickets.json until they are set.',
      );
    }
    if (provider === 'bridge') {
      return mocked('jira', 'TICKET_PROVIDER=bridge — tickets are queued as bridge intents for an external connector.');
    }
    if (provider === 'linear') {
      return mocked('jira', 'TICKET_PROVIDER=linear — Jira is not in use.');
    }
    return mocked('jira', 'TICKET_PROVIDER=mock — incident tickets are written to data/tickets.json instead of Jira.');
  }
  // Credentials are present: verify them even when the provider is not switched
  // over yet, which is exactly the state right after creating the API token.
  const result = await probeJira(cfg);
  return active
    ? result
    : notYetActive(result, `TICKET_PROVIDER=${provider}, so tickets are still mocked; set TICKET_PROVIDER=jira to use it.`);
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

interface LinearViewer {
  data?: { viewer?: { name?: string } };
  errors?: { message?: string }[];
}

async function checkLinear(cfg: Config): Promise<CheckResult> {
  const { provider, linearApiKey, linearTeamKey } = cfg.tickets;
  const active = provider === 'linear';
  if (!linearApiKey) {
    if (active) {
      return fail('linear', 'TICKET_PROVIDER=linear but LINEAR_API_KEY is empty — create a personal API key in Linear under Settings → API.');
    }
    return mocked('linear', `TICKET_PROVIDER=${provider} — Linear is not in use.`);
  }

  const result = await probeLinear(linearApiKey, linearTeamKey);
  return active
    ? result
    : notYetActive(result, `TICKET_PROVIDER=${provider}, so tickets are still mocked; set TICKET_PROVIDER=linear to use it.`);
}

/** Read back the viewer identity. Assumes LINEAR_API_KEY is present. */
async function probeLinear(linearApiKey: string, linearTeamKey: string): Promise<CheckResult> {
  let res: Probe;
  try {
    // A GraphQL query is a POST by protocol, but `viewer` only reads identity.
    res = await probe('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: linearApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: '{ viewer { name } }' }),
    });
  } catch (err) {
    return fail('linear', `could not reach api.linear.app: ${describe(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    return fail('linear', `Linear rejected the credentials (HTTP ${res.status}) — check LINEAR_API_KEY (it looks like lin_api_…).`);
  }
  if (res.status !== 200) {
    return fail('linear', redact(`Linear returned ${httpStatus(res)}: ${snippet(res.body, [linearApiKey])}`, [linearApiKey]));
  }
  const parsed = asJson<LinearViewer>(res.body);
  if (parsed?.errors?.length) {
    return fail('linear', redact(`Linear API error: ${parsed.errors.map((e) => e.message ?? 'unknown').join('; ')}`, [linearApiKey]));
  }
  const name = parsed?.data?.viewer?.name;
  if (!name) {
    return fail('linear', `the viewer query returned no identity: ${snippet(res.body, [linearApiKey], 120) || 'empty body'}`);
  }
  return ok('linear', `authenticated as ${name} · team key ${linearTeamKey}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one check, converting anything it throws into a reportable failure. */
async function guarded(name: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    // A check is configured enough to have been attempted, so an unexpected
    // throw is a configuration answer — not a reason to abort the report.
    return { name, configured: true, ok: false, detail: `check failed unexpectedly: ${describe(err)}` };
  }
}

/**
 * Probe every integration once, in parallel, with a single read-only call each.
 *
 * @param cfg configuration to check; defaults to the process-wide config.
 * @returns one result per integration — github, sentry, slack, jira, linear —
 *          always in that order. Never throws and never prints a credential.
 */
export async function preflight(cfg: Config = defaultConfig): Promise<CheckResult[]> {
  const results = await Promise.all([
    guarded('github', () => checkGitHub(cfg)),
    guarded('sentry', () => checkSentry(cfg)),
    guarded('slack', () => checkSlack(cfg)),
    guarded('jira', () => checkJira(cfg)),
    guarded('linear', () => checkLinear(cfg)),
  ]);
  // Belt and braces: whatever a provider chose to echo back in an error body,
  // nothing token-shaped leaves this module.
  return results.map((r) => ({ ...r, detail: scrub(r.detail) }));
}
