/**
 * Firefighter shared domain contracts.
 *
 * Every module in the system codes against these types. Adapters (GitHub,
 * Slack, ticketing, LLM) each have a real and a mock implementation that
 * satisfy the identical interface, so switching providers is an env change.
 */

// ---------------------------------------------------------------------------
// Incident
// ---------------------------------------------------------------------------

export type Severity = 'sev1' | 'sev2' | 'sev3';

export interface LogLine {
  ts: string;
  level: 'error' | 'warn' | 'info';
  msg: string;
  requestId?: string;
}

export interface SampleRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Incident {
  id: string;
  title: string;
  service: string;
  severity: Severity;
  detectedAt: string;
  errorType: string;
  errorMessage: string;
  stackTrace: string;
  sampleRequest?: SampleRequest;
  logs: LogLine[];
  metrics?: { errorRatePct: number; affectedRequests: number; window: string };
  source: string;
}

// ---------------------------------------------------------------------------
// Repository / VCS
// ---------------------------------------------------------------------------

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authoredAt: string;
  files: string[];
  prNumber: number | null;
}

export type FileStatus = 'added' | 'modified' | 'removed';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string;
  addedLines: string[];
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseRef: string;
  headRef: string;
  url: string;
  files: ChangedFile[];
  labels: string[];
}

export interface Deployment {
  id: string;
  sha: string;
  prNumber: number | null;
  environment: string;
  deployedAt: string;
  status: 'success' | 'failed';
}

export interface CodeMatch {
  path: string;
  line: number;
  text: string;
}

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  headSha: string;
}

export interface CollectedContext {
  repo: RepoInfo;
  commits: CommitInfo[];
  pullRequests: PullRequestInfo[];
  deployments: Deployment[];
  codeMatches: CodeMatch[];
  failingFrame: StackFrame | null;
}

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

export interface StackFrame {
  fn: string;
  file: string;
  line: number;
  column: number | null;
}

export type EvidenceKind =
  | 'temporal'
  | 'stack_trace'
  | 'symbol'
  | 'keyword'
  | 'blast_radius'
  | 'exculpatory'
  /** Proven by executing the reproduction across commits, not inferred. */
  | 'causal';

export interface Evidence {
  kind: EvidenceKind;
  description: string;
  /** Contribution weight of this signal class (0..1). */
  weight: number;
  /** Normalised signal strength for this suspect (0..1). Negative for exculpatory. */
  score: number;
  detail?: string;
}

export interface SuspectScore {
  prNumber: number | null;
  sha: string;
  title: string;
  author: string;
  deployedAt: string | null;
  confidence: number;
  evidence: Evidence[];
}

/** One commit probed by the culprit verifier. */
export interface CulpritProbe {
  prNumber: number | null;
  sha: string;
  title: string;
  parentSha: string | null;
  /** Did the incident reproduce at this commit? */
  reproducedAtChange: boolean;
  /** Did it reproduce at this commit's parent? */
  reproducedAtParent: boolean | null;
  verdict: 'proven' | 'predates-this-change' | 'not-present-here' | 'inconclusive';
  note: string;
}

/**
 * Result of proving causality by execution.
 *
 * Correlation ranks candidates; this verifies one. A change is the culprit only
 * if the incident reproduces AT that commit and does NOT reproduce at its
 * parent — that is a causal claim, not a guess.
 */
export interface CulpritVerification {
  verified: boolean;
  method: 'bisect-reproduction';
  culpritPr: number | null;
  culpritSha: string | null;
  probes: CulpritProbe[];
  summary: string;
  /**
   * What correlation ranked first, versus what execution proved.
   *
   * These two fields are the supervision signal for tuning the analyzer: every
   * run where `overrodeRanking` is true is a labelled example of the heuristic
   * being wrong, and every ruled-out probe is a labelled negative. They are
   * persisted with the step output, so the history is queryable later.
   */
  rankedPr: number | null;
  overrodeRanking: boolean;
  /** Set when verification could not run at all (e.g. no reproduction). */
  skippedReason: string | null;
  durationMs: number;
}

export interface Investigation {
  suspect: SuspectScore | null;
  rankedSuspects: SuspectScore[];
  failingFrame: StackFrame | null;
  affectedFunctionality: string;
  rootCause: string;
  immediateMitigation: string;
  permanentFix: string;
  reasoningSource: LlmProviderName;
  narrative: string;
  /** True when no suspect cleared the confidence floor. */
  inconclusive: boolean;
  /** Present once causality has been probed by execution. */
  verification?: CulpritVerification;
}

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

export interface FilePatch {
  path: string;
  kind: 'modify' | 'add';
  contents: string;
  rationale: string;
}

export interface FixPlan {
  rootCause: string;
  reproductionSteps: string[];
  patches: FilePatch[];
  regressionTest: FilePatch | null;
  regressionTestName: string;
  risks: string[];
  source: LlmProviderName;
}

export interface ReproResult {
  reproduced: boolean;
  command: string;
  output: string;
  matchedError: boolean;
  durationMs: number;
  /**
   * Did the entry point actually execute?
   *
   * `reproduced: false` is ambiguous on its own: it means either "the code ran
   * and behaved" or "the code never ran". Bisection depends on telling those
   * apart — a probe that crashed at the parent commit must never be read as
   * evidence that the fault was absent there.
   */
  executed: boolean;
}

export interface TestFailure {
  name: string;
  message: string;
}

export interface TestRunResult {
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  output: string;
  failures: TestFailure[];
}

export interface LintResult {
  ok: boolean;
  errors: number;
  warnings: number;
  output: string;
}

// ---------------------------------------------------------------------------
// External references (results of idempotent mutations)
// ---------------------------------------------------------------------------

export interface TicketRef {
  id: string;
  identifier: string;
  url: string;
  provider: string;
  state: string;
  title: string;
}

export type PrKind = 'revert' | 'fix';

export interface PullRequestRef {
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
  title: string;
  provider: string;
  kind: PrKind;
  /** Always false. Firefighter never merges. */
  merged: false;
}

export interface SlackMessageRef {
  ts: string;
  channel: string;
  permalink: string;
  provider: string;
  text: string;
}

export interface RevertPrep {
  branch: string;
  baseSha: string;
  revertedSha: string;
  targetPrNumber: number | null;
  filesRestored: string[];
  diffStat: string;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type LlmProviderName = 'deterministic' | 'openai' | 'anthropic';

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmClient {
  readonly name: LlmProviderName;
  readonly available: boolean;
  /** Returns parsed JSON matching the requested shape, or null if unavailable. */
  completeJson<T>(messages: LlmMessage[], schemaHint: string): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const STEP_NAMES = [
  'ingest_incident',
  'collect_context',
  'identify_suspect_change',
  'verify_culprit',
  'create_incident_ticket',
  'prepare_revert',
  'verify_revert',
  'create_revert_pr',
  'reproduce_bug',
  'generate_fix',
  'run_fix_tests',
  'create_fix_pr',
  'notify_slack',
  'complete',
] as const;

export type StepName = (typeof STEP_NAMES)[number];

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface WorkflowRun {
  id: string;
  incidentId: string;
  status: RunStatus;
  currentStep: StepName | null;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StepRecord {
  runId: string;
  step: StepName;
  status: StepStatus;
  attempts: number;
  error: string | null;
  output: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ToolCallRecord {
  id: number;
  runId: string;
  step: StepName | null;
  tool: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  mutating: boolean;
  idempotencyKey: string | null;
  replayed: boolean;
  durationMs: number;
  createdAt: string;
}

export interface MutationRecord {
  idempotencyKey: string;
  runId: string;
  incidentId: string;
  kind: string;
  /** Logical entity identity used for duplicate detection. */
  subject: string;
  externalId: string;
  externalUrl: string | null;
  payloadHash: string;
  result: unknown;
  createdAt: string;
}

/**
 * Accumulated workflow state. Rebuilt deterministically from persisted step
 * outputs on resume, so a crash never loses completed work.
 */
export interface WorkflowContext {
  incident: Incident;
  collected?: CollectedContext;
  investigation?: Investigation;
  culpritVerification?: CulpritVerification;
  ticket?: TicketRef;
  revertPrep?: RevertPrep;
  revertVerification?: { tests: TestRunResult; lint: LintResult };
  revertPr?: PullRequestRef;
  repro?: ReproResult;
  fixPlan?: FixPlan;
  fixBranch?: string;
  fixVerification?: { tests: TestRunResult; lint: LintResult; baselineTests?: TestRunResult };
  fixPr?: PullRequestRef;
  slack?: SlackMessageRef;
  summary?: IncidentSummary;
}

export interface IncidentSummary {
  incidentId: string;
  title: string;
  suspect: string;
  confidence: number;
  ticket: string | null;
  revertPr: string | null;
  fixPr: string | null;
  testsPassed: string;
  humanApprovalRequired: true;
}

export type StepOutput = Partial<WorkflowContext>;
