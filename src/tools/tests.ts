/**
 * Test, lint and reproduction runner.
 *
 * This is the module that turns "the agent thinks it fixed the bug" into
 * evidence. Everything here executes for real against a working tree:
 *
 *   - runTests()  shells out to `node --test` and parses its TAP output.
 *   - runLint()   runs `node --check` over every tracked JavaScript file and
 *                 then applies a small, deliberately conservative rule engine.
 *   - reproduce() re-plays the production request that caused the incident
 *                 against the checkout entry point and reports what it threw.
 *
 * Three invariants hold throughout:
 *   1. Child processes are spawned with an argv array via execFile, never a
 *      shell string, so nothing in a path or pattern can become a metacharacter.
 *   2. Nothing here mutates the repository. The reproduction driver is written
 *      into the OS temp directory so `git status` in the work tree stays clean.
 *   3. Wall-clock readings go through nowMs() and generated file names go
 *      through shortHash(), so a frozen-clock eval run is reproducible.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { Config, config as defaultConfig } from '../config.ts';
import { Incident, LintResult, ReproResult, TestFailure, TestRunResult } from '../types.ts';
import { nowMs } from '../util/clock.ts';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';
import { callArgument, EntryPoint, resolveEntryPoint } from '../agent/entrypoint.ts';

const log = logger('tools/tests');
const execFileAsync = promisify(execFile);

/** Default wall-clock budget for a `node --test` run. */
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
/** Default wall-clock budget for a single reproduction replay. */
const DEFAULT_REPRO_TIMEOUT_MS = 30_000;
/** Per-file budget for `node --check`. */
const SYNTAX_CHECK_TIMEOUT_MS = 15_000;
/** Captured output is clipped to this many characters, keeping the tail. */
const MAX_OUTPUT_CHARS = 20_000;
/** 16 MiB of child output is plenty and bounds memory. */
const MAX_BUFFER = 16 * 1024 * 1024;
/** Where `node --test` looks when the caller does not pass a pattern. */
const DEFAULT_TEST_PATTERN = 'test/';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options common to every runner entry point. */
export interface RunOpts {
  /** Working tree to run in. Defaults to `config.demoRepoPath`. */
  cwd?: string;
  /** Test file, directory or glob. Defaults to `test/`. */
  pattern?: string;
  /** Wall-clock budget in milliseconds. */
  timeoutMs?: number;
}

/** Executes tests, lint and incident reproduction against a working tree. */
export interface TestRunner {
  /** Identifies the implementation, e.g. `node-test`. */
  readonly provider: string;
  /** Run the repository's test suite. */
  runTests(opts?: RunOpts): Promise<TestRunResult>;
  /** Syntax-check and lint every tracked JavaScript file. */
  runLint(opts?: RunOpts): Promise<LintResult>;
  /** Replay the incident's sample request against the repository. */
  reproduce(incident: Incident, opts?: RunOpts): Promise<ReproResult>;
}

// ---------------------------------------------------------------------------
// Child process helper
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ExecFileError extends Error {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Run a child process with an argv array and never throw: a non-zero exit, a
 * timeout and a missing binary all come back as a normal {@link ExecResult}.
 */
async function exec(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<ExecResult> {
  const options = {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8' as const,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  };
  try {
    const { stdout, stderr } = await execFileAsync(file, args, options);
    return { code: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false };
  } catch (err) {
    const e = err as ExecFileError;
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const code = typeof e.code === 'number' ? e.code : timedOut ? 124 : 1;
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    let stderr = typeof e.stderr === 'string' ? e.stderr : '';
    if (!stderr && e.message) stderr = e.message;
    return { code, stdout, stderr, timedOut };
  }
}

/** Clip text to `max` characters, keeping the END (failures live at the end). */
function truncateTail(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  const header = `... [truncated ${dropped} earlier characters]\n`;
  return header + text.slice(text.length - Math.max(0, max - header.length));
}

/** Collapse all whitespace runs to single spaces and cap the length. */
function collapse(text: string, cap = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** Leading-whitespace width of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Map over items with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'coverage', 'dist', 'build']);
const JS_EXT = /\.[cm]?[jt]sx?$/;

/**
 * Recursively collect JavaScript files under `dir`, skipping VCS metadata,
 * dependency trees and dot-directories. Returns absolute paths, sorted.
 */
function walkJsFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && JS_EXT.test(entry.name)) {
        found.push(full);
      }
    }
  };
  visit(dir, 0);
  return found.sort();
}

/**
 * The set of repo-relative paths git considers part of the project: tracked
 * files plus untracked-but-not-ignored ones. Returns null when `cwd` is not a
 * git work tree, in which case the caller falls back to the raw file walk.
 */
async function gitVisibleFiles(cwd: string): Promise<Set<string> | null> {
  const res = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd,
    timeoutMs: SYNTAX_CHECK_TIMEOUT_MS,
  });
  if (res.code !== 0) return null;
  const set = new Set<string>();
  for (const entry of res.stdout.split('\0')) {
    if (entry) set.add(entry);
  }
  return set;
}

// ---------------------------------------------------------------------------
// node --test output parsing
// ---------------------------------------------------------------------------

interface Diagnostic {
  fields: Record<string, string>;
  next: number;
}

/** Strip YAML quoting from a scalar value. */
function unquoteYaml(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      const inner = value.slice(1, -1);
      return first === "'"
        ? inner.replace(/''/g, "'")
        : inner
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
  }
  return value;
}

/**
 * Parse the `--- ... ...` YAML diagnostic block that follows a TAP assertion.
 * `start` is the index of the `---` line.
 */
function parseDiagnostic(lines: string[], start: number): Diagnostic {
  const fields: Record<string, string> = {};
  const base = indentOf(lines[start]!);
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '...') {
      i += 1;
      break;
    }
    if (trimmed !== '' && indentOf(line) < base) break;
    const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(trimmed);
    if (m && indentOf(line) === base) {
      const key = m[1]!;
      const rest = m[2]!;
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
        const buf: string[] = [];
        i += 1;
        while (i < lines.length) {
          const l = lines[i]!;
          if (l.trim() === '') {
            buf.push('');
            i += 1;
            continue;
          }
          if (indentOf(l) <= base) break;
          buf.push(l.slice(Math.min(base + 2, indentOf(l))));
          i += 1;
        }
        while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
        fields[key] = buf.join('\n');
        continue;
      }
      fields[key] = unquoteYaml(rest);
      i += 1;
      continue;
    }
    i += 1;
  }
  return { fields, next: i };
}

const SUMMARY_RE = /^[\s]*(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
const NOT_OK_RE = /^(\s*)not ok\s+(\d+)\s*-?\s*(.*)$/;
const OK_RE = /^(\s*)ok\s+(\d+)\s*-?\s*(.*)$/;
const SUBTEST_RE = /^(\s*)#\s+Subtest:\s*(.*)$/;
const SPEC_FAIL_RE = /^\s*✖\s+(.*?)\s*\(\d+(?:\.\d+)?ms\)\s*$/;

/** Split a TAP description from its trailing `# SKIP` / `# TODO` directive. */
function splitDirective(description: string): { name: string; directive: string | null } {
  const m = /\s+#\s+(SKIP|TODO)\b.*$/i.exec(description);
  if (!m) return { name: description.trim(), directive: null };
  return {
    name: description.slice(0, m.index).trim(),
    directive: (m[1] ?? '').toUpperCase(),
  };
}

/**
 * Parse the output of `node --test` into counts and structured failures.
 *
 * Understands the TAP reporter (`# pass N`, `not ok N - name` plus its YAML
 * diagnostic block) and degrades to the spec reporter (`ℹ pass N`, `✖ name`)
 * or to simply counting `ok` / `not ok` lines when no summary is present.
 *
 * The returned `ok` reflects the output only; the caller still ANDs it with the
 * child's exit code.
 *
 * @param stdout  the child's standard output.
 * @param stderr  the child's standard error (uncaught errors land here).
 * @returns counts, per-test failures and an output-derived `ok`.
 */
export function parseNodeTestOutput(
  stdout: string,
  stderr: string,
): Omit<TestRunResult, 'durationMs' | 'output'> {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);

  // --- summary counters ----------------------------------------------------
  const summary: Record<string, number> = {};
  for (const line of lines) {
    const m = SUMMARY_RE.exec(line);
    if (m) summary[m[1]!] = Number(m[2]);
  }

  // --- failures ------------------------------------------------------------
  const failures: TestFailure[] = [];
  const stack: { indent: number; name: string }[] = [];
  let okLines = 0;
  let notOkLines = 0;
  let skippedLines = 0;
  let todoLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    const sub = SUBTEST_RE.exec(line);
    if (sub) {
      const indent = sub[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      stack.push({ indent, name: sub[2]!.trim() });
      continue;
    }

    const bad = NOT_OK_RE.exec(line);
    if (bad) {
      const indent = bad[1]!.length;
      const { name, directive } = splitDirective(bad[3] ?? '');
      const ancestors = stack.filter((s) => s.indent < indent).map((s) => s.name);
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();

      if (directive === 'TODO') {
        todoLines += 1;
        continue;
      }
      notOkLines += 1;

      let message = 'test failed';
      const next = lines[i + 1];
      if (next !== undefined && next.trim() === '---') {
        const { fields } = parseDiagnostic(lines, i + 1);
        const body = collapse(fields.error ?? '');
        const errName = (fields.name ?? '').trim();
        message = body || fields.failureType || 'test failed';
        if (errName && !message.startsWith(errName)) message = `${errName}: ${message}`;
      }
      failures.push({ name: [...ancestors, name].filter(Boolean).join(' > ') || `test #${bad[2]}`, message });
      continue;
    }

    const good = OK_RE.exec(line);
    if (good) {
      const indent = good[1]!.length;
      const { directive } = splitDirective(good[3] ?? '');
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      if (directive === 'SKIP') skippedLines += 1;
      else if (directive === 'TODO') todoLines += 1;
      else okLines += 1;
    }
  }

  // Safety net: the spec reporter has no `not ok` lines at all.
  if (failures.length === 0 && (summary.fail ?? 0) > 0) {
    const seen = new Set<string>();
    for (const line of lines) {
      const m = SPEC_FAIL_RE.exec(line);
      if (!m) continue;
      const name = m[1]!.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      failures.push({ name, message: 'test failed' });
    }
  }

  const hasSummary = summary.pass !== undefined || summary.fail !== undefined;
  const passed = hasSummary ? (summary.pass ?? 0) : okLines;
  const failed = hasSummary ? (summary.fail ?? 0) : notOkLines;
  const skipped = hasSummary ? (summary.skipped ?? 0) : skippedLines;
  const todo = hasSummary ? (summary.todo ?? 0) : todoLines;
  const total = summary.tests ?? passed + failed + skipped + todo;

  return { ok: failed === 0 && total > 0, passed, failed, total, failures };
}

// ---------------------------------------------------------------------------
// Lint: source scrubbing
// ---------------------------------------------------------------------------

interface ScrubbedSource {
  /**
   * One entry per line, identical in length to the original, with comment and
   * string-literal characters replaced by spaces. Column indices therefore
   * still line up with the raw source.
   */
  code: string[];
  /** True when the line began inside an unterminated block comment. */
  startedInBlockComment: boolean[];
}

/**
 * Blank out comments and string literals so the line-based rules below cannot
 * fire on the word `debugger` inside a string or a `==` inside a comment.
 *
 * This is a heuristic scanner, not a parser: regex literals containing quotes
 * can confuse it. That is an acceptable trade for rules that are conservative
 * by design.
 */
function scrubSource(lines: string[]): ScrubbedSource {
  const code: string[] = [];
  const startedInBlockComment: boolean[] = [];
  let inBlock = false;
  let quote: string | null = null;

  for (const raw of lines) {
    startedInBlockComment.push(inBlock);
    const chars = raw.split('');
    let i = 0;
    while (i < chars.length) {
      const c = chars[i]!;
      const n = i + 1 < chars.length ? chars[i + 1]! : '';
      if (inBlock) {
        if (c === '*' && n === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          inBlock = false;
          continue;
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }
      if (quote !== null) {
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === quote) {
          chars[i] = ' ';
          quote = null;
          i += 1;
          continue;
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }
      if (c === '/' && n === '*') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        inBlock = true;
        continue;
      }
      if (c === '/' && n === '/') {
        for (let k = i; k < chars.length; k += 1) chars[k] = ' ';
        break;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        chars[i] = ' ';
        i += 1;
        continue;
      }
      i += 1;
    }
    // Only template literals survive a newline; a stray quote does not.
    if (quote !== '`') quote = null;
    code.push(chars.join(''));
  }

  return { code, startedInBlockComment };
}

// ---------------------------------------------------------------------------
// Lint: rule engine
// ---------------------------------------------------------------------------

type Severity = 'error' | 'warning';

interface LintFinding {
  path: string;
  line: number;
  rule: string;
  severity: Severity;
  message: string;
}

const DEBUGGER_RE = /\bdebugger\b/;
const ONLY_RE = /\b(?:test|describe|it|suite)\s*\.\s*only\s*\(/;
const CONSOLE_RE = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace|dir|table|time|timeEnd)\s*\(/;
const EQ_RE = /(?<![=!<>])(===|!==|==|!=)(?!=)/g;
const CATCH_RE = /(?<![.\w$])catch\s*(?:\([^)]*\))?\s*\{/g;
const USE_STRICT_RE = /^\s*(['"])use strict\1\s*;?\s*$/;
const TODO_RE = /\b(TODO|FIXME)\b/i;
const MEMBER_RE = /[A-Za-z_$][\w$]*\s*(?:\.\s*[A-Za-z_$]|\[)/;

/**
 * Locate the `}` that closes the `{` at (line, col), scanning the scrubbed
 * source so braces inside strings and comments do not count.
 */
function findMatchingBrace(
  code: string[],
  line: number,
  col: number,
  maxLines = 200,
): { line: number; col: number } | null {
  let depth = 0;
  const last = Math.min(code.length, line + maxLines);
  for (let j = line; j < last; j += 1) {
    const s = code[j]!;
    for (let k = j === line ? col : 0; k < s.length; k += 1) {
      const ch = s[k];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return { line: j, col: k };
      }
    }
  }
  return null;
}

/** Raw text strictly between two (line, col) positions. */
function rawBetween(
  raw: string[],
  fromLine: number,
  fromCol: number,
  toLine: number,
  toCol: number,
): string {
  if (fromLine === toLine) return raw[fromLine]!.slice(fromCol, toCol);
  const parts: string[] = [raw[fromLine]!.slice(fromCol)];
  for (let j = fromLine + 1; j < toLine; j += 1) parts.push(raw[j]!);
  parts.push(raw[toLine]!.slice(0, toCol));
  return parts.join('\n');
}

/**
 * Apply the text rules to one file.
 *
 * Rules are intentionally narrow: the seeded (buggy) demo repository and the
 * repaired one must both lint clean, so anything that could plausibly fire on
 * ordinary, correct code is a warning rather than an error.
 *
 * @param rel     repo-relative path, used in findings and for `src/**` scoping.
 * @param source  the file's full text.
 */
function applyRules(rel: string, source: string): LintFinding[] {
  const raw = source.split(/\r?\n/);
  const { code, startedInBlockComment } = scrubSource(raw);
  const findings: LintFinding[] = [];
  const inSrc = rel === 'src' || rel.startsWith(`src${path.sep}`) || rel.startsWith('src/');
  const add = (line: number, rule: string, severity: Severity, message: string): void => {
    findings.push({ path: rel, line, rule, severity, message });
  };

  let strictDirectives = 0;

  for (let i = 0; i < code.length; i += 1) {
    const line = code[i]!;
    const rawLine = raw[i]!;
    const ln = i + 1;

    // no-unused-strict-dupe -------------------------------------------------
    if (!startedInBlockComment[i] && USE_STRICT_RE.test(rawLine)) {
      strictDirectives += 1;
      if (strictDirectives > 1) {
        add(ln, 'no-unused-strict-dupe', 'error', "redundant 'use strict' directive; the file is already strict");
      }
    }

    if (line.trim() === '') continue;

    // no-debugger -----------------------------------------------------------
    if (DEBUGGER_RE.test(line)) {
      add(ln, 'no-debugger', 'error', 'remove the debugger statement before shipping');
    }

    // no-only-tests ---------------------------------------------------------
    if (ONLY_RE.test(line)) {
      add(ln, 'no-only-tests', 'error', 'remove .only so the whole suite runs in CI');
    }

    // no-console-in-src -----------------------------------------------------
    if (inSrc && CONSOLE_RE.test(line)) {
      add(ln, 'no-console-in-src', 'warning', 'use the service logger instead of console in src/**');
    }

    // eqeqeq ----------------------------------------------------------------
    for (const m of line.matchAll(EQ_RE)) {
      const op = m[1]!;
      if (op.length === 3) continue;
      const at = m.index ?? 0;
      const before = line.slice(0, at);
      const after = line.slice(at + op.length);
      // `x == null` is the idiomatic null-or-undefined check; allow it.
      if (/^\s*null\b/.test(after) || /\bnull\s*$/.test(before)) continue;
      add(ln, 'eqeqeq', 'warning', `use ${op === '==' ? '===' : '!=='} instead of ${op}`);
    }

    // no-unguarded-null-deref-todo -----------------------------------------
    if (TODO_RE.test(rawLine) && MEMBER_RE.test(line)) {
      add(
        ln,
        'no-unguarded-null-deref-todo',
        'warning',
        'unfinished TODO/FIXME sits next to a member access; guard it or resolve it',
      );
    }

    // no-empty-catch --------------------------------------------------------
    for (const m of line.matchAll(CATCH_RE)) {
      const openCol = (m.index ?? 0) + m[0]!.length - 1;
      const close = findMatchingBrace(code, i, openCol);
      if (!close) continue;
      const body = rawBetween(raw, i, openCol + 1, close.line, close.col);
      if (body.trim() === '') {
        add(ln, 'no-empty-catch', 'error', 'empty catch block swallows the error; log it or rethrow');
      }
    }
  }

  return findings;
}

/** Turn `node --check` stderr into a single lint error finding. */
function syntaxFinding(rel: string, stderr: string): LintFinding {
  const lines = stderr.split(/\r?\n/);
  let line = 1;
  for (const l of lines) {
    const m = /:(\d+)$/.exec(l.trim());
    if (m) {
      line = Number(m[1]);
      break;
    }
  }
  const detail =
    lines.find((l) => /^[A-Za-z]*Error\b/.test(l.trim())) ?? collapse(stderr, 200) ?? 'syntax error';
  return {
    path: rel,
    line,
    rule: 'syntax',
    severity: 'error',
    message: collapse(detail, 300),
  };
}

// ---------------------------------------------------------------------------
// Reproduction driver
// ---------------------------------------------------------------------------

/**
 * Build the reproduction driver.
 *
 * The driver is an ES module (`.mjs`) so that dynamic `import()` can load both
 * ES modules and CommonJS, and so TypeScript sources work under Node's native
 * type stripping. It is written to the OS temp directory, never into the
 * repository, so the work tree stays clean.
 *
 * The entry point and the argument shape are resolved on the host side (see
 * `resolveEntryPoint`), because deciding them needs to read the source, and
 * doing it here would duplicate that logic inside a generated string.
 *
 * @param entry       resolved entry point
 * @param argumentJson JSON encoding of the argument to pass
 * @param moduleUrl   absolute file:// URL of the entry module
 */
function buildDriverSource(entry: EntryPoint, argumentJson: string, moduleUrl: string): string {
  const construct = entry.isClass ? `new mod.${entry.symbol}()` : `mod.${entry.symbol}`;
  const invoke = entry.isClass ? `subject.${entry.method}(ARGUMENT)` : `subject(ARGUMENT)`;
  return `/*
 * Firefighter reproduction driver (generated).
 * Prints exactly one JSON line describing the outcome.
 */
const ARGUMENT = ${argumentJson};

function safeValue(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}
function emit(out) { process.stdout.write(JSON.stringify(out) + '\\n'); }
function fail(err) {
  emit({
    threw: true,
    name: err && err.name ? String(err.name) : typeof err,
    message: err && err.message != null ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack) : null,
    result: null,
    entryPoint: ${JSON.stringify(`${entry.path}#${entry.method ?? entry.symbol}`)},
    entryError: null,
  });
}

let mod;
try {
  mod = await import(${JSON.stringify(moduleUrl)});
} catch (err) {
  emit({
    threw: false, name: null, message: null, stack: null, result: null,
    entryPoint: null,
    entryError: 'could not import ${entry.path}: ' + (err && err.message ? err.message : String(err)),
  });
  process.exit(0);
}

// A CommonJS module reached through import() exposes its exports on .default.
if (mod && mod.default && mod.${entry.symbol} === undefined) mod = mod.default;

if (mod.${entry.symbol} === undefined) {
  emit({
    threw: false, name: null, message: null, stack: null, result: null,
    entryPoint: null,
    entryError: '${entry.path} does not export ${entry.symbol}',
  });
  process.exit(0);
}

try {
  const subject = ${construct};
  const result = ${invoke};
  if (result && typeof result.then === 'function') {
    result.then(
      (value) => emit({ threw: false, name: null, message: null, stack: null, result: safeValue(value), entryPoint: ${JSON.stringify(`${entry.path}#${entry.method ?? entry.symbol}`)}, entryError: null }),
      fail,
    );
  } else {
    emit({ threw: false, name: null, message: null, stack: null, result: safeValue(result), entryPoint: ${JSON.stringify(`${entry.path}#${entry.method ?? entry.symbol}`)}, entryError: null });
  }
} catch (err) {
  fail(err);
}
`;
}

interface DriverOutcome {
  threw: boolean;
  name: string | null;
  message: string | null;
  stack: string | null;
  result: unknown;
  entryPoint: string | null;
  entryError: string | null;
}

/** Scan from the end for the driver's JSON line, ignoring module chatter. */
function extractOutcome(stdout: string): DriverOutcome | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.threw === 'boolean') {
        return {
          threw: parsed.threw,
          name: typeof parsed.name === 'string' ? parsed.name : null,
          message: typeof parsed.message === 'string' ? parsed.message : null,
          stack: typeof parsed.stack === 'string' ? parsed.stack : null,
          result: parsed.result ?? null,
          entryPoint: typeof parsed.entryPoint === 'string' ? parsed.entryPoint : null,
          entryError: typeof parsed.entryError === 'string' ? parsed.entryError : null,
        };
      }
    } catch {
      // Not the driver's line; keep scanning backwards.
    }
  }
  return null;
}

const STOPWORDS = new Set([
  'cannot', 'read', 'properties', 'property', 'reading', 'of', 'the', 'is', 'not',
  'error', 'type', 'null', 'undefined', 'from', 'with', 'for', 'value', 'object', 'this',
]);

/**
 * The parts of an error message worth matching on: quoted symbols if the
 * message has any (e.g. `'toUpperCase'`), otherwise its longest non-generic
 * words. Everything is lower-cased for comparison.
 */
function distinctiveParts(message: string): string[] {
  const quoted: string[] = [];
  for (const m of message.matchAll(/['"`]([^'"`]{2,})['"`]/g)) quoted.push(m[1]!.toLowerCase());
  if (quoted.length > 0) return quoted;
  const tokens = message
    .toLowerCase()
    .split(/[^a-z0-9_$.]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  tokens.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return tokens.slice(0, 2);
}

/** True when `actual` carries the distinctive part of the `expected` message. */
function messageMatches(expected: string, actual: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const e = norm(expected);
  const a = norm(actual);
  if (e === '') return true;
  if (a === '') return false;
  if (a.includes(e) || e.includes(a)) return true;
  const parts = distinctiveParts(expected);
  if (parts.length === 0) return false;
  return parts.every((p) => a.includes(p));
}

/** True when the thrown error's class matches the incident's `errorType`. */
function errorTypeMatches(expected: string, actual: string | null): boolean {
  const e = (expected ?? '').trim().toLowerCase();
  if (e === '') return true;
  const a = (actual ?? '').trim().toLowerCase();
  if (a === '') return false;
  return a === e || a.startsWith(`${e} `) || a.startsWith(`${e}[`) || a.startsWith(`${e}:`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Turn a user-supplied pattern into concrete argv entries for `node --test`.
 *
 * Node 22+ treats positional arguments as glob patterns and no longer expands
 * a bare directory, so a directory is expanded here into its sorted file list.
 * Globs and unresolvable patterns are handed to node untouched.
 */
function resolveTestTargets(cwd: string, pattern: string): string[] {
  if (GLOB_CHARS.test(pattern)) return [pattern];
  const abs = path.resolve(cwd, pattern);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [pattern];
  }
  if (stat.isFile()) return [path.relative(cwd, abs) || pattern];
  if (stat.isDirectory()) {
    const files = walkJsFiles(abs).map((f) => path.relative(cwd, f));
    return files.length > 0 ? files : [pattern];
  }
  return [pattern];
}

/**
 * Build the runner. There is one implementation: it executes the real toolchain
 * against a real working tree, which is what makes its verdicts trustworthy.
 *
 * Nothing here mutates the repository, so no safety guard is interposed: the
 * only binaries spawned are `node` (with an argv array, never a shell) and a
 * read-only `git ls-files`.
 *
 * @param cfg  configuration; defaults to the process-wide {@link config}.
 * @returns a {@link TestRunner} bound to that configuration.
 */
export function getTestRunner(cfg: Config = defaultConfig): TestRunner {
  const baseCwd = (opts?: RunOpts): string => path.resolve(opts?.cwd ?? cfg.demoRepoPath);

  return {
    provider: 'node-test',

    async runTests(opts: RunOpts = {}): Promise<TestRunResult> {
      const cwd = baseCwd(opts);
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
      const targets = resolveTestTargets(cwd, opts.pattern ?? DEFAULT_TEST_PATTERN);
      const args = ['--test', '--test-reporter=tap', ...targets];
      const started = nowMs();

      const res = await exec('node', args, { cwd, timeoutMs });
      const durationMs = nowMs() - started;
      const parsed = parseNodeTestOutput(res.stdout, res.stderr);

      const header = [`$ node ${args.join(' ')}`, `# cwd: ${cwd}`, `# exit: ${res.code}`, ''];
      const footer = res.timedOut ? [`\n[timed out after ${timeoutMs}ms]`] : [];
      const output = truncateTail([...header, res.stdout, res.stderr, ...footer].join('\n'));

      const ok = parsed.ok && res.code === 0 && !res.timedOut;
      log.debug(`runTests ${cwd}: ${parsed.passed}/${parsed.total} passed (exit ${res.code})`);
      return { ...parsed, ok, durationMs, output };
    },

    async runLint(opts: RunOpts = {}): Promise<LintResult> {
      const cwd = baseCwd(opts);
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

      const visible = await gitVisibleFiles(cwd);
      const files = walkJsFiles(cwd)
        .map((f) => path.relative(cwd, f))
        .filter((rel) => visible === null || visible.has(rel))
        .sort();

      // Layer 1: real syntax validation via the JavaScript engine itself.
      const syntax = await mapLimit(files, 8, async (rel) => {
        const res = await exec('node', ['--check', rel], {
          cwd,
          timeoutMs: Math.min(timeoutMs, SYNTAX_CHECK_TIMEOUT_MS),
        });
        return res.code === 0 ? null : syntaxFinding(rel, `${res.stderr}\n${res.stdout}`);
      });

      const findings: LintFinding[] = [];
      const broken = new Set<string>();
      for (const finding of syntax) {
        if (finding) {
          findings.push(finding);
          broken.add(finding.path);
        }
      }

      // Layer 2: text rules. Files that failed to parse are skipped — the
      // syntax error is the only finding worth reporting for them.
      for (const rel of files) {
        if (broken.has(rel)) continue;
        try {
          findings.push(...applyRules(rel, fs.readFileSync(path.join(cwd, rel), 'utf8')));
        } catch (err) {
          findings.push({
            path: rel,
            line: 1,
            rule: 'unreadable',
            severity: 'error',
            message: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      findings.sort(
        (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule),
      );
      const errors = findings.filter((f) => f.severity === 'error');
      const warnings = findings.filter((f) => f.severity === 'warning');

      const render = (f: LintFinding): string => `${f.path}:${f.line}  ${f.rule}  ${f.message}`;
      const lines: string[] = [`lint: node --check + rule engine over ${files.length} JavaScript file(s) in ${cwd}`, ''];
      if (errors.length > 0) lines.push('errors:', ...errors.map(render), '');
      if (warnings.length > 0) lines.push('warnings:', ...warnings.map(render), '');
      if (findings.length === 0) lines.push('no findings.', '');
      lines.push(
        `lint summary: ${errors.length} error(s), ${warnings.length} warning(s) across ${files.length} file(s) — ${errors.length === 0 ? 'PASS' : 'FAIL'}`,
      );

      log.debug(`runLint ${cwd}: ${errors.length} error(s), ${warnings.length} warning(s)`);
      return {
        ok: errors.length === 0,
        errors: errors.length,
        warnings: warnings.length,
        output: truncateTail(lines.join('\n')),
      };
    },

    async reproduce(incident: Incident, opts: RunOpts = {}): Promise<ReproResult> {
      const started = nowMs();
      const cwd = baseCwd(opts);
      const timeoutMs = opts.timeoutMs ?? DEFAULT_REPRO_TIMEOUT_MS;

      if (!incident.sampleRequest) {
        return {
          reproduced: false,
          matchedError: false,
          executed: false,
          command: '(not run)',
          durationMs: nowMs() - started,
          output:
            `Incident ${incident.id} carries no sampleRequest, so there is no production ` +
            'request to replay. Attach Incident.sampleRequest (method, path, body) to enable ' +
            'reproduction; falling back to the test suite as the only signal.',
        };
      }

      let driverPath = '';
      try {
        // Resolve the entry point against the tree being tested, so the same
        // incident can be replayed at any commit (this is what makes bisection
        // possible) rather than against one hard-coded module name.
        const readFile = (rel: string): string | null => {
          try {
            return fs.readFileSync(path.join(cwd, rel), 'utf8');
          } catch {
            return null;
          }
        };
        const entry: EntryPoint | null = resolveEntryPoint(readFile, incident.stackTrace, null);
        if (!entry) {
          return {
            reproduced: false,
            matchedError: false,
            executed: false,
            command: '(not run)',
            durationMs: nowMs() - started,
            output:
              `No callable entry point could be resolved in ${cwd} from the incident's stack trace. ` +
              'Reproduction needs a module that exports the failing function or its class.',
          };
        }

        const argument = callArgument(entry, incident.sampleRequest);
        const moduleUrl = pathToFileURL(path.resolve(cwd, entry.path)).href;
        const source = buildDriverSource(entry, JSON.stringify(argument, null, 2), moduleUrl);
        // Deterministic name (no Math.random): identical inputs reuse it.
        driverPath = path.join(os.tmpdir(), `ff-repro-${shortHash(`${incident.id}:${cwd}:${source}`)}.mjs`);
        fs.writeFileSync(driverPath, source, 'utf8');

        const res = await exec('node', [driverPath], { cwd, timeoutMs });
        const durationMs = nowMs() - started;
        const command = `node ${driverPath}  # cwd=${cwd}`;
        const outcome = extractOutcome(res.stdout);

        if (!outcome) {
          return {
            reproduced: false,
            matchedError: false,
            executed: false,
            command,
            durationMs,
            output: truncateTail(
              [
                `# cwd: ${cwd}`,
                `# exit: ${res.code}${res.timedOut ? ` (timed out after ${timeoutMs}ms)` : ''}`,
                'The reproduction driver produced no parseable outcome line.',
                '--- stdout ---',
                res.stdout,
                '--- stderr ---',
                res.stderr,
              ].join('\n'),
            ),
          };
        }

        if (outcome.entryError) {
          return {
            reproduced: false,
            matchedError: false,
            executed: false,
            command,
            durationMs,
            output: truncateTail([`# cwd: ${cwd}`, outcome.entryError, res.stderr].join('\n')),
          };
        }

        const matchedError =
          outcome.threw &&
          errorTypeMatches(incident.errorType, outcome.name) &&
          messageMatches(incident.errorMessage, outcome.message ?? '');
        const reproduced = outcome.threw && matchedError;

        const report: string[] = [
          `# cwd: ${cwd}`,
          `# entry point: ${outcome.entryPoint ?? 'unknown'}`,
          `# request: ${incident.sampleRequest.method} ${incident.sampleRequest.path}`,
          `# expected: ${incident.errorType}: ${incident.errorMessage}`,
          '',
        ];
        if (outcome.threw) {
          report.push(
            `threw: ${outcome.name ?? 'Error'}: ${outcome.message ?? ''}`,
            `error type matches: ${errorTypeMatches(incident.errorType, outcome.name)}`,
            `error message matches: ${messageMatches(incident.errorMessage, outcome.message ?? '')}`,
            '',
            '--- captured stack ---',
            outcome.stack ?? '(no stack captured)',
          );
        } else {
          report.push(
            'the request completed without throwing — the incident did not reproduce here.',
            `returned: ${collapse(JSON.stringify(outcome.result ?? null), 1200)}`,
          );
        }
        if (res.stderr.trim() !== '') report.push('', '--- stderr ---', res.stderr.trim());

        log.debug(`reproduce ${incident.id}: reproduced=${reproduced} matchedError=${matchedError}`);
        // The driver returned a parseable outcome, so the entry point ran.
        return {
          reproduced,
          matchedError,
          executed: true,
          command,
          durationMs,
          output: truncateTail(report.join('\n')),
        };
      } catch (err) {
        // reproduce() never throws: an infrastructure failure is a result too.
        return {
          reproduced: false,
          matchedError: false,
          executed: false,
          command: driverPath ? `node ${driverPath}` : '(not run)',
          durationMs: nowMs() - started,
          output: `reproduction could not run: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        };
      } finally {
        if (driverPath) {
          try {
            fs.rmSync(driverPath, { force: true });
          } catch {
            // Best-effort cleanup of a temp file; never fail a run over it.
          }
        }
      }
    },
  };
}
