import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Minimal .env loader (no dependency). Does not override real env vars. */
function loadDotEnv(): void {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const quoted =
      (val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
      (val.startsWith("'") && val.endsWith("'") && val.length > 1);
    if (quoted) {
      val = val.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment: "PROVIDER=bot   # use webhook instead"
      // must yield "bot", not the whole line. Without this a commented line
      // silently configures a provider with a nonsense value.
      const hash = val.search(/(^|\s)#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== '' ? v : d;
};

export type GithubProvider = 'mock' | 'gh-cli' | 'api';
export type SlackProvider = 'mock' | 'webhook' | 'bot' | 'bridge';
export type TicketProvider = 'mock' | 'linear' | 'jira' | 'bridge';
export type LlmProvider = 'deterministic' | 'openai' | 'anthropic';
export type IncidentSourceName = 'fixture' | 'sentry';

/**
 * How far Firefighter goes.
 *
 *   'mitigate' - stop after the revert PR (default). The revert is a PROVEN,
 *                mechanical action: bisection established which change caused
 *                the fault, and reverting it is deterministic.
 *   'full'     - also synthesise a fix and a regression test, opened as a DRAFT
 *                pull request. The patch encodes a guess about intent, so it is
 *                explicitly not presented as ready to merge.
 */
export type RunMode = 'mitigate' | 'full';

export interface Config {
  port: number;
  dbPath: string;
  demoRepoPath: string;
  dataDir: string;
  github: { provider: GithubProvider; token: string; repo: string; baseBranch: string };
  slack: { provider: SlackProvider; webhookUrl: string; botToken: string; channel: string };
  tickets: {
    provider: TicketProvider;
    linearApiKey: string;
    linearTeamKey: string;
    jiraBaseUrl: string;
    jiraEmail: string;
    jiraApiToken: string;
    jiraProjectKey: string;
  };
  llm: {
    provider: LlmProvider;
    openaiApiKey: string;
    openaiModel: string;
    anthropicApiKey: string;
    anthropicModel: string;
  };
  incidents: {
    source: IncidentSourceName;
    sentryUrl: string;
    sentryOrg: string;
    sentryProject: string;
    sentryAuthToken: string;
    /** Pin one Sentry issue so the demo is reproducible. Empty = latest. */
    sentryIssueId: string;
  };
  mode: RunMode;
  maxAttempts: number;
  retryBaseMs: number;
  /** e.g. "notify_slack:transient,create_fix_pr:crash" */
  failInject: string;
}

function resolveFrom(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dbPath = resolveFrom(ROOT, env('FF_DB_PATH', './data/firefighter.db'));
  const cfg: Config = {
    port: num('PORT', 8787),
    dbPath,
    dataDir: path.dirname(dbPath),
    demoRepoPath: resolveFrom(ROOT, env('FF_DEMO_REPO', './demo-repo')),
    github: {
      provider: (env('GITHUB_PROVIDER', 'mock') as GithubProvider) || 'mock',
      token: env('GITHUB_TOKEN'),
      repo: env('GITHUB_REPO', 'firefighter-demo/checkout-service'),
      baseBranch: env('GITHUB_BASE_BRANCH', 'main'),
    },
    slack: {
      provider: (env('SLACK_PROVIDER', 'mock') as SlackProvider) || 'mock',
      webhookUrl: env('SLACK_WEBHOOK_URL'),
      botToken: env('SLACK_BOT_TOKEN'),
      channel: env('SLACK_CHANNEL', '#incidents'),
    },
    tickets: {
      provider: (env('TICKET_PROVIDER', 'mock') as TicketProvider) || 'mock',
      linearApiKey: env('LINEAR_API_KEY'),
      linearTeamKey: env('LINEAR_TEAM_KEY', 'ENG'),
      jiraBaseUrl: env('JIRA_BASE_URL'),
      jiraEmail: env('JIRA_EMAIL'),
      jiraApiToken: env('JIRA_API_TOKEN'),
      jiraProjectKey: env('JIRA_PROJECT_KEY', 'INC'),
    },
    llm: {
      provider: (env('LLM_PROVIDER', 'deterministic') as LlmProvider) || 'deterministic',
      openaiApiKey: env('OPENAI_API_KEY'),
      openaiModel: env('OPENAI_MODEL', 'gpt-4o'),
      anthropicApiKey: env('ANTHROPIC_API_KEY'),
      anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    },
    incidents: {
      source: (env('INCIDENT_SOURCE', 'fixture') as IncidentSourceName) || 'fixture',
      sentryUrl: (env('SENTRY_URL', 'https://sentry.io') || 'https://sentry.io').replace(/\/+$/, ''),
      sentryOrg: env('SENTRY_ORG'),
      sentryProject: env('SENTRY_PROJECT'),
      // SENTRY_TOKEN is accepted as an alias: it is what `sentry-cli` and the
      // Sentry UI call the value, and getting this wrong silently disables the
      // integration.
      sentryAuthToken: env('SENTRY_AUTH_TOKEN') || env('SENTRY_TOKEN'),
      sentryIssueId: env('SENTRY_ISSUE_ID'),
    },
    mode: (env('FF_MODE', 'mitigate') === 'full' ? 'full' : 'mitigate') as RunMode,
    maxAttempts: num('FF_MAX_ATTEMPTS', 3),
    retryBaseMs: num('FF_RETRY_BASE_MS', 150),
    failInject: env('FF_FAIL_INJECT'),
  };
  return { ...cfg, ...overrides };
}

/**
 * Degrade gracefully: if a provider is set to a real backend but its
 * credentials are missing, fall back to the mock adapter and say so.
 */
export function effectiveProviders(cfg: Config): {
  github: GithubProvider;
  slack: SlackProvider;
  tickets: TicketProvider;
  llm: LlmProvider;
  incidents: IncidentSourceName;
  notes: string[];
} {
  const notes: string[] = [];
  let github = cfg.github.provider;
  if (github === 'api' && !cfg.github.token) {
    notes.push('GITHUB_PROVIDER=api but GITHUB_TOKEN is empty -> using mock');
    github = 'mock';
  }
  if ((github === 'gh-cli' || github === 'api') && !cfg.github.repo.includes('/')) {
    notes.push(`GITHUB_PROVIDER=${github} but GITHUB_REPO is not set to owner/name -> using mock`);
    github = 'mock';
  }
  let slack = cfg.slack.provider;
  if (slack === 'webhook' && !cfg.slack.webhookUrl) {
    notes.push('SLACK_PROVIDER=webhook but SLACK_WEBHOOK_URL is empty -> using mock');
    slack = 'mock';
  }
  if (slack === 'bot' && !cfg.slack.botToken) {
    notes.push('SLACK_PROVIDER=bot but SLACK_BOT_TOKEN is empty -> using mock');
    slack = 'mock';
  }
  let tickets = cfg.tickets.provider;
  if (tickets === 'linear' && !cfg.tickets.linearApiKey) {
    notes.push('TICKET_PROVIDER=linear but LINEAR_API_KEY is empty -> using mock');
    tickets = 'mock';
  }
  if (tickets === 'jira' && !(cfg.tickets.jiraBaseUrl && cfg.tickets.jiraApiToken)) {
    notes.push('TICKET_PROVIDER=jira but Jira credentials are incomplete -> using mock');
    tickets = 'mock';
  }
  let llm = cfg.llm.provider;
  if (llm === 'openai' && !cfg.llm.openaiApiKey) {
    notes.push('LLM_PROVIDER=openai but OPENAI_API_KEY is empty -> using deterministic analyzer');
    llm = 'deterministic';
  }
  if (llm === 'anthropic' && !cfg.llm.anthropicApiKey) {
    notes.push('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty -> using deterministic analyzer');
    llm = 'deterministic';
  }
  let incidents = cfg.incidents.source;
  if (
    incidents === 'sentry' &&
    !(cfg.incidents.sentryAuthToken && cfg.incidents.sentryOrg && cfg.incidents.sentryProject)
  ) {
    notes.push(
      'INCIDENT_SOURCE=sentry but SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT are incomplete -> using built-in fixtures',
    );
    incidents = 'fixture';
  }
  return { github, slack, tickets, llm, incidents, notes };
}

export const config = loadConfig();
