PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  service      TEXT NOT NULL,
  severity     TEXT NOT NULL,
  source       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  current_step TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  scenario     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  output      TEXT,
  started_at  TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  PRIMARY KEY (run_id, step)
);

-- Every external mutation is recorded here BEFORE it is considered done.
-- A replay with the same idempotency_key returns the stored result instead of
-- performing the side effect again. This table is the source of truth for the
-- duplicate_write_count eval metric.
CREATE TABLE IF NOT EXISTS mutations (
  idempotency_key TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  incident_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  -- The logical entity this write creates (e.g. "incident_ticket",
  -- "pull_request:revert", "branch:fix"). Duplicate detection groups on this,
  -- NOT on kind: one incident legitimately creates two branches and two PRs,
  -- but must never create two of the SAME logical entity.
  subject         TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  external_url    TEXT,
  payload_hash    TEXT NOT NULL,
  result          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutations_incident_subject ON mutations(incident_id, subject);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  step            TEXT,
  tool            TEXT NOT NULL,
  args            TEXT,
  result          TEXT,
  ok              INTEGER NOT NULL,
  mutating        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  replayed        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, id);

CREATE TABLE IF NOT EXISTS timeline (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  ts      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  step    TEXT,
  message TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_run ON timeline(run_id, id);

-- Outbox for connector-delivered integrations (Slack / Jira via an external
-- agent). The workflow never blocks on these: it records the exact payload
-- idempotently and an external resolver fills in the external id later.
CREATE TABLE IF NOT EXISTS bridge_intents (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  incident_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,
  external_id  TEXT,
  external_url TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

-- Audit trail proving unsafe actions were refused.
CREATE TABLE IF NOT EXISTS safety_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  reason     TEXT NOT NULL,
  blocked    INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
