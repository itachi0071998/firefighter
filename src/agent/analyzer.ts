/**
 * Root-cause analyzer: the reasoning core that names the culprit change.
 *
 * The scoring here is a deliberately boring weighted sum of five positive
 * signals plus explicit negative (exculpatory) evidence. Boring is the point:
 * "blame the most recent deploy" is the intuition this module exists to beat,
 * and a transparent score is the only kind an on-call engineer can argue with
 * at 3am. Every number that lands in a SuspectScore is reproducible from the
 * CollectedContext alone — no clock reads, no randomness, no model in the loop.
 *
 * An LLM may review the result (see {@link analyzeWithLlm}) but can only ever
 * adjust prose and nudge confidence; it cannot invent a suspect, and anything
 * it returns that fails validation is discarded in favour of the deterministic
 * answer.
 */
import type {
  ChangedFile,
  CollectedContext,
  Deployment,
  Evidence,
  Incident,
  Investigation,
  LlmClient,
  LlmMessage,
  StackFrame,
  SuspectScore,
} from '../types.ts';
import { logger } from '../util/log.ts';
import { normalizePath, parseStackTrace, topAppFrame } from './stacktrace.ts';

const log = logger('analyzer');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Below this confidence the agent refuses to nominate a revert candidate. */
export const CONFIDENCE_FLOOR = 0.45;

/** Weight of each positive signal class. Sums to 1.0. */
export const SIGNAL_WEIGHTS = {
  temporal: 0.3,
  stack_trace: 0.38,
  symbol: 0.2,
  keyword: 0.07,
  blast_radius: 0.05,
} as const;

/** A deploy this recent before detection is a perfect temporal match. */
const TEMPORAL_FULL_CREDIT_MIN = 15;
/** Past this age a deploy carries no temporal signal at all. */
const TEMPORAL_ZERO_MIN = 72 * 60;
/**
 * How fast temporal credit decays past the full-credit window.
 *
 * Linear decay over 72h is far too flat: it scores a change deployed seven
 * hours before an incident almost as highly as one deployed twelve minutes
 * before, which is how a repository's bootstrap commit can out-rank the change
 * that actually broke production. Incidents overwhelmingly follow closely
 * behind the deploy that caused them, so credit halves roughly every 90
 * minutes instead.
 */
const TEMPORAL_HALF_LIFE_MIN = 90;

/** Symbol credit retained when the change merely INTRODUCED the matching file. */
const NEW_FILE_SYMBOL_DAMPING = 0.35;
/** A change older than this is "stale" once a better-matching candidate exists. */
const STALE_HOURS = 24;

/** Exculpatory penalties, before the cap below is applied. */
const PENALTY = {
  docsOnly: 0.16,
  noStackFile: 0.11,
  deployedAfterIncident: 0.35,
  staleWithBetterCandidate: 0.08,
  /**
   * A change with no production deployment record cannot have caused a
   * production incident. This matters for a repository's bootstrap commit,
   * which touches every file and therefore matches the stack trace strongly
   * on pure text overlap while never having shipped on its own.
   */
  neverDeployed: 0.3,
} as const;

/** Total exculpatory evidence can never subtract more than this. */
const EXCULPATORY_CAP = 0.35;

/** Per-PR excerpt budget handed to the LLM reviewer. */
const LLM_MAX_EXCERPT_LINES = 12;
const LLM_MAX_EXCERPT_CHARS = 160;
const LLM_MAX_CANDIDATES = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything the analyzer needs: the alert, and what the collector gathered. */
export interface AnalyzeInput {
  incident: Incident;
  context: CollectedContext;
}

/** Shape the LLM reviewer is asked to return. Every field is validated. */
export interface LlmAnalysisReview {
  suspectPrNumber: number | null;
  confidence: number;
  rootCause: string;
  affectedFunctionality: string;
  permanentFix: string;
  narrative: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp to epoch ms, or null when absent/unparsable. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Round to 4dp so serialized investigations are byte-stable across runs. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function fixed2(n: number): string {
  return n.toFixed(2);
}

/** "3m", "17h28m", "1d21h58m" — compact enough for a narrative line. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function baseOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// File classification (blast radius + which added lines can carry identifiers)
// ---------------------------------------------------------------------------

/** Documentation, not executable code. */
function isDocFile(path: string): boolean {
  return (
    /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(path) ||
    /(^|\/)(docs?|documentation)\//i.test(path) ||
    /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODEOWNERS|NOTICE)[^/]*$/i.test(path)
  );
}

/** Test/spec code: it ships, but it does not run in production. */
function isTestFile(path: string): boolean {
  return (
    /(^|\/)(test|tests|spec|specs|__tests__|__mocks__|e2e|fixtures)\//i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
  );
}

/** Build/config/lockfiles: risky in their own way, but not the running code. */
function isConfigFile(path: string): boolean {
  const base = baseOf(path);
  return (
    /^(package(-lock)?\.json|tsconfig[^/]*\.json|jsconfig\.json|Dockerfile[^/]*|docker-compose\.ya?ml|Makefile|Procfile|\.gitignore|\.npmrc|\.nvmrc|\.editorconfig|\.eslintrc[^/]*|\.prettierrc[^/]*|yarn\.lock|pnpm-lock\.yaml)$/i.test(
      base,
    ) ||
    /\.(ya?ml|toml|ini|cfg|conf|lock|env)$/i.test(base) ||
    /(^|\/)\.github\//i.test(path)
  );
}

/** True for files that actually execute in production. */
function isRuntimeSource(path: string): boolean {
  return !isDocFile(path) && !isTestFile(path) && !isConfigFile(path);
}

// ---------------------------------------------------------------------------
// Tokenisation (keyword signal)
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'was', 'were', 'not', 'are',
  'but', 'all', 'can', 'its', 'via', 'per', 'you', 'our', 'use', 'add', 'get', 'set', 'new', 'old',
  'fix', 'chore', 'feat', 'docs', 'refactor', 'test', 'tests', 'error', 'errors', 'exception',
  'cannot', 'read', 'reading', 'properties', 'property', 'undefined', 'null', 'object', 'type',
  'types', 'typeerror', 'failed', 'failure', 'failing', 'request', 'requests', 'service',
  'services', 'server', 'production', 'prod', 'src', 'lib', 'index', 'main', 'app', 'api',
  'incident', 'alert', 'issue', 'bug', 'http', 'https', 'json', 'file', 'files', 'line', 'lines',
  'code', 'call', 'calls', 'when', 'where', 'into', 'over', 'more', 'some', 'any', 'now',
]);

/**
 * Lowercase word tokens, splitting camelCase and every non-alphanumeric run,
 * with stopwords and pure numbers dropped.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  prNumber: number | null;
  sha: string;
  title: string;
  author: string;
  url: string;
  mergedAt: string | null;
  files: ChangedFile[];
  deployedAt: string | null;
  deployment: Deployment | null;
  deployedAfterIncident: boolean;
}

/** Human label for a candidate, used everywhere a suspect is named. */
function candidateLabel(c: Pick<Candidate, 'prNumber' | 'sha'>): string {
  return c.prNumber !== null ? `PR #${c.prNumber}` : `commit ${c.sha.slice(0, 7)}`;
}

/**
 * Pick the production deployment that first exposed a change: the latest
 * successful deploy at or before detection, else the earliest deploy after it
 * (which is itself exculpatory).
 */
function findDeployment(
  deployments: Deployment[],
  prNumber: number | null,
  shas: string[],
  detectedMs: number | null,
): Deployment | null {
  const shaSet = new Set(shas.filter(Boolean));
  const mine = deployments.filter((d) => {
    if (d.status !== 'success') return false;
    if (prNumber !== null && d.prNumber === prNumber) return true;
    return d.sha ? shaSet.has(d.sha) : false;
  });
  if (mine.length === 0) return null;

  const production = mine.filter((d) => /^(production|prod|live)$/i.test(d.environment));
  const pool = production.length > 0 ? production : mine;

  const sorted = [...pool].sort((a, b) => (toMs(a.deployedAt) ?? 0) - (toMs(b.deployedAt) ?? 0));
  if (detectedMs === null) return sorted[sorted.length - 1];

  const before = sorted.filter((d) => (toMs(d.deployedAt) ?? 0) <= detectedMs);
  return before.length > 0 ? before[before.length - 1] : sorted[0];
}

/**
 * Build the candidate set: every merged pull request in the collected context.
 * When the context carries no merged PRs (a repo that ships straight to main)
 * the analyzer degrades to scoring raw commits instead of giving up.
 */
function buildCandidates(context: CollectedContext, detectedMs: number | null): Candidate[] {
  const merged = context.pullRequests.filter((pr) => pr.state === 'merged');
  if (merged.length > 0) {
    return merged.map((pr) => {
      const deployment = findDeployment(
        context.deployments,
        pr.number,
        [pr.mergeCommitSha ?? '', pr.headSha],
        detectedMs,
      );
      const deployedAt = deployment?.deployedAt ?? null;
      const deployedMs = toMs(deployedAt);
      return {
        prNumber: pr.number,
        sha: pr.mergeCommitSha ?? pr.headSha,
        title: pr.title,
        author: pr.author,
        url: pr.url,
        mergedAt: pr.mergedAt,
        files: pr.files,
        deployedAt,
        deployment,
        deployedAfterIncident:
          deployedMs !== null && detectedMs !== null && deployedMs > detectedMs,
      };
    });
  }

  return context.commits.map((commit) => {
    const deployment = findDeployment(context.deployments, commit.prNumber, [commit.sha], detectedMs);
    const deployedAt = deployment?.deployedAt ?? null;
    const deployedMs = toMs(deployedAt);
    const files: ChangedFile[] = commit.files.map((path) => ({
      path,
      status: 'modified',
      additions: 0,
      deletions: 0,
      patch: '',
      addedLines: [],
    }));
    return {
      prNumber: commit.prNumber,
      sha: commit.sha,
      title: commit.message.split('\n')[0],
      author: commit.author,
      url: '',
      mergedAt: commit.authoredAt,
      files,
      deployedAt,
      deployment,
      deployedAfterIncident: deployedMs !== null && detectedMs !== null && deployedMs > detectedMs,
    };
  });
}

// ---------------------------------------------------------------------------
// Stack-derived facts, computed once per investigation
// ---------------------------------------------------------------------------

interface FrameSymbol {
  /** Method or function name, e.g. "country". */
  method: string;
  /** Owning class when the frame was `Class.method`, else null. */
  cls: string | null;
  /** 0 for the innermost application frame. */
  depth: number;
}

interface StackFacts {
  frames: StackFrame[];
  appFrames: StackFrame[];
  topFrame: StackFrame | null;
  /** Normalised paths of every application frame in the stack. */
  files: string[];
  /** Directories those files live in. */
  dirs: string[];
  symbols: FrameSymbol[];
}

/** Symbol names too generic to count as evidence of anything. */
const NOISE_SYMBOLS: ReadonlySet<string> = new Set([
  'anonymous', 'object', 'module', 'exports', 'default', 'constructor', 'promise', 'process',
  'array', 'function', 'eval', 'next', 'then', 'done', 'main', 'run', 'init', 'handler', 'handle',
  'callback', 'emit', 'on', 'get', 'set', 'map', 'has', 'add',
]);

/** Split "CheckoutValidator.country" into its class and method parts. */
function frameSymbol(frame: StackFrame, depth: number): FrameSymbol | null {
  const raw = (frame.fn ?? '').trim();
  if (!raw || raw.includes('<anonymous>')) return null;
  const parts = raw.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const method = parts[parts.length - 1];
  if (!method || method.length < 3) return null;
  if (NOISE_SYMBOLS.has(method.toLowerCase())) return null;
  let cls: string | null = null;
  if (parts.length > 1) {
    const owner = parts[parts.length - 2];
    if (owner && /^[A-Z]/.test(owner) && !NOISE_SYMBOLS.has(owner.toLowerCase())) cls = owner;
  }
  return { method, cls, depth };
}

/**
 * Resolve the stack trace once: frames, the failing application frame, the set
 * of files and directories it touches, and the symbols worth matching against a
 * diff.
 */
function analyzeStack(incident: Incident, context: CollectedContext): StackFacts {
  const frames = parseStackTrace(incident.stackTrace);
  const repoFiles = new Set<string>();
  for (const pr of context.pullRequests) for (const f of pr.files) repoFiles.add(normalizePath(f.path));
  for (const commit of context.commits) for (const f of commit.files) repoFiles.add(normalizePath(f));
  for (const match of context.codeMatches) repoFiles.add(normalizePath(match.path));

  const topFrame =
    context.failingFrame ?? topAppFrame(frames, repoFiles.size > 0 ? [...repoFiles] : undefined);

  const appFrames = frames.filter((f) => {
    const file = normalizePath(f.file);
    return Boolean(file) && !file.startsWith('node:') && !/^internal\//.test(file) && !/(^|\/)node_modules\//.test(file);
  });

  const files = [...new Set(appFrames.map((f) => normalizePath(f.file)).filter(Boolean))];
  const dirs = [...new Set(files.map(dirOf).filter(Boolean))];
  const symbols: FrameSymbol[] = [];
  appFrames.forEach((frame, depth) => {
    const sym = frameSymbol(frame, depth);
    if (sym) symbols.push(sym);
  });

  return { frames, appFrames, topFrame, files, dirs, symbols };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface SignalResult {
  score: number;
  description: string;
  detail?: string;
}

/**
 * temporal — how well the change's production deploy lines up with onset.
 * Full credit inside 15 minutes, decaying linearly to zero at 72 hours; a
 * deploy after detection, or no deploy at all, scores nothing.
 */
function scoreTemporal(candidate: Candidate, detectedAt: string, detectedMs: number | null): SignalResult {
  const deployedMs = toMs(candidate.deployedAt);
  if (deployedMs === null || detectedMs === null) {
    return {
      score: 0,
      description: 'Never observed in a production deployment before the incident.',
      detail: candidate.deployedAt ? undefined : 'no deployment record',
    };
  }
  if (deployedMs > detectedMs) {
    return {
      score: 0,
      description: `Deployed at ${candidate.deployedAt}, ${formatDuration(deployedMs - detectedMs)} AFTER the incident was detected.`,
    };
  }
  const gapMs = detectedMs - deployedMs;
  const gapMin = gapMs / 60000;
  const score =
    gapMin <= TEMPORAL_FULL_CREDIT_MIN
      ? 1
      : gapMin >= TEMPORAL_ZERO_MIN
        ? 0
        : clamp01(2 ** (-(gapMin - TEMPORAL_FULL_CREDIT_MIN) / TEMPORAL_HALF_LIFE_MIN));
  return {
    score,
    description: `Deployed to ${candidate.deployment?.environment ?? 'production'} at ${candidate.deployedAt}, ${formatDuration(gapMs)} before detection at ${detectedAt}.`,
    detail: `${formatDuration(gapMs)} lead time; full credit under ${TEMPORAL_FULL_CREDIT_MIN}m, halving every ${TEMPORAL_HALF_LIFE_MIN}m thereafter`,
  };
}

/**
 * stack_trace — the strongest signal. Did this change touch the code that is
 * actually on the stack?
 */
function scoreStackTrace(candidate: Candidate, stack: StackFacts): SignalResult {
  const changed = candidate.files.map((f) => normalizePath(f.path));
  if (changed.length === 0 || stack.files.length === 0) {
    return { score: 0, description: 'No overlap with the stack trace (nothing to compare).' };
  }

  const topFile = stack.topFrame ? normalizePath(stack.topFrame.file) : '';
  if (topFile && changed.includes(topFile)) {
    const frameLabel = stack.topFrame ? `${stack.topFrame.fn}:${stack.topFrame.line}` : topFile;
    return {
      score: 1,
      description: `Modified ${topFile}, the file of the top application frame (${frameLabel}).`,
    };
  }

  const inStack = changed.filter((p) => stack.files.includes(p));
  if (inStack.length > 0) {
    return {
      score: 0.7,
      description: `Modified ${inStack.join(', ')}, which appear deeper in the stack trace.`,
    };
  }

  const sameDir = changed.filter((p) => stack.dirs.includes(dirOf(p)));
  if (sameDir.length > 0) {
    return {
      score: 0.25,
      description: `Modified ${sameDir.join(', ')} — same directory as stack frames, but no file on the stack.`,
    };
  }

  return { score: 0, description: 'Modified no file that appears anywhere in the stack trace.' };
}

/**
 * symbol — do the identifiers this change added overlap the function names on
 * the stack? Only runtime source is scanned: prose in a README that happens to
 * contain the word "country" is not evidence.
 */
function scoreSymbol(candidate: Candidate, stack: StackFacts): SignalResult {
  if (stack.symbols.length === 0) {
    return { score: 0, description: 'Stack trace exposes no named functions to match.' };
  }

  const codeFiles = candidate.files.filter((f) => isRuntimeSource(f.path));
  let best: { score: number; description: string; detail: string } | null = null;

  for (const file of codeFiles) {
    // A change that CREATED the file necessarily "adds" every identifier in it,
    // including the function on the stack. That is far weaker evidence than a
    // change which edited an existing function: otherwise a repository's
    // bootstrap commit matches every symbol in every incident forever.
    const introducedFile = file.status === 'added';
    const lines = file.addedLines.length > 0 ? file.addedLines : patchAddedLines(file.patch);
    for (const line of lines) {
      for (const sym of stack.symbols) {
        const hit = matchSymbolInLine(line, sym);
        if (!hit) continue;
        const score = introducedFile ? hit.score * NEW_FILE_SYMBOL_DAMPING : hit.score;
        if (!best || score > best.score) {
          best = {
            score,
            description: introducedFile
              ? `${hit.kind} — introduced ${normalizePath(file.path)}, which defines \`${hit.matched}\` (${sym.depth === 0 ? 'the innermost failing frame' : `frame ${sym.depth + 1} of the stack`}); defining a function is weaker evidence than changing it.`
              : `${hit.kind} — added code in ${normalizePath(file.path)} references \`${hit.matched}\`, ${sym.depth === 0 ? 'the innermost failing frame' : `frame ${sym.depth + 1} of the stack`}.`,
            detail: truncate(line, 160),
          };
        }
        if (best.score >= 1) break;
      }
      if (best && best.score >= 1) break;
    }
    if (best && best.score >= 1) break;
  }

  if (!best) {
    return { score: 0, description: 'Added no identifier matching any function on the stack.' };
  }
  return { score: best.score, description: best.description, detail: best.detail };
}

interface SymbolHit {
  score: number;
  matched: string;
  kind: string;
}

/** Exact identifier match, class-only match, or a shared camelCase word. */
function matchSymbolInLine(line: string, sym: FrameSymbol): SymbolHit | null {
  if (identifierInLine(line, sym.method)) {
    return { score: 1, matched: sym.method, kind: 'Exact function match' };
  }
  if (sym.cls && identifierInLine(line, sym.cls)) {
    return { score: 0.5, matched: sym.cls, kind: 'Class-only match' };
  }
  for (const word of camelWords(sym.method)) {
    if (word.length >= 4 && identifierInLine(line, word)) {
      return { score: 0.35, matched: word, kind: 'Partial name match' };
    }
  }
  return null;
}

function identifierInLine(line: string, identifier: string): boolean {
  if (!identifier || identifier.length < 3) return false;
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(identifier)}(?![A-Za-z0-9_$])`);
  return re.test(line);
}

function camelWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Recover added lines from a unified diff when addedLines was not populated. */
function patchAddedLines(patch: string): string[] {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

/** keyword — weak lexical overlap between the alert and the change. */
function scoreKeyword(candidate: Candidate, incidentTokens: Set<string>): SignalResult {
  if (incidentTokens.size === 0) {
    return { score: 0, description: 'Incident text produced no distinctive terms.' };
  }
  const prTokens = new Set<string>([
    ...tokenize(candidate.title),
    ...candidate.files.flatMap((f) => tokenize(normalizePath(f.path))),
  ]);
  const shared = [...incidentTokens].filter((t) => prTokens.has(t)).sort();
  if (shared.length === 0) {
    return { score: 0, description: 'Shares no distinctive terms with the incident report.' };
  }
  const score = clamp01(shared.length / incidentTokens.size);
  return {
    score,
    description: `Shares ${shared.length} term${shared.length === 1 ? '' : 's'} with the incident report: ${shared.join(', ')}.`,
  };
}

/** blast_radius — a small prior favouring runtime code over docs and tests. */
function scoreBlastRadius(candidate: Candidate): SignalResult {
  const total = candidate.files.length;
  if (total === 0) {
    return { score: 0, description: 'Changed no files.' };
  }
  const runtime = candidate.files.filter((f) => isRuntimeSource(f.path));
  const score = runtime.length / total;
  if (runtime.length === 0) {
    return {
      score: 0,
      description:
        total === 1
          ? 'The single changed file does not run in production (docs/test/config only).'
          : `None of the ${total} changed files runs in production (docs/test/config only).`,
    };
  }
  return {
    score,
    description: `${runtime.length} of ${total} changed file${total === 1 ? ' runs' : 's run'} in production (${runtime.map((f) => normalizePath(f.path)).join(', ')}).`,
  };
}

// ---------------------------------------------------------------------------
// Scoring pipeline
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  candidate: Candidate;
  signals: {
    temporal: SignalResult;
    stack_trace: SignalResult;
    symbol: SignalResult;
    keyword: SignalResult;
    blast_radius: SignalResult;
  };
  positive: number;
  confidence: number;
  evidence: Evidence[];
}

function positiveEvidence(
  kind: Evidence['kind'],
  weight: number,
  result: SignalResult,
): Evidence | null {
  if (result.score <= 0) return null;
  return {
    kind,
    description: result.description,
    weight,
    score: round4(result.score),
    detail: result.detail,
  };
}

/**
 * Collect explicit exonerating facts. These are what stop the agent from
 * blaming the most recent deploy when that deploy is a README edit.
 */
function exculpatoryEvidence(
  scored: ScoredCandidate,
  detectedMs: number | null,
  bestStackScoreElsewhere: number,
): Evidence[] {
  const { candidate, signals } = scored;
  const raw: Evidence[] = [];

  if (candidate.files.length > 0 && signals.blast_radius.score === 0) {
    raw.push({
      kind: 'exculpatory',
      description:
        candidate.files.length === 1
          ? 'Touched no runtime code: the only changed file is documentation, tests or config.'
          : `Touched no runtime code: all ${candidate.files.length} changed files are documentation, tests or config.`,
      weight: 1,
      score: -PENALTY.docsOnly,
      detail: candidate.files.map((f) => normalizePath(f.path)).join(', '),
    });
  }

  if (signals.stack_trace.score < 0.7) {
    raw.push({
      kind: 'exculpatory',
      description: 'Touched no file that appears in the stack trace.',
      weight: 1,
      score: -PENALTY.noStackFile,
    });
  }

  if (candidate.deployedAfterIncident) {
    raw.push({
      kind: 'exculpatory',
      description: `Reached production at ${candidate.deployedAt}, after the incident had already started — it cannot be the cause.`,
      weight: 1,
      score: -PENALTY.deployedAfterIncident,
    });
  }

  if (candidate.deployedAt === null) {
    raw.push({
      kind: 'exculpatory',
      description:
        'No production deployment is recorded for this change, so it was not running when the incident began.',
      weight: 1,
      score: -PENALTY.neverDeployed,
    });
  }

  const deployedMs = toMs(candidate.deployedAt);
  if (
    deployedMs !== null &&
    detectedMs !== null &&
    detectedMs - deployedMs > STALE_HOURS * 3600_000 &&
    bestStackScoreElsewhere >= 0.7 &&
    signals.stack_trace.score < bestStackScoreElsewhere
  ) {
    raw.push({
      kind: 'exculpatory',
      description: `Live in production for ${formatDuration(detectedMs - deployedMs)} without incident while a better stack-trace match exists.`,
      weight: 1,
      score: -PENALTY.staleWithBetterCandidate,
    });
  }

  const total = raw.reduce((sum, e) => sum + Math.abs(e.score), 0);
  if (total <= EXCULPATORY_CAP) {
    return raw.map((e) => ({ ...e, score: round4(e.score) }));
  }
  const scale = EXCULPATORY_CAP / total;
  return raw.map((e) => ({
    ...e,
    score: round4(e.score * scale),
    detail: [e.detail, `scaled to the ${EXCULPATORY_CAP} exculpatory cap`].filter(Boolean).join('; '),
  }));
}

/** Score one candidate's positive signals. Exculpatory evidence needs a second pass. */
function scoreCandidate(
  candidate: Candidate,
  incident: Incident,
  stack: StackFacts,
  incidentTokens: Set<string>,
  detectedMs: number | null,
): ScoredCandidate {
  const signals = {
    temporal: scoreTemporal(candidate, incident.detectedAt, detectedMs),
    stack_trace: scoreStackTrace(candidate, stack),
    symbol: scoreSymbol(candidate, stack),
    keyword: scoreKeyword(candidate, incidentTokens),
    blast_radius: scoreBlastRadius(candidate),
  };

  const positive =
    signals.temporal.score * SIGNAL_WEIGHTS.temporal +
    signals.stack_trace.score * SIGNAL_WEIGHTS.stack_trace +
    signals.symbol.score * SIGNAL_WEIGHTS.symbol +
    signals.keyword.score * SIGNAL_WEIGHTS.keyword +
    signals.blast_radius.score * SIGNAL_WEIGHTS.blast_radius;

  const evidence: Evidence[] = [];
  for (const [kind, weight] of [
    ['stack_trace', SIGNAL_WEIGHTS.stack_trace],
    ['temporal', SIGNAL_WEIGHTS.temporal],
    ['symbol', SIGNAL_WEIGHTS.symbol],
    ['keyword', SIGNAL_WEIGHTS.keyword],
    ['blast_radius', SIGNAL_WEIGHTS.blast_radius],
  ] as const) {
    const ev = positiveEvidence(kind, weight, signals[kind]);
    if (ev) evidence.push(ev);
  }

  return { candidate, signals, positive, confidence: positive, evidence };
}

/** Contribution of one evidence entry to the final confidence. */
function contributionOf(e: Evidence): number {
  return e.weight * e.score;
}

// ---------------------------------------------------------------------------
// Prose derivation
// ---------------------------------------------------------------------------

interface ErrorShape {
  /** Property or method being read, e.g. "toUpperCase". */
  prop: string | null;
  /** "null" or "undefined" when the message names one. */
  nullish: string | null;
}

/** Pull the offending property and the nullish value out of an error message. */
function parseErrorMessage(message: string): ErrorShape {
  const modern = /Cannot read properties of (null|undefined) \(reading '([^']+)'\)/.exec(message);
  if (modern) return { nullish: modern[1], prop: modern[2] };
  const legacy = /Cannot read property '([^']+)' of (null|undefined)/.exec(message);
  if (legacy) return { prop: legacy[1], nullish: legacy[2] };
  const destructure = /Cannot destructure property '([^']+)' of '([^']+)'/.exec(message);
  if (destructure) return { prop: destructure[1], nullish: null };
  const notAFunction = /([A-Za-z_$][\w$.]*) is not a function/.exec(message);
  if (notAFunction) {
    const path = notAFunction[1].split('.');
    return { prop: path[path.length - 1], nullish: null };
  }
  const ofUndefined = /of (null|undefined)/.exec(message);
  return { prop: null, nullish: ofUndefined ? ofUndefined[1] : null };
}

/**
 * Find the source line the failing frame points at, preferring the code search
 * index and falling back to the suspect's own diff.
 */
function findOffendingLine(
  frame: StackFrame | null,
  context: CollectedContext,
  suspect: Candidate | null,
  prop: string | null,
): string | null {
  if (!frame) return null;
  const file = normalizePath(frame.file);

  const exact = context.codeMatches.find(
    (m) => normalizePath(m.path) === file && m.line === frame.line,
  );
  if (exact?.text) return exact.text.trim();

  if (prop) {
    const byProp = context.codeMatches.find(
      (m) => normalizePath(m.path) === file && m.text.includes('.' + prop),
    );
    if (byProp?.text) return byProp.text.trim();

    const changed = suspect?.files.find((f) => normalizePath(f.path) === file);
    const lines = changed
      ? changed.addedLines.length > 0
        ? changed.addedLines
        : patchAddedLines(changed.patch)
      : [];
    const hit = lines.find((l) => l.includes('.' + prop));
    if (hit) return hit.trim();
  }

  return null;
}

/** Extract the receiver expression immediately left of `.prop` in a source line. */
function receiverFor(line: string | null, prop: string | null): string | null {
  if (!line || !prop) return null;
  const re = new RegExp(
    `([A-Za-z_$][A-Za-z0-9_$]*(?:(?:\\?\\.|\\.)[A-Za-z_$][A-Za-z0-9_$]*|\\[[^\\]]+\\])*)\\??\\.${escapeRegExp(prop)}(?![A-Za-z0-9_$])`,
  );
  const m = re.exec(line);
  return m ? m[1] : null;
}

/** Suffix-aware humanisation: CheckoutValidator.js -> "Checkout validation". */
const MODULE_SUFFIX_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/validators?$/i, 'validation'],
  [/controllers?$/i, 'request handling'],
  [/handlers?$/i, 'request handling'],
  [/routers?$/i, 'routing'],
  [/routes?$/i, 'routing'],
  [/middlewares?$/i, 'middleware'],
  [/repositor(y|ies)$/i, 'data access'],
  [/managers?$/i, 'management'],
  [/services?$/i, 'service logic'],
  [/utils?$/i, 'utilities'],
  [/helpers?$/i, 'helpers'],
];

function moduleFunctionPhrase(frame: StackFrame | null, incident: Incident): string {
  if (!frame) return `${incident.service} request handling`;
  const base = baseOf(normalizePath(frame.file)).replace(/\.[cm]?[jt]sx?$/i, '');
  const words = camelWords(base.replace(/[-_]/g, ' '));
  if (words.length === 0) return `${incident.service} request handling`;
  const last = words[words.length - 1];
  for (const [pattern, phrase] of MODULE_SUFFIX_PHRASES) {
    if (pattern.test(last)) {
      const lead = words.slice(0, -1).join(' ');
      const text = lead ? `${lead} ${phrase}` : phrase;
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  const text = words.join(' ').toLowerCase() + ' logic';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function requestPhrase(incident: Incident): string {
  const req = incident.sampleRequest;
  return req ? `${req.method} ${req.path}` : '';
}

// ---------------------------------------------------------------------------
// analyze()
// ---------------------------------------------------------------------------

/**
 * Identify the change that most likely caused an incident.
 *
 * Pure and deterministic: the same {@link AnalyzeInput} always yields the same
 * {@link Investigation}, including every confidence value, because no wall
 * clock, randomness, network call or model is involved. Each merged pull
 * request in the collected context is scored on five weighted signals
 * (stack-trace overlap, deploy timing, symbol overlap, keyword overlap, blast
 * radius) and then debited for explicit exonerating facts, with one Evidence
 * entry recorded per contributing signal so the reasoning survives into the
 * ticket, the PR description and the Slack message.
 *
 * When the best candidate scores below {@link CONFIDENCE_FLOOR} the
 * investigation is marked inconclusive, `suspect` is null, and the mitigation
 * text asks for human triage instead of proposing a revert.
 *
 * @param input The incident plus the context gathered for it.
 * @returns A complete Investigation, ranked suspects included.
 */
export function analyze(input: AnalyzeInput): Investigation {
  const { incident, context } = input;
  const detectedMs = toMs(incident.detectedAt);
  const stack = analyzeStack(incident, context);
  const incidentTokens = new Set<string>([
    ...tokenize(incident.title),
    ...tokenize(incident.service),
    ...tokenize(incident.errorMessage),
    ...tokenize(incident.errorType),
    ...tokenize(incident.sampleRequest?.path ?? ''),
  ]);

  const candidates = buildCandidates(context, detectedMs);
  const scored = candidates.map((c) => scoreCandidate(c, incident, stack, incidentTokens, detectedMs));

  const bestStackScore = scored.reduce((max, s) => Math.max(max, s.signals.stack_trace.score), 0);
  for (const s of scored) {
    const exculpatory = exculpatoryEvidence(s, detectedMs, bestStackScore);
    s.evidence = [...s.evidence, ...exculpatory];
    const penalty = exculpatory.reduce((sum, e) => sum + contributionOf(e), 0);
    s.confidence = round4(clamp01(s.positive + penalty));
  }

  const ranked: SuspectScore[] = scored
    .map((s) => ({
      prNumber: s.candidate.prNumber,
      sha: s.candidate.sha,
      title: s.candidate.title,
      author: s.candidate.author,
      deployedAt: s.candidate.deployedAt,
      confidence: s.confidence,
      evidence: s.evidence,
    }))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const at = toMs(a.deployedAt) ?? 0;
      const bt = toMs(b.deployedAt) ?? 0;
      if (bt !== at) return bt - at;
      return (b.prNumber ?? 0) - (a.prNumber ?? 0);
    });

  const best = ranked[0] ?? null;
  const inconclusive = !best || best.confidence < CONFIDENCE_FLOOR;
  const suspect = inconclusive ? null : best;
  const suspectCandidate = suspect
    ? scored.find((s) => s.candidate.sha === suspect.sha && s.candidate.prNumber === suspect.prNumber)
        ?.candidate ?? null
    : null;

  const prose = deriveProse(incident, context, stack, suspectCandidate, suspect);

  return {
    suspect,
    rankedSuspects: ranked,
    failingFrame: stack.topFrame,
    affectedFunctionality: prose.affectedFunctionality,
    rootCause: prose.rootCause,
    immediateMitigation: prose.immediateMitigation,
    permanentFix: prose.permanentFix,
    reasoningSource: 'deterministic',
    narrative: buildNarrative(incident, stack, ranked, suspect, prose),
    inconclusive,
  };
}

interface DerivedProse {
  affectedFunctionality: string;
  rootCause: string;
  immediateMitigation: string;
  permanentFix: string;
}

/**
 * Turn the failing frame, the error message and the offending source line into
 * the four human sentences an incident ticket needs. Every part degrades
 * independently: a missing source line costs precision, not the sentence.
 */
function deriveProse(
  incident: Incident,
  context: CollectedContext,
  stack: StackFacts,
  suspectCandidate: Candidate | null,
  suspect: SuspectScore | null,
): DerivedProse {
  const frame = stack.topFrame;
  const { prop, nullish } = parseErrorMessage(incident.errorMessage);
  const sourceLine = findOffendingLine(frame, context, suspectCandidate, prop);
  const receiver = receiverFor(sourceLine, prop);
  const nullishWord = nullish ?? 'missing';
  const where = frame ? `${normalizePath(frame.file)}:${frame.line}` : 'an unresolved location';
  const fnLabel = frame && frame.fn !== '<anonymous>' ? frame.fn : incident.service;
  const req = requestPhrase(incident);
  const failingRequest = req ? `the failing ${req} request` : 'the failing request';

  // --- affected functionality -------------------------------------------------
  const modulePhrase = moduleFunctionPhrase(frame, incident);
  const receiverClause = receiver ? ` for requests where ${receiver} is ${nullishWord}` : '';
  const requestClause = req ? ` (${req})` : '';
  const affectedFunctionality = `${modulePhrase}${receiverClause}${requestClause}`;

  // --- root cause -------------------------------------------------------------
  let rootCause: string;
  if (receiver && prop) {
    const parts = receiver.split('.');
    const root = parts[0];
    const leaf = parts[parts.length - 1];
    const assumption =
      parts.length > 1
        ? `assumes \`${root}\` always carries \`${leaf}\``
        : `assumes \`${root}\` is always set`;
    rootCause = `${receiver} is ${nullishWord} at ${where}, where ${fnLabel} evaluates \`${truncate(sourceLine ?? '', 140)}\`; the code ${assumption}, but ${failingRequest} violates that assumption, so reading '${prop}' throws ${incident.errorType}.`;
  } else if (prop) {
    rootCause = `${fnLabel} reads '${prop}' from a ${nullishWord} value at ${where} (${incident.errorType}: ${incident.errorMessage}); the code assumes that value is always present, and ${failingRequest} proves it is not.${sourceLine ? ` Offending line: \`${truncate(sourceLine, 140)}\`.` : ' The offending source line was not available in the collected context.'}`;
  } else {
    rootCause = `${incident.errorType} raised by ${fnLabel} at ${where}: ${incident.errorMessage}. The failing input violates an assumption made at that call site${sourceLine ? ` (\`${truncate(sourceLine, 140)}\`)` : ', and the offending source line was not available in the collected context'}.`;
  }

  // --- mitigation & permanent fix --------------------------------------------
  const immediateMitigation =
    suspect && suspectCandidate
      ? `Revert ${candidateLabel(suspectCandidate)} (${suspectCandidate.title})`
      : `No revert candidate cleared the confidence floor of ${CONFIDENCE_FLOOR}; human triage is required before any change is reverted.`;

  const target = receiver ? `the ${receiver} access` : `the failing read at ${where}`;
  const guard = receiver
    ? `guard ${target} in ${fnLabel} (${where}) with an explicit ${nullishWord}-check or a safe default instead of assuming the value is present`
    : `add an explicit guard around ${target} in ${fnLabel} instead of assuming the value is present`;
  const coverage = req
    ? `add a regression test that issues ${req} with ${receiver ?? 'the offending field'} ${nullishWord === 'missing' ? 'absent' : nullishWord}`
    : `add a regression test that reproduces the ${incident.errorType} from ${fnLabel}`;
  const permanentFix = `${guard.charAt(0).toUpperCase() + guard.slice(1)}, and ${coverage} so this ${incident.errorType} fails the suite before it can reach production again.`;

  return { affectedFunctionality, rootCause, immediateMitigation, permanentFix };
}

/** One evidence line: `[+0.380] stack_trace (w 0.38 x 1.00) — ...`. */
function evidenceLine(e: Evidence, indent: string): string {
  const contribution = contributionOf(e);
  const sign = contribution >= 0 ? '+' : '-';
  const magnitude = Math.abs(contribution).toFixed(3);
  const weightNote = e.kind === 'exculpatory' ? '' : ` (w ${e.weight.toFixed(2)} x ${fixed2(e.score)})`;
  const detail = e.detail ? `\n${indent}    ${truncate(e.detail, 160)}` : '';
  return `${indent}[${sign}${magnitude}] ${e.kind}${weightNote} — ${e.description}${detail}`;
}

/**
 * Render the investigation the way an on-call engineer wants to read it:
 * the call, the confidence, the evidence behind it, and — crucially — why the
 * runners-up were ruled out.
 */
function buildNarrative(
  incident: Incident,
  stack: StackFacts,
  ranked: SuspectScore[],
  suspect: SuspectScore | null,
  prose: DerivedProse,
): string {
  const lines: string[] = [];
  const frame = stack.topFrame;

  if (suspect) {
    const label = suspect.prNumber !== null ? `PR #${suspect.prNumber}` : `commit ${suspect.sha.slice(0, 7)}`;
    lines.push(`Suspected change: ${label} — ${suspect.title}`);
    lines.push(`Confidence: ${fixed2(suspect.confidence)} (floor ${CONFIDENCE_FLOOR})`);
    lines.push(`Author: ${suspect.author}`);
    if (suspect.deployedAt) {
      const gap = (toMs(incident.detectedAt) ?? 0) - (toMs(suspect.deployedAt) ?? 0);
      lines.push(
        `Deployed: ${suspect.deployedAt} (${formatDuration(gap)} before detection at ${incident.detectedAt})`,
      );
    } else {
      lines.push(`Deployed: no production deployment recorded`);
    }
  } else {
    const best = ranked[0];
    lines.push(`Suspected change: INCONCLUSIVE — no candidate cleared the ${CONFIDENCE_FLOOR} confidence floor`);
    lines.push(
      best
        ? `Best candidate: ${best.prNumber !== null ? `PR #${best.prNumber}` : best.sha.slice(0, 7)} — ${best.title} at ${fixed2(best.confidence)}`
        : 'No merged change was found in the collected context.',
    );
  }

  lines.push(
    `Failing frame: ${frame ? `${frame.fn} at ${normalizePath(frame.file)}:${frame.line}` : 'unresolved'}`,
  );
  lines.push(`Affected functionality: ${prose.affectedFunctionality}`);
  lines.push(`Root cause: ${prose.rootCause}`);

  const primary = suspect ?? ranked[0];
  if (primary) {
    lines.push('Evidence:');
    const sorted = [...primary.evidence].sort(
      (a, b) => Math.abs(contributionOf(b)) - Math.abs(contributionOf(a)),
    );
    for (const e of sorted) lines.push(evidenceLine(e, '  '));
  }

  const runnersUp = ranked.filter((r) => r !== primary);
  if (runnersUp.length > 0) {
    lines.push('Ruled out:');
    for (const r of runnersUp) {
      const label = r.prNumber !== null ? `PR #${r.prNumber}` : `commit ${r.sha.slice(0, 7)}`;
      lines.push(`  ${label} ${fixed2(r.confidence)} — ${r.title}`);
      for (const e of r.evidence.filter((x) => x.kind === 'exculpatory')) {
        lines.push(evidenceLine(e, '    '));
      }
    }
  }

  lines.push(`Immediate mitigation: ${prose.immediateMitigation}`);
  lines.push(`Permanent fix: ${prose.permanentFix}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// analyzeWithLlm()
// ---------------------------------------------------------------------------

const LLM_SCHEMA_HINT = `{
  "suspectPrNumber": number | null,
  "confidence": number between 0 and 1,
  "rootCause": string,
  "affectedFunctionality": string,
  "permanentFix": string,
  "narrative": string,
  "rationale": string
}`;

/** Compact, faithful evidence summary. Patch excerpts are capped hard. */
function buildReviewPrompt(input: AnalyzeInput, deterministic: Investigation): LlmMessage[] {
  const { incident, context } = input;
  const candidates = deterministic.rankedSuspects.slice(0, LLM_MAX_CANDIDATES);
  const prByNumber = new Map(context.pullRequests.map((pr) => [pr.number, pr]));

  const blocks = candidates.map((s) => {
    const pr = s.prNumber !== null ? prByNumber.get(s.prNumber) : undefined;
    const files = (pr?.files ?? []).map((f) => `${f.path} (+${f.additions}/-${f.deletions})`);
    const excerpt = (pr?.files ?? [])
      .filter((f) => isRuntimeSource(f.path))
      .flatMap((f) =>
        (f.addedLines.length > 0 ? f.addedLines : patchAddedLines(f.patch))
          .filter((l) => l.trim().length > 0)
          .slice(0, LLM_MAX_EXCERPT_LINES)
          .map((l) => `    ${normalizePath(f.path)}: ${truncate(l, LLM_MAX_EXCERPT_CHARS)}`),
      )
      .slice(0, LLM_MAX_EXCERPT_LINES);

    const evidence = s.evidence.map((e) => `    ${e.kind} ${contributionOf(e) >= 0 ? '+' : ''}${contributionOf(e).toFixed(3)}: ${e.description}`);

    return [
      `${s.prNumber !== null ? `PR #${s.prNumber}` : `commit ${s.sha.slice(0, 7)}`} — ${s.title}`,
      `  author: ${s.author}`,
      `  deployed: ${s.deployedAt ?? 'never'}`,
      `  deterministic confidence: ${s.confidence.toFixed(4)}`,
      `  changed files: ${files.length > 0 ? files.join(', ') : 'unknown'}`,
      evidence.length > 0 ? `  evidence:\n${evidence.join('\n')}` : '  evidence: none',
      excerpt.length > 0 ? `  added code (excerpt):\n${excerpt.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  const frame = deterministic.failingFrame;
  const system: LlmMessage = {
    role: 'system',
    content:
      'You are a senior incident responder reviewing an automated root-cause analysis. ' +
      'You may only choose from the candidate changes listed. Recency of deployment is weak ' +
      'evidence; overlap between the stack trace and the diff is strong evidence. ' +
      'If the deterministic analysis looks right, agree with it and sharpen the wording. ' +
      'Reply with JSON only, matching the requested schema exactly.',
  };

  const user: LlmMessage = {
    role: 'user',
    content: [
      `INCIDENT ${incident.id} (${incident.severity}) — ${incident.title}`,
      `service: ${incident.service}`,
      `detected at: ${incident.detectedAt}`,
      `error: ${incident.errorType}: ${incident.errorMessage}`,
      incident.sampleRequest ? `sample request: ${incident.sampleRequest.method} ${incident.sampleRequest.path}` : '',
      `failing frame: ${frame ? `${frame.fn} at ${normalizePath(frame.file)}:${frame.line}` : 'unresolved'}`,
      '',
      'STACK TRACE:',
      truncate(incident.stackTrace.split('\n').slice(0, 12).join(' | '), 900),
      '',
      'CANDIDATE CHANGES (deterministic ranking):',
      blocks.join('\n\n'),
      '',
      'DETERMINISTIC CONCLUSION:',
      `  suspect: ${deterministic.suspect ? `PR #${deterministic.suspect.prNumber}` : 'none (inconclusive)'}`,
      `  root cause: ${deterministic.rootCause}`,
      '',
      `Return JSON: ${LLM_SCHEMA_HINT}`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
  };

  return [system, user];
}

/** Accept a string field only when the model actually filled it in. */
function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Run the deterministic analysis, then optionally let an LLM review it.
 *
 * The deterministic result is always computed first and is always the fallback:
 * if the client is unavailable, throws, returns null, nominates a change that
 * is not among the candidates, or reports a confidence that is not a finite
 * number in 0..1, the review is discarded and the deterministic Investigation
 * is returned unchanged. When a review is accepted, only prose is merged
 * (root cause, affected functionality, permanent fix, narrative) plus a
 * confidence that is the mean of the two; the deterministic evidence list is
 * preserved verbatim and `reasoningSource` becomes the provider name. The model
 * can sharpen the explanation — it can never manufacture a suspect.
 *
 * @param input The incident plus the context gathered for it.
 * @param llm Provider client; an unavailable client is a no-op.
 * @returns The deterministic Investigation, optionally with reviewed prose.
 */
export async function analyzeWithLlm(input: AnalyzeInput, llm: LlmClient): Promise<Investigation> {
  const deterministic = analyze(input);
  if (!llm.available) return deterministic;
  if (deterministic.rankedSuspects.length === 0) return deterministic;

  let review: LlmAnalysisReview | null = null;
  try {
    review = await llm.completeJson<LlmAnalysisReview>(buildReviewPrompt(input, deterministic), LLM_SCHEMA_HINT);
  } catch (err) {
    log.warn(`LLM review failed, keeping deterministic analysis: ${(err as Error).message}`);
    return deterministic;
  }

  if (!review || typeof review !== 'object') {
    log.debug('LLM returned no review; keeping deterministic analysis');
    return deterministic;
  }

  const { suspectPrNumber, confidence } = review;
  if (suspectPrNumber === null || typeof suspectPrNumber !== 'number' || !Number.isFinite(suspectPrNumber)) {
    log.warn('LLM review named no valid suspect; keeping deterministic analysis');
    return deterministic;
  }
  const chosen = deterministic.rankedSuspects.find((s) => s.prNumber === suspectPrNumber);
  if (!chosen) {
    log.warn(`LLM review named PR #${suspectPrNumber}, which is not a candidate; discarding`);
    return deterministic;
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    log.warn('LLM review returned an out-of-range confidence; keeping deterministic analysis');
    return deterministic;
  }

  const merged = round4(clamp01((chosen.confidence + confidence) / 2));
  const rankedSuspects = deterministic.rankedSuspects
    .map((s) => (s === chosen ? { ...s, confidence: merged } : s))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const at = toMs(a.deployedAt) ?? 0;
      const bt = toMs(b.deployedAt) ?? 0;
      if (bt !== at) return bt - at;
      return (b.prNumber ?? 0) - (a.prNumber ?? 0);
    });

  const inconclusive = merged < CONFIDENCE_FLOOR;
  const suspect = inconclusive ? null : rankedSuspects.find((s) => s.prNumber === suspectPrNumber) ?? null;
  const immediateMitigation = suspect
    ? `Revert PR #${suspect.prNumber} (${suspect.title})`
    : `No revert candidate cleared the confidence floor of ${CONFIDENCE_FLOOR}; human triage is required before any change is reverted.`;

  const rationale = stringField(review.rationale, '');
  const baseNarrative = stringField(review.narrative, deterministic.narrative);
  const narrative = rationale ? `${baseNarrative}\nLLM review (${llm.name}): ${rationale}` : baseNarrative;

  return {
    ...deterministic,
    suspect,
    rankedSuspects,
    affectedFunctionality: stringField(review.affectedFunctionality, deterministic.affectedFunctionality),
    rootCause: stringField(review.rootCause, deterministic.rootCause),
    immediateMitigation,
    permanentFix: stringField(review.permanentFix, deterministic.permanentFix),
    reasoningSource: llm.name,
    narrative,
    inconclusive,
  };
}
