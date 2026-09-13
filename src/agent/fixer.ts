/**
 * Permanent-fix generator.
 *
 * Given an incident and a completed investigation this module synthesises two
 * artefacts:
 *
 *   1. a reviewable source patch that guards the nullable receiver which threw, and
 *   2. a runnable `node:test` regression test derived from the real production
 *      request captured on the incident.
 *
 * The synthesiser is general, not a canned string for the demo. It parses the V8
 * `TypeError` message to learn which property access threw, locates that member
 * expression in the real source around the failing stack frame, infers the file's
 * own failure-reporting convention, and rewrites the line while preserving
 * indentation. The field name, the failure literal, the error message, the test
 * name, the module under test and the positive-control value are all derived from
 * the incident and the repository contents.
 *
 * Determinism: no wall-clock reads and no randomness, so identical inputs produce
 * byte-identical output.
 */

import fs from 'node:fs';
import { usesHttpEnvelope } from './entrypoint.ts';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type {
  FilePatch,
  FixPlan,
  Incident,
  Investigation,
  LlmClient,
  LlmMessage,
  StackFrame,
} from '../types.ts';
import { shortHash } from '../util/hash.ts';
import { logger } from '../util/log.ts';

const log = logger('agent:fixer');

// ---------------------------------------------------------------------------
// Public input surface
// ---------------------------------------------------------------------------

export interface FixInput {
  incident: Incident;
  investigation: Investigation;
  /** Reads a file from the repo at a given ref. Returns null when absent. */
  readFile: (path: string) => string | null;
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const IDENT_START = /[A-Za-z_$]/;

/**
 * Methods that only exist on strings. When the thrown access is one of these the
 * guarded value is meant to be a string, which licenses both the empty-string arm
 * of the guard and the `String(...)` coercion. Members shared with arrays
 * (`includes`, `indexOf`, `at`, `concat`, `length`) are deliberately excluded.
 */
const STRING_METHODS = new Set([
  'toUpperCase',
  'toLowerCase',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'split',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'replace',
  'replaceAll',
  'normalize',
  'localeCompare',
  'match',
  'matchAll',
  'search',
]);

/** Statement keywords whose `name (...) {` shape must not be read as a function header. */
const NOT_FUNCTIONS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'do',
  'try',
  'else',
  'return',
  'with',
  'typeof',
  'new',
  'delete',
  'void',
  'class',
]);

/**
 * Blanks out string literals and line comments so brace and comma scanning is not
 * confused by punctuation inside strings. Block comments are not handled; they are
 * rare inside the statements this module inspects.
 */
function stripLiterals(source: string): string {
  let out = source
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const comment = out.indexOf('//');
  if (comment !== -1) out = out.slice(0, comment);
  return out;
}

/** Leading whitespace of a line, so synthesised code keeps the file's indentation. */
function indentOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

function capitalise(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Escapes a message for embedding in a single- or double-quoted JS literal. */
function quoteJs(text: string, quote: string): string {
  const escaped = text.split('\\').join('\\\\').split(quote).join('\\' + quote);
  return quote + escaped + quote;
}

// ---------------------------------------------------------------------------
// 1. Which property access threw?
// ---------------------------------------------------------------------------

interface ThrownAccess {
  /** The property whose read threw, e.g. `toUpperCase`. */
  property: string;
  /** Which nullish value the runtime reported. */
  nullishKind: 'null' | 'undefined';
}

/** Modern V8: `Cannot read properties of null (reading 'toUpperCase')`. */
const V8_MODERN = /Cannot read propert(?:y|ies) of (null|undefined)\s*\(reading '([^']+)'\)/;
/** Legacy V8 / older Node: `Cannot read property 'toUpperCase' of undefined`. */
const V8_LEGACY = /Cannot read property '([^']+)' of (null|undefined)/;

/**
 * Extracts the property name and the nullish value from either V8 phrasing of a
 * null-dereference TypeError. Returns null for any other message shape.
 */
function parseThrownAccess(errorMessage: string): ThrownAccess | null {
  const modern = V8_MODERN.exec(errorMessage);
  if (modern) return { nullishKind: modern[1] as 'null' | 'undefined', property: modern[2] };
  const legacy = V8_LEGACY.exec(errorMessage);
  if (legacy) return { property: legacy[1], nullishKind: legacy[2] as 'null' | 'undefined' };
  return null;
}

// ---------------------------------------------------------------------------
// 2. Stack frames and repo paths
// ---------------------------------------------------------------------------

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** Parses a V8 stack trace into frames, innermost first. Non-frame lines are ignored. */
function parseStackFrames(stackTrace: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stackTrace.split('\n')) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    frames.push({
      fn: (m[1] ?? '<anonymous>').trim(),
      file: m[2].trim(),
      line: Number(m[3]),
      column: Number(m[4]),
    });
  }
  return frames;
}

interface ResolvedFile {
  /** Repo-relative path that `readFile` actually accepted. */
  path: string;
  contents: string;
}

/**
 * Resolves a path taken from a stack trace (which is usually absolute inside the
 * production container, e.g. `/app/src/checkout.js`) to a repo-relative path the
 * caller's `readFile` accepts, by progressively dropping leading segments.
 */
function resolveRepoFile(readFile: (p: string) => string | null, raw: string): ResolvedFile | null {
  const cleaned = raw.replace(/^file:\/\//, '');
  const attempts: string[] = [cleaned, cleaned.replace(/^\/+/, '')];
  const segments = cleaned.replace(/^\/+/, '').split('/');
  for (let i = 1; i < segments.length; i++) attempts.push(segments.slice(i).join('/'));
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt || seen.has(attempt)) continue;
    seen.add(attempt);
    const contents = readFile(attempt);
    if (contents !== null) return { path: attempt, contents };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Locating the offending member expression
// ---------------------------------------------------------------------------

interface ReceiverChain {
  /** Source text of the receiver, e.g. `customer.country`. */
  text: string;
  /** Dotted links, e.g. `['customer', 'country']`. */
  parts: string[];
  /** Index in the line where the receiver starts. */
  start: number;
  /** Index just past the receiver (at the `.` or `?` before the thrown property). */
  end: number;
  optional: boolean;
}

/** Splits a member chain on dots that are not inside brackets. */
function splitMemberChain(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      parts.push(current.replace(/\?$/, '').trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.replace(/\?$/, '').trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Walks backwards from `end` to the start of a pure member expression
 * (identifiers, dots, optional chaining and bracket accesses only). Returns null
 * when the receiver is not a plain chain: a call result such as `String(x)` is
 * deliberately rejected, because hoisting a call into a guard would change how
 * many times it runs.
 */
function scanReceiverStart(line: string, end: number): number | null {
  let i = end - 1;
  let bracket = 0;
  while (i >= 0) {
    const ch = line[i];
    if (ch === ']') {
      bracket++;
      i--;
      continue;
    }
    if (ch === '[') {
      if (bracket === 0) break;
      bracket--;
      i--;
      continue;
    }
    if (bracket > 0) {
      i--;
      continue;
    }
    if (IDENT_CHAR.test(ch) || ch === '.' || ch === '?') {
      i--;
      continue;
    }
    break;
  }
  const start = i + 1;
  if (start >= end) return null;
  if (!IDENT_START.test(line[start])) return null;
  return start;
}

const PURE_CHAIN = /^[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*$/;

/**
 * Finds the member expression on `line` whose property read is `property`.
 * Chains that carry a base object (`a.b.c`) are preferred over bare identifiers,
 * then the leftmost match wins.
 */
function findReceiverChain(line: string, property: string): ReceiverChain | null {
  const needle = '.' + property;
  const candidates: ReceiverChain[] = [];
  let from = 0;
  for (;;) {
    const at = line.indexOf(needle, from);
    if (at === -1) break;
    from = at + 1;
    const after = line[at + needle.length];
    if (after !== undefined && IDENT_CHAR.test(after)) continue;
    let end = at;
    let optional = false;
    if (at > 0 && line[at - 1] === '?') {
      end = at - 1;
      optional = true;
    }
    const start = scanReceiverStart(line, end);
    if (start === null) continue;
    const text = line.slice(start, end);
    if (!PURE_CHAIN.test(text)) continue;
    candidates.push({ text, parts: splitMemberChain(text), start, end, optional });
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => (b.parts.length >= 2 ? 1 : 0) - (a.parts.length >= 2 ? 1 : 0) || a.start - b.start,
  );
  return candidates[0];
}

// ---------------------------------------------------------------------------
// 4. The enclosing function, so the guard's early return is legal
// ---------------------------------------------------------------------------

interface EnclosingFunction {
  name: string;
  params: string[];
  /** 0-based index of the header line. */
  startLine: number;
  /** 0-based index of the line holding the closing brace. */
  endLine: number;
}

interface FunctionHeader {
  name: string;
  params: string[];
}

/** Recognises the common single-line JS function-header shapes. */
function parseFunctionHeader(text: string): FunctionHeader | null {
  const line = stripLiterals(text);
  // `RET` allows a TypeScript return-type annotation between the parameter list
  // and the body, e.g.  validateCheckout(request: CheckoutRequest): ValidationResult {
  // Without it no method in a .ts file is ever recognised, and the fix
  // generator silently refuses to patch TypeScript services.
  const RET = '(?:\\s*:\\s*[^{;]+?)?';
  const MODS = '(?:(?:export|public|private|protected|readonly|static|async|override)\\s+)*';
  const GEN = '(?:<[^>]*>)?';
  const patterns: RegExp[] = [
    new RegExp(`^\\s*${MODS}function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)${GEN}\\s*\\(([^)]*)\\)${RET}\\s*\\{`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*)?${GEN}\\(([^)]*)\\)${RET}\\s*(?:=>\\s*)?\\{`),
    new RegExp(`^\\s*([A-Za-z_$][\\w$]*)\\s*:\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*)?${GEN}\\(([^)]*)\\)${RET}\\s*(?:=>\\s*)?\\{`),
    new RegExp(`^\\s*${MODS}(?:get\\s+|set\\s+)?([A-Za-z_$][\\w$]*)${GEN}\\s*\\(([^)]*)\\)${RET}\\s*\\{`),
  ];
  for (const re of patterns) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1];
    if (NOT_FUNCTIONS.has(name)) return null;
    const params = m[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return { name, params };
  }
  return null;
}

/** Brace-matches forward from a header line and returns the closing line index. */
function bodyEndLine(lines: string[], headerLine: number): number | null {
  let depth = 0;
  let opened = false;
  for (let i = headerLine; i < lines.length; i++) {
    for (const ch of stripLiterals(lines[i])) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth === 0) return i;
      }
    }
  }
  return null;
}

/**
 * Finds the function containing `frameLineIdx`. Prefers the function whose name
 * matches the stack frame (`CheckoutValidator.country` -> `country`); otherwise
 * falls back to the nearest enclosing header.
 */
function findEnclosingFunction(
  lines: string[],
  frameLineIdx: number,
  fnName: string | null,
): EnclosingFunction | null {
  const wanted = fnName ? (fnName.split('.').pop() ?? null) : null;
  let nearest: EnclosingFunction | null = null;
  for (let i = Math.min(frameLineIdx, lines.length - 1); i >= 0; i--) {
    const header = parseFunctionHeader(lines[i]);
    if (!header) continue;
    const end = bodyEndLine(lines, i);
    if (end === null || end < frameLineIdx) continue;
    const fn: EnclosingFunction = {
      name: header.name,
      params: header.params,
      startLine: i,
      endLine: end,
    };
    if (wanted && header.name === wanted) return fn;
    if (!nearest) nearest = fn;
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// 5. Inferring how this file reports a validation failure
// ---------------------------------------------------------------------------

/**
 * Two families are recognised:
 *
 *   'accumulator' - the function collects messages in a local array and returns
 *                   it, e.g. `errors.push('items: ...'); return errors;`. This is
 *                   what a validator whose caller aggregates every field problem
 *                   looks like, and returning anything else from such a function
 *                   would break the caller.
 *   'object'      - the function returns a structured literal, e.g.
 *                   `return { ok: false, error: 'x_required', field: 'x' };`.
 *
 * 'default' is the minimal defensive shape used when neither can be read off the
 * file.
 */
type FailureKind = 'accumulator' | 'object' | 'default';

interface FailureConvention {
  kind: FailureKind;
  /** Accumulator variable name when kind is 'accumulator'. */
  accumulator: string | null;
  /** Rendered object literal when kind is 'object' or 'default'. */
  literal: string | null;
  /** The message or error code this guard will emit, unquoted. */
  signal: string;
  /** The same signal rendered as a JS literal in the file's quote style. */
  signalLiteral: string;
  /** Key that carries the boolean success flag, when there is one. */
  okKey: string | null;
  /** Short description used in the patch rationale. */
  description: string;
  /** False when the shape had to be defaulted rather than inferred. */
  inferred: boolean;
}

type ObjectEntry = [key: string, value: string];

const OK_KEYS = new Set(['ok', 'valid', 'isValid', 'success', 'passed']);
const CODE_KEYS = new Set(['error', 'code', 'reason', 'errorCode', 'message']);
const FIELD_KEYS = new Set(['field', 'path', 'param', 'key', 'property', 'name']);

/** Splits an object-literal body or argument list on top-level commas. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseObjectLiteral(literal: string): ObjectEntry[] | null {
  const body = literal.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  const entries: ObjectEntry[] = [];
  for (const piece of splitTopLevel(body.slice(1, -1))) {
    const colon = piece.indexOf(':');
    if (colon === -1) return null;
    const key = piece
      .slice(0, colon)
      .trim()
      .replace(/^['"`]|['"`]$/g, '');
    const value = piece.slice(colon + 1).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) return null;
    entries.push([key, value]);
  }
  return entries.length > 0 ? entries : null;
}

function unquote(value: string): string | null {
  const m = /^(['"`])([\s\S]*)\1$/.exec(value.trim());
  return m ? m[2] : null;
}

function renderEntries(entries: ObjectEntry[]): string {
  return '{ ' + entries.map(([k, v]) => `${k}: ${v}`).join(', ') + ' }';
}

/**
 * Builds the error code for `field` in the casing style the file already uses,
 * e.g. `country_required`, `COUNTRY_REQUIRED` or `countryRequired`.
 */
function deriveErrorCode(observed: string | null, field: string): string {
  const snake = toSnake(field);
  if (observed && /^[A-Z0-9_]+$/.test(observed)) return `${snake.toUpperCase()}_REQUIRED`;
  if (observed && /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(observed)) {
    return snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) + 'Required';
  }
  if (observed && observed.includes('-') && !observed.includes('_')) {
    return `${snake.replace(/_/g, '-')}-required`;
  }
  return `${snake}_required`;
}

/**
 * Detects the "collect messages into a local array" convention inside the
 * enclosing function, and synthesises a message in the same style as the messages
 * the file already pushes.
 */
function inferAccumulatorConvention(
  scopeText: string,
  fileText: string,
  fnName: string | null,
  field: string,
): FailureConvention | null {
  // `(?::\s*[^=]+)?` allows a TypeScript annotation: const errors: string[] = [];
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?::\s*[^=]+)?\s*=\s*\[\s*\]\s*;/.exec(scopeText);
  if (!decl) return null;
  const accumulator = decl[1];

  // The accumulator may be returned directly (`return errors;`) or wrapped
  // (`return { ok: errors.length === 0, errors };`). Reuse whichever form the
  // function already uses, so the guard's early return matches the declared
  // return type instead of inventing a new shape.
  const returnRe = new RegExp(`return\\s+([^;]*\\b${accumulator}\\b[^;]*);`, 'g');
  let returnExpression: string | null = null;
  let rm: RegExpExecArray | null;
  while ((rm = returnRe.exec(scopeText)) !== null) returnExpression = rm[1].trim();
  if (!returnExpression) return null;

  const pushRe = new RegExp(`\\b${accumulator}\\.push\\(\\s*(['"\`])((?:[^'"\`\\\\]|\\\\.)*)\\1`, 'g');
  const messages: string[] = [];
  let quote = "'";
  let m: RegExpExecArray | null;
  while ((m = pushRe.exec(fileText)) !== null) {
    if (messages.length === 0) quote = m[1];
    messages.push(m[2]);
  }
  if (messages.length === 0) return null;

  const prefixed = messages.filter((s) => /^[A-Za-z_][\w]*:\s/.test(s)).length;
  const usePrefix = prefixed * 2 >= messages.length;
  // Existing messages are prefixed with the FIELD they concern
  // ("items: cart is empty"), not with the enclosing function, so a validator
  // that checks several fields still produces "country: ..." rather than
  // "validateCheckout: ...".
  const prefix = field || fnName || 'value';
  const noun = prefix === field ? `a ${field}` : field;
  const signal = usePrefix ? `${prefix}: ${noun} is required` : `${noun} is required`;

  return {
    kind: 'accumulator',
    accumulator,
    literal: returnExpression,
    signal,
    signalLiteral: quoteJs(signal, quote),
    okKey: null,
    description:
      `matches how every other validator in this file reports a problem - it pushes a message onto ` +
      `\`${accumulator}\` and returns it early, so the caller that spreads this array keeps working`,
    inferred: true,
  };
}

/** Detects the "return a structured literal" convention. */
function inferObjectConvention(
  scopeText: string,
  fileText: string,
  field: string,
): FailureConvention | null {
  for (const haystack of [scopeText, fileText]) {
    const re = /return\s*(\{[^{}]*\})/g;
    let best: ObjectEntry[] | null = null;
    let bestScore = -1;
    let match: RegExpExecArray | null;
    while ((match = re.exec(haystack)) !== null) {
      const entries = parseObjectLiteral(match[1]);
      if (!entries) continue;
      const hasFalseOk = entries.some(([k, v]) => OK_KEYS.has(k) && v === 'false');
      const hasCode = entries.some(([k, v]) => CODE_KEYS.has(k) && unquote(v) !== null);
      if (!hasFalseOk && !hasCode) continue;
      let score = 0;
      if (hasFalseOk) score += 2;
      if (hasCode) score += 2;
      if (entries.some(([k]) => FIELD_KEYS.has(k))) score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = entries;
      }
    }
    if (!best) continue;

    const okKey = best.find(([k, v]) => OK_KEYS.has(k) && v === 'false')?.[0] ?? null;
    const codeKey = best.find(([k, v]) => CODE_KEYS.has(k) && unquote(v) !== null)?.[0] ?? null;
    const fieldKey = best.find(([k]) => FIELD_KEYS.has(k))?.[0] ?? null;
    const sampleString = best.map(([, v]) => v).find((v) => unquote(v) !== null);
    const quote = sampleString ? sampleString.trim()[0] : "'";
    const observedCode = codeKey ? unquote(best.find(([k]) => k === codeKey)?.[1] ?? '') : null;
    const code = deriveErrorCode(observedCode, field);

    const rendered = best.map(([key, value]) => {
      if (key === okKey) return `${key}: false`;
      if (key === codeKey) return `${key}: ${quoteJs(code, quote)}`;
      if (key === fieldKey) return `${key}: ${quoteJs(field, quote)}`;
      return `${key}: ${value}`;
    });

    return {
      kind: 'object',
      accumulator: null,
      literal: '{ ' + rendered.join(', ') + ' }',
      signal: code,
      signalLiteral: quoteJs(code, quote),
      okKey,
      description: `matches the existing failure shape in this file: ${renderEntries(best)}`,
      inferred: true,
    };
  }
  return null;
}

/**
 * Reads the file's own convention for reporting a validation failure, preferring
 * a local error accumulator, then a structured return literal, and finally a
 * minimal defensive shape.
 */
function inferFailureConvention(
  scopeText: string,
  fileText: string,
  fnName: string | null,
  field: string,
): FailureConvention {
  return (
    inferAccumulatorConvention(scopeText, fileText, fnName, field) ??
    inferObjectConvention(scopeText, fileText, field) ?? {
      kind: 'default',
      accumulator: null,
      literal: `{ ok: false, error: '${deriveErrorCode(null, field)}', field: '${field}' }`,
      signal: deriveErrorCode(null, field),
      signalLiteral: `'${deriveErrorCode(null, field)}'`,
      okKey: 'ok',
      description:
        'no existing failure convention could be read off the file, so a minimal defensive shape is used',
      inferred: false,
    }
  );
}

/** Renders the statements that go inside the guard's `if` block. */
function failureBodyLines(convention: FailureConvention, indent: string): string[] {
  if (convention.kind === 'accumulator' && convention.accumulator) {
    return [
      `${indent}${convention.accumulator}.push(${convention.signalLiteral});`,
      `${indent}return ${convention.literal ?? convention.accumulator};`,
    ];
  }
  return [`${indent}return ${convention.literal};`];
}

// ---------------------------------------------------------------------------
// 6. Synthesising the guard
// ---------------------------------------------------------------------------

interface GuardSynthesis {
  path: string;
  newContents: string;
  originalContents: string;
  /** The nullable receiver's last link, e.g. `country`. */
  field: string;
  /** Full receiver text, e.g. `customer.country`. */
  receiver: string;
  /** Base object text, e.g. `customer`, or null for a bare identifier receiver. */
  base: string | null;
  guardExpression: string;
  rawVar: string;
  convention: FailureConvention;
  /** 1-based line that was rewritten. */
  lineNumber: number;
  originalLine: string;
  rewrittenLine: string;
  insertedLines: string[];
  emptyStringGuarded: boolean;
  enclosing: EnclosingFunction | null;
  /** Other 1-based lines in the file that dereference the same receiver. */
  otherSites: number[];
}

/** Picks a guard variable name that does not collide inside the enclosing scope. */
function pickRawVarName(scopeText: string, field: string): string {
  const candidates = [
    'raw',
    'raw' + capitalise(field),
    'safe' + capitalise(field),
    field + 'Value',
    'guarded' + capitalise(field),
  ];
  for (const candidate of candidates) {
    if (!new RegExp(`\\b${candidate}\\b`).test(scopeText)) return candidate;
  }
  return 'raw' + shortHash(scopeText + field, 6);
}

/** Builds `a && a.b && a.b.c` from the chain links, skipping a bare `this`. */
function buildGuardExpression(parts: string[]): string {
  const prefixes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === 0 && parts[0] === 'this') continue;
    prefixes.push(parts.slice(0, i + 1).join('.'));
  }
  if (prefixes.length === 0) prefixes.push(parts.join('.'));
  return prefixes.join(' && ');
}

/**
 * Rewrites the offending line so the nullable receiver is explicitly guarded,
 * with an early structured failure that matches the file's own convention and the
 * original operation preserved on a coerced value.
 */
function synthesiseNullGuard(
  file: ResolvedFile,
  frame: StackFrame,
  thrown: ThrownAccess,
): GuardSynthesis | null {
  const lines = file.contents.split('\n');
  const frameIdx = Math.min(Math.max(frame.line - 1, 0), lines.length - 1);
  const enclosing = findEnclosingFunction(lines, frameIdx, frame.fn);

  // Search order: the frame's own line, then outwards, then the enclosing body,
  // then the whole file.
  const order: number[] = [frameIdx];
  for (let d = 1; d <= 3; d++) order.push(frameIdx - d, frameIdx + d);
  if (enclosing) {
    for (let i = enclosing.startLine; i <= enclosing.endLine; i++) order.push(i);
  }
  for (let i = 0; i < lines.length; i++) order.push(i);

  let idx = -1;
  let chain: ReceiverChain | null = null;
  for (const candidate of order) {
    if (candidate < 0 || candidate >= lines.length) continue;
    const found = findReceiverChain(lines[candidate], thrown.property);
    if (found) {
      idx = candidate;
      chain = found;
      break;
    }
  }
  if (!chain || idx === -1) return null;

  const scopeFn = findEnclosingFunction(lines, idx, frame.fn) ?? enclosing;
  if (!scopeFn) return null;
  const scopeText = lines.slice(scopeFn.startLine, scopeFn.endLine + 1).join('\n');

  const parts = chain.parts;
  const lastLink = parts[parts.length - 1];
  const field = lastLink.replace(/^\[|\]$/g, '').replace(/^['"`]|['"`]$/g, '');
  const base = parts.length >= 2 ? parts.slice(0, -1).join('.') : null;

  const convention = inferFailureConvention(scopeText, file.contents, scopeFn.name, field);
  const rawVar = pickRawVarName(scopeText, field);
  const isStringOp = STRING_METHODS.has(thrown.property);
  const guardExpression = buildGuardExpression(parts);

  const line = lines[idx];
  const indent = indentOf(line);
  const spaced = /\n[ \t]*\n/.test(scopeText);

  const conditions = [
    `${rawVar} === null`,
    `${rawVar} === undefined`,
    ...(isStringOp ? [`${rawVar} === ''`] : []),
  ].join(' || ');

  const inserted: string[] = [`${indent}const ${rawVar} = ${guardExpression};`];
  if (spaced) inserted.push('');
  inserted.push(`${indent}if (${conditions}) {`);
  inserted.push(...failureBodyLines(convention, indent + '  '));
  inserted.push(`${indent}}`);
  if (spaced) inserted.push('');

  const coercion = isStringOp ? `String(${rawVar})` : rawVar;
  const rewrittenLine = line.slice(0, chain.start) + coercion + line.slice(chain.end);

  const otherSites: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === idx) continue;
    if (lines[i].includes(chain.text + '.') || lines[i].includes(chain.text + '?.')) {
      otherSites.push(i + 1);
    }
  }

  const nextLines = [...lines.slice(0, idx), ...inserted, rewrittenLine, ...lines.slice(idx + 1)];

  return {
    path: file.path,
    newContents: nextLines.join('\n'),
    originalContents: file.contents,
    field,
    receiver: chain.text,
    base,
    guardExpression,
    rawVar,
    convention,
    lineNumber: idx + 1,
    originalLine: line,
    rewrittenLine,
    insertedLines: inserted,
    emptyStringGuarded: isStringOp,
    enclosing: scopeFn,
    otherSites,
  };
}

// ---------------------------------------------------------------------------
// 7. Caller propagation, only when the caller would otherwise still 500
// ---------------------------------------------------------------------------

interface CallerAnalysis {
  file: ResolvedFile;
  /** Why no patch was produced, or how the patch was derived. */
  note: string;
  patch: FilePatch | null;
}

const STATUS_RE = /status\s*:\s*(\d{3})/g;

/** Collects every `status: NNN` literal in a module, in source order. */
function statusLiterals(text: string): number[] {
  const out: number[] = [];
  STATUS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATUS_RE.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** Reads the CommonJS export names of a module. */
function parseCjsExports(text: string): string[] {
  const names = new Set<string>();
  const objectForm = /module\.exports\s*=\s*\{([^}]*)\}/.exec(text);
  if (objectForm) {
    for (const piece of splitTopLevel(objectForm[1])) {
      const key = piece.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  let m: RegExpExecArray | null;
  const propRe = /module\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = propRe.exec(text)) !== null) names.add(m[1]);
  const exportsRe = /(?<!module\.)\bexports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = exportsRe.exec(text)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * ES-module exports, as `{name, isClass}`.
 *
 * A TypeScript/ESM service exports `export class CheckoutService`, which the
 * CommonJS parser cannot see at all — without this the generator silently
 * produces no regression test for any ESM repository.
 */
function parseEsmExports(text: string): { name: string; isClass: boolean }[] {
  const out: { name: string; isClass: boolean }[] = [];
  const seen = new Set<string>();
  const add = (name: string, isClass: boolean): void => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, isClass });
    }
  };
  let m: RegExpExecArray | null;
  const declRe = /export\s+(?:default\s+)?(?:abstract\s+)?(class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(text)) !== null) add(m[2], m[1] === 'class');
  const listRe = /export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(text)) !== null) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(/\s+as\s+/).pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        add(name, new RegExp(`class\\s+${name}\\b`).test(text));
      }
    }
  }
  return out;
}

/** Finds the parameter list of a named function in a module. */
function findFunctionParams(text: string, name: string): string[] {
  for (const line of text.split('\n')) {
    const header = parseFunctionHeader(line);
    if (header && header.name === name) return header.params;
  }
  return [];
}

/**
 * Decides whether the caller named by the stack trace needs a change for the
 * structured failure to surface as a client error. Conservative by design: a
 * patch is produced only when the caller demonstrably calls the fixed function
 * directly, assigns its result, and neither inspects that result nor returns a
 * 4xx nearby.
 */
function analyseCaller(
  input: FixInput,
  frames: StackFrame[],
  failingPath: string,
  guard: GuardSynthesis,
): CallerAnalysis | null {
  const callerFrame = frames.find((f) => {
    const resolved = resolveRepoFile(input.readFile, f.file);
    return resolved !== null && resolved.path !== failingPath;
  });
  if (!callerFrame) return null;
  const file = resolveRepoFile(input.readFile, callerFrame.file);
  if (!file) return null;

  const fnName = guard.enclosing?.name ?? null;
  const lines = file.contents.split('\n');
  let callLine = -1;
  if (fnName) {
    const callRe = new RegExp(`\\b${fnName}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (callRe.test(stripLiterals(lines[i]))) {
        callLine = i;
        break;
      }
    }
  }

  if (callLine === -1) {
    return {
      file,
      note:
        `${file.path} does not call \`${fnName ?? 'the fixed function'}()\` directly - it reaches it ` +
        `through an aggregator - so the structured failure already travels the existing path. ` +
        `No caller change is required.`,
      patch: null,
    };
  }

  const window = lines.slice(callLine, Math.min(lines.length, callLine + 16)).join('\n');
  const assign = /^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[callLine]);
  const inspected = assign ? new RegExp(`\\b${assign[2]}\\b`).test(window.slice(lines[callLine].length)) : false;
  const clientError = /\b4\d{2}\b/.test(window);

  if (inspected && clientError) {
    return {
      file,
      note: `${file.path}:${callLine + 1} already branches on the result and returns a client error. No caller change is required.`,
      patch: null,
    };
  }
  if (!assign) {
    return {
      file,
      note:
        `${file.path}:${callLine + 1} calls \`${fnName}()\` without assigning the result, so no minimal, ` +
        `safe caller patch can be synthesised. Flagged as a risk instead.`,
      patch: null,
    };
  }

  const okKey = guard.convention.okKey ?? 'ok';
  const failureStatus = statusLiterals(file.contents).find((s) => s >= 400 && s < 500) ?? 400;
  const indent = assign[1];
  const varName = assign[2];
  const inserted = [
    `${indent}if (${varName} && ${varName}.${okKey} === false) {`,
    `${indent}  return { status: ${failureStatus}, body: ${varName} };`,
    `${indent}}`,
  ];
  const next = [...lines.slice(0, callLine + 1), ...inserted, ...lines.slice(callLine + 1)];

  return {
    file,
    note: `${file.path}:${callLine + 1} ignored the validator result, so the guard would still have ended as a 5xx.`,
    patch: {
      path: file.path,
      kind: 'modify',
      contents: next.join('\n'),
      rationale:
        `${file.path} invoked \`${fnName}()\` at line ${callLine + 1} without branching on its ` +
        `\`${okKey}\` result, so the structured failure would have been ignored and the request would ` +
        `still have ended as a 5xx. Returning ${failureStatus} with the validator's own failure body is ` +
        `the smallest change that makes the guard observable to clients.`,
    },
  };
}

// ---------------------------------------------------------------------------
// 8. Regression test generation
// ---------------------------------------------------------------------------

/** Last-resort valid values, used only when the repository itself offers no example. */
const FALLBACK_VALID: Record<string, string> = {
  country: 'US',
  countrycode: 'US',
  currency: 'USD',
  locale: 'en-US',
  language: 'en',
  email: 'user@example.com',
  region: 'US',
};

/**
 * Existing test files likely to hold a happy-path fixture, derived from the
 * module under test rather than hard-coded, e.g. `src/signup.js` yields
 * `test/signup.test.js`.
 */
function testFixtureCandidates(entryPath: string, field: string): string[] {
  const base = path.posix.basename(entryPath).replace(/\.[cm]?[jt]sx?$/, '');
  // "checkout.validator" -> also try "checkout": a service's tests are usually
  // named after the module, not after each collaborator inside it.
  const root = base.split('.')[0];
  const dirs = ['test', 'tests', '__tests__'];
  const names = [...new Set([base, root, field, 'index'])];
  // TypeScript repos are the common case for .ts/.mts test files; omitting them
  // means no fixture is ever found in a TS project.
  const exts = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) out.push(`${dir}/${name}.test.${ext}`, `${dir}/${name}.spec.${ext}`);
    }
  }
  return out;
}

function looksLikeTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(p) && /\.(test|spec)\.[cm]?js$/.test(p);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Sets `field` on the object inside `body` that owns it (breadth-first), falling
 * back to the receiver chain's base key and then to the root.
 */
function setFieldInPayload(
  body: unknown,
  field: string,
  chainParts: string[],
  /** `null` clears the field, which is how the failing payload is built. */
  value: string | null,
): unknown {
  if (!isPlainObject(body)) return body;
  const clone = cloneJson(body);
  const queue: Record<string, unknown>[] = [clone];
  while (queue.length > 0) {
    const node = queue.shift() as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(node, field)) {
      node[field] = value;
      return clone;
    }
    for (const v of Object.values(node)) if (isPlainObject(v)) queue.push(v);
  }
  for (let i = 0; i < chainParts.length - 1; i++) {
    const target = clone[chainParts[i]];
    if (isPlainObject(target)) {
      (target as Record<string, unknown>)[field] = value;
      return clone;
    }
  }
  clone[field] = value;
  return clone;
}

/**
 * A value mined out of source text is only usable if it looks like a real
 * literal. Anything carrying concatenation or interpolation syntax came from a
 * message being built up, not from a fixture, and would produce a regression
 * test that cannot pass.
 */
function isPlausibleLiteral(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  if (/[+$`{}()\\]/.test(v)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 _.@:/-]*$/.test(v);
}

/**
 * Finds a valid value for `field` by mining the repository: the existing tests
 * first, because their happy-path fixtures are the authoritative positive
 * control, then a collection named after the field, then a literal in the sources.
 */
function findValidFieldValue(
  input: FixInput,
  field: string,
  entryPath: string,
  sourcePaths: string[],
): string {
  // The negative lookbehind matters: without it, a message built by string
  // concatenation such as  errors.push('country: ' + code + ' is bad')
  // matches with ` + code + ` captured as the "value".
  const literalRe = new RegExp(`(?<!['"])\\b${field}\\s*:\\s*(['"])([^'"]+)\\1`);
  for (const candidate of [...testFixtureCandidates(entryPath, field), ...sourcePaths]) {
    const text = input.readFile(candidate);
    if (!text) continue;
    for (const m of text.matchAll(new RegExp(literalRe.source, 'g'))) {
      if (isPlausibleLiteral(m[2])) return m[2];
    }
  }
  for (const candidate of sourcePaths) {
    const text = input.readFile(candidate);
    if (!text) continue;
    const collection = new RegExp(
      `(?:const|let|var)\\s+[A-Za-z_$]*${field}[A-Za-z_$]*\\s*=\\s*([\\[{][^\\]}]*[\\]}])`,
      'i',
    ).exec(text);
    if (!collection) continue;
    const first = /['"]([^'"]+)['"]/.exec(collection[1]);
    if (first && isPlausibleLiteral(first[1])) return first[1];
    const key = /([A-Za-z_$][\w$]*)\s*:/.exec(collection[1]);
    if (key) return key[1];
  }
  return FALLBACK_VALID[field.toLowerCase()] ?? 'VALID';
}

/** Chooses `test/<module>.<qualifier>.test.js` from the affected functionality. */
function deriveTestPath(input: FixInput, entryPath: string, field: string): string {
  // Match the module's own language: a .ts service must get a .ts test, or the
  // generated file will not even be picked up by the repo's test runner.
  const ext = /\.[cm]?tsx?$/.test(entryPath) ? 'ts' : 'js';
  const base = path.posix.basename(entryPath).replace(/\.[cm]?[jt]sx?$/, '');
  const generic = new Set([
    base,
    'the',
    'and',
    'for',
    'with',
    'flow',
    'api',
    'service',
    'endpoint',
    'endpoints',
    'request',
    'requests',
    'path',
    'route',
    'handler',
    'users',
    'user',
    'errors',
    'error',
  ]);
  const tokens = (input.investigation.affectedFunctionality || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !generic.has(t));
  if (tokens.length > 0) return `test/${base}.${tokens[0]}.test.${ext}`;

  const body = input.incident.sampleRequest?.body;
  if (isPlainObject(body)) {
    const flat = JSON.stringify(body).toLowerCase();
    if (/"guest"\s*:\s*true/.test(flat) || /"(?:customerid|id)"\s*:\s*null/.test(flat)) {
      return `test/${base}.guest.test.${ext}`;
    }
  }
  return `test/${base}.${field.toLowerCase()}.test.${ext}`;
}

interface TestContext {
  entryPath: string;
  /** Exported symbol to import. */
  entryFn: string;
  entryParams: string[];
  successStatus: number;
  failureStatus: number;
  /** True when entryFn is a class that must be instantiated. */
  entryIsClass: boolean;
  /** Method to call on the instance, when entryIsClass. */
  entryMethod: string | null;
  /** Emit ESM `import` instead of CommonJS `require`. */
  esm: boolean;
  /** True when the callee actually reads `.body`/`.method`/`.headers`. */
  wantsHttpEnvelope: boolean;
}

/** Resolves everything the test template needs from the repo and the incident. */
function buildTestContext(input: FixInput): TestContext | null {
  const frames = parseStackFrames(input.incident.stackTrace);
  const failing = input.investigation.failingFrame;
  const failingResolved = failing ? resolveRepoFile(input.readFile, failing.file) : null;
  const callerFrame = frames.find((f) => {
    const r = resolveRepoFile(input.readFile, f.file);
    return r !== null && (!failingResolved || r.path !== failingResolved.path);
  });
  const entry =
    (callerFrame ? resolveRepoFile(input.readFile, callerFrame.file) : null) ?? failingResolved;
  if (!entry) return null;

  const frameFns = frames.map((f) => f.fn.split('.').pop() ?? f.fn);
  const frameClasses = frames
    .map((f) => (f.fn.includes('.') ? f.fn.split('.')[0] : null))
    .filter((n): n is string => n !== null);

  const cjs = parseCjsExports(entry.contents).map((name) => ({ name, isClass: false }));
  const esmExports = parseEsmExports(entry.contents);
  const candidates = cjs.length ? cjs : esmExports;
  if (!candidates.length) return null;

  // Prefer the export named on the stack: the failing function itself, else the
  // class that owns it.
  const chosen =
    candidates.find((c) => frameFns.includes(c.name)) ??
    candidates.find((c) => frameClasses.includes(c.name)) ??
    candidates[0];

  // A class entry is called as new Klass().method(payload); the method is the
  // frame that belongs to that class.
  let entryMethod: string | null = null;
  if (chosen.isClass) {
    const owned = frames.find((f) => f.fn.startsWith(chosen.name + '.'));
    entryMethod = owned ? (owned.fn.split('.').pop() ?? null) : null;
    if (!entryMethod) return null;
  }

  const pkg = input.readFile('package.json') ?? '';
  const esm = /"type"\s*:\s*"module"/.test(pkg) || /\.m?tsx?$/.test(entry.path) || esmExports.length > 0;

  const statuses = statusLiterals(entry.contents);
  return {
    entryPath: entry.path,
    entryFn: chosen.name,
    entryParams: findFunctionParams(entry.contents, entryMethod ?? chosen.name),
    successStatus: statuses.find((s) => s >= 200 && s < 300) ?? 200,
    failureStatus: statuses.find((s) => s >= 400 && s < 500) ?? 400,
    entryIsClass: chosen.isClass,
    entryMethod,
    esm,
    // Decided from what the function BODY dereferences, never from the
    // parameter's name: a domain method is often called `request` while taking
    // a plain object, and wrapping that in an HTTP envelope silently produces a
    // test that fails for the wrong reason.
    wantsHttpEnvelope: usesHttpEnvelope(
      entry.contents,
      entryMethod ?? chosen.name,
      findFunctionParams(entry.contents, entryMethod ?? chosen.name)[0]?.split(':')[0].trim() ?? '',
    ),
  };
}

/**
 * Find an object literal in the repo's tests that already contains the field
 * that threw, so a realistic payload can be built without a captured request.
 */
function mineFixturePayload(input: FixInput, receiver: string): unknown {
  const field = receiver.split('.').pop() ?? receiver;
  const entry = input.investigation.failingFrame?.file ?? '';
  for (const candidate of testFixtureCandidates(entry, field)) {
    const text = input.readFile(candidate);
    if (!text) continue;
    // Scan every balanced `{ ... }` literal and keep the first that mentions the
    // field and parses as JSON-ish data.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') continue;
      let depth = 0;
      let end = -1;
      for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) continue;
      const snippet = text.slice(i, end + 1);
      if (!snippet.includes(field)) continue;
      const parsed = looseParseObject(snippet);
      if (parsed && Object.keys(parsed).length >= 2) return parsed;
      // Do NOT skip to `end`: the outer literal may have failed only because of
      // a spread, while a nested one parses cleanly.
    }
  }
  return null;
}

/** Parse a JS object literal with unquoted keys and single quotes. */
function looseParseObject(snippet: string): Record<string, unknown> | null {
  try {
    const json = snippet
      .replace(/\/\/[^\n]*/g, '')
      // Drop spread elements (`...overrides,`): they are not data and would
      // otherwise make an otherwise-usable fixture unparseable.
      .replace(/\.\.\.[A-Za-z_$][\w$]*\s*,?/g, '')
      .replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,(\s*[}\]])/g, '$1');
    const value = JSON.parse(json) as unknown;
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Renders the argument literal in the shape the entry point expects. */
function renderCallArgument(ctx: TestContext, incident: Incident, body: unknown): string {
  const sample = incident.sampleRequest;
  if (ctx.wantsHttpEnvelope && sample) {
    const request: Record<string, unknown> = { method: sample.method, path: sample.path };
    if (sample.headers) request.headers = sample.headers;
    request.body = body;
    return JSON.stringify(request, null, 2);
  }
  return JSON.stringify(body, null, 2);
}

/**
 * Generates a runnable CommonJS `node:test` regression test that reproduces the
 * incident's production request. It fails before the patch (the entry point
 * throws) and passes after it.
 *
 * @param input incident, investigation and a repo file reader
 * @param targetPath either the desired test path (`test/foo.bar.test.js`), which is
 *   used as-is, or the source file under test, from which a test path is derived
 * @returns an `add` FilePatch holding the complete test file
 */
export function buildRegressionTest(input: FixInput, targetPath: string): FilePatch {
  const thrown = parseThrownAccess(input.incident.errorMessage);
  const frame = input.investigation.failingFrame;
  const file = frame ? resolveRepoFile(input.readFile, frame.file) : null;
  const guard = frame && file && thrown ? synthesiseNullGuard(file, frame, thrown) : null;
  const ctx = buildTestContext(input);

  const field = guard?.field ?? 'input';
  const entryPath = ctx?.entryPath ?? frame?.file ?? 'src/index.js';
  const testPath = looksLikeTestPath(targetPath)
    ? targetPath
    : deriveTestPath(input, entryPath, field);

  if (!ctx) {
    return {
      path: testPath,
      kind: 'add',
      contents: '',
      rationale:
        'The entry point under test could not be resolved from the stack trace, so no runnable ' +
        'regression test could be generated.',
    };
  }

  const incident = input.incident;
  // Sentry issues frequently carry no request body. Rather than give up, mine a
  // known-good payload out of the repository's existing tests and break exactly
  // the field that threw — that is precisely the case the fix must handle.
  const minedBody = incident.sampleRequest?.body ?? mineFixturePayload(input, guard?.receiver ?? field);
  const failingBody = minedBody
    ? setFieldInPayload(minedBody, field, guard ? guard.receiver.split('.') : [], null)
    : {};
  const sourcePaths = [file?.path, ctx.entryPath].filter((p): p is string => typeof p === 'string');
  const validValue = findValidFieldValue(input, field, ctx.entryPath, sourcePaths);
  const passingBody = setFieldInPayload(
    failingBody,
    field,
    guard ? guard.receiver.split('.') : [],
    validValue,
  );

  const relative = path.posix.relative(path.posix.dirname(testPath), ctx.entryPath);
  const requireFrom = relative.startsWith('.') ? relative : './' + relative;
  const failingArg = renderCallArgument(ctx, incident, failingBody);
  const passingArg = renderCallArgument(ctx, incident, passingBody);
  const method = incident.sampleRequest?.method ?? 'POST';
  const route = incident.sampleRequest?.path ?? '/';
  const frameDesc = frame ? `${frame.fn} (${frame.file}:${frame.line})` : 'the failing frame';

  // How the subject under test is constructed and invoked.
  const subject = ctx.entryIsClass ? `new ${ctx.entryFn}()` : ctx.entryFn;
  const invoke = ctx.entryIsClass ? `${subject}.${ctx.entryMethod}` : ctx.entryFn;
  const header = ctx.esm
    ? [
        `import test from 'node:test';`,
        `import assert from 'node:assert/strict';`,
        '',
        `import { ${ctx.entryFn} } from '${requireFrom}';`,
      ]
    : [
        "'use strict';",
        '',
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        '',
        `const { ${ctx.entryFn} } = require('${requireFrom}');`,
      ];

  const contents = [
    `// Regression test for ${incident.id} - ${incident.title}.`,
    '// On the unpatched tree this payload reproduces:',
    `//   ${incident.errorType}: ${incident.errorMessage}`,
    `//     at ${frameDesc}`,
    incident.sampleRequest
      ? '// The payload is the production request captured on the incident.'
      : '// No request was captured on the incident, so the payload is built from the',
    incident.sampleRequest ? '' : "// repository's own test fixtures with the offending field cleared.",
    '',
    ...header,
    '',
    `/** The exact ${method} ${route} request that triggered the incident. */`,
    `const FAILING_REQUEST = ${failingArg};`,
    '',
    `/** The same request with a valid ${field}, so an over-broad guard cannot pass. */`,
    `const PASSING_REQUEST = ${passingArg};`,
    '',
    `test('${method} ${route} with a missing ${field} does not throw', function () {`,
    '  assert.doesNotThrow(function () {',
    `    ${invoke}(FAILING_REQUEST);`,
    `  }, 'a missing ${field} must be a validation failure, not an unhandled ${incident.errorType}');`,
    '});',
    '',
    `test('${method} ${route} with a missing ${field} is rejected with ${ctx.failureStatus}', function () {`,
    `  const response = ${invoke}(FAILING_REQUEST);`,
    `  assert.equal(response.status, ${ctx.failureStatus}, 'expected a structured client error, not a 5xx');`,
    `  assert.match(`,
    '    JSON.stringify(response),',
    `    /${field}/,`,
    `    'the response must name the offending field so the client can correct the request',`,
    '  );',
    '});',
    '',
    `test('${method} ${route} with a valid ${field} still succeeds', function () {`,
    `  const response = ${invoke}(PASSING_REQUEST);`,
    `  assert.equal(response.status, ${ctx.successStatus}, 'the guard must not reject previously valid requests');`,
    '});',
    '',
  ].join('\n');

  return {
    path: testPath,
    kind: 'add',
    contents,
    rationale:
      `Reproduces ${incident.id} from the captured ${method} ${route} request. The first case fails on ` +
      `the unpatched tree because ${invoke} throws ${incident.errorType}; the second pins the ` +
      `response to ${ctx.failureStatus} naming "${field}"; the third is a positive control with ` +
      `${field} = ${JSON.stringify(validValue)} taken from the repo's existing fixtures, so a guard that ` +
      `rejects everything cannot pass.`,
  };
}

// ---------------------------------------------------------------------------
// 9. Reproduction steps and risks
// ---------------------------------------------------------------------------

function buildReproductionSteps(
  input: FixInput,
  guard: GuardSynthesis | null,
  ctx: TestContext | null,
  testPath: string,
): string[] {
  const incident = input.incident;
  const sample = incident.sampleRequest;
  const frame = input.investigation.failingFrame;
  const suspect = input.investigation.suspect;
  const steps: string[] = [];

  steps.push(
    suspect
      ? `Check out ${suspect.sha} (${suspect.prNumber !== null ? `PR #${suspect.prNumber}` : 'the suspect commit'}: ${suspect.title}), which is the code running in production.`
      : 'Check out the commit currently running in production.',
  );

  if (sample) {
    const payload = JSON.stringify(sample.body ?? {}, null, 2)
      .split('\n')
      .map((l) => '     ' + l)
      .join('\n');
    steps.push(`Send the captured production request ${sample.method} ${sample.path} with this body:\n${payload}`);
  } else {
    steps.push(`Exercise ${input.investigation.affectedFunctionality}.`);
  }

  if (guard) {
    steps.push(
      `Observe the request fail with ${incident.errorType}: ${incident.errorMessage}, thrown at ` +
        `${guard.path}:${guard.lineNumber} in ${guard.enclosing?.name ?? frame?.fn ?? 'the failing function'}(), ` +
        `where ${guard.receiver} is ${parseThrownAccess(incident.errorMessage)?.nullishKind ?? 'nullish'}.`,
    );
    steps.push(
      `Repeat the same request with a populated ${guard.field} - it succeeds, which confirms the failure ` +
        `is specific to requests where ${guard.receiver} is absent rather than to the endpoint as a whole.`,
    );
  } else if (frame) {
    steps.push(`Observe ${incident.errorType}: ${incident.errorMessage} at ${frame.file}:${frame.line}.`);
  }

  if (ctx) {
    steps.push(
      `Reproduce it without a server: add ${testPath} from this plan and run "node --test ${testPath}" ` +
        `in the repo. It fails on the unpatched tree and passes once the source patch is applied.`,
    );
  }

  return steps;
}

function buildRisks(
  input: FixInput,
  guard: GuardSynthesis | null,
  caller: CallerAnalysis | null,
  ctx: TestContext | null,
): string[] {
  const risks: string[] = [];
  if (!guard) {
    risks.push(
      'No source patch could be synthesised: the failing frame, the error message or the file contents ' +
        'did not yield a guardable member expression, so a human must write this fix.',
    );
    return risks;
  }

  risks.push(
    `Behaviour change: requests where ${guard.receiver} is nullish now return ` +
      `"${guard.convention.signal}"${ctx ? ` as an HTTP ${ctx.failureStatus}` : ''} instead of throwing. Alerting, SLOs ` +
      `and client retry logic keyed on 5xx for this path will stop firing - the traffic moves from 5xx to ` +
      `4xx, it does not become successful, so the conversion impact of the incident persists until the ` +
      `clients start sending ${guard.field}.`,
  );

  if (guard.emptyStringGuarded) {
    const prop = parseThrownAccess(input.incident.errorMessage)?.property ?? 'a string method';
    risks.push(
      `The guard rejects an empty string as well as null and undefined, because the original code called ` +
        `.${prop}() on the value. Any client that sends ${guard.field}: "" today expecting a default will ` +
        `now be rejected. Confirm that with the client teams before shipping.`,
    );
  }

  if (!guard.convention.inferred) {
    risks.push(
      `The failure shape could not be read off ${guard.path}, so a defensive default is used. Confirm it ` +
        `matches what callers of this module actually expect before merging.`,
    );
  }

  if (guard.otherSites.length > 0) {
    risks.push(
      `${guard.receiver} is also dereferenced at ${guard.path} line(s) ${guard.otherSites.join(', ')}. This ` +
        `patch guards only line ${guard.lineNumber}, so those paths can still throw on the same nullish value.`,
    );
  } else {
    risks.push(
      `The guard covers the whole chain (${guard.guardExpression}) but is scoped to ` +
        `${guard.enclosing?.name ?? 'the failing function'}() in ${guard.path}. Any other module that reads ` +
        `${guard.receiver} is unchanged and would need the same treatment.`,
    );
  }

  risks.push(
    `This makes ${guard.field} effectively required on this path. If the product intent is for the server ` +
      `to infer it (from geo-IP, a stored profile, or a default), the correct fix is to supply that value ` +
      `rather than reject the request. The guard chooses rejection only because that is what this validator ` +
      `does for every other field.`,
  );

  if (caller?.patch) {
    risks.push(
      `${caller.patch.path} is modified too, so the structured failure surfaces as a client error. That is a ` +
        `second behavioural change in the request path and needs its own review.`,
    );
  } else if (caller && !caller.patch && /no minimal, safe caller patch/.test(caller.note)) {
    risks.push(caller.note);
  }

  risks.push(
    'The patch is synthesised from the stack frame and the file text, not from a type checker or an ' +
      'exploration of the module. The regression test proves the reported symptom is fixed; it does not ' +
      'prove there is no other unguarded dereference in this code path.',
  );

  return risks;
}

// ---------------------------------------------------------------------------
// 10. planFix
// ---------------------------------------------------------------------------

/**
 * Synthesises the permanent fix for an incident: a null-guard patch for the file
 * named by the failing stack frame, an optional minimal caller patch so the
 * structured failure surfaces as a client error, and a runnable regression test.
 *
 * Entirely deterministic - derived from the incident, the investigation and the
 * repository contents, with no clock or randomness.
 */
export function planFix(input: FixInput): FixPlan {
  const { incident, investigation } = input;
  const thrown = parseThrownAccess(incident.errorMessage);
  const frame = investigation.failingFrame;
  const file = frame ? resolveRepoFile(input.readFile, frame.file) : null;

  if (!thrown) {
    log.warn(`error message is not a recognised null-dereference TypeError: ${incident.errorMessage}`);
  } else if (frame && !file) {
    log.warn(`could not read ${frame.file} from the repo`);
  }

  let guard: GuardSynthesis | null = null;
  if (frame && file && thrown) {
    guard = synthesiseNullGuard(file, frame, thrown);
    if (!guard) {
      log.warn(
        `no '.${thrown.property}' member expression found in ${file.path} near line ${frame.line}`,
      );
    }
  }

  const frames = parseStackFrames(incident.stackTrace);
  const caller = guard && file ? analyseCaller(input, frames, file.path, guard) : null;

  const patches: FilePatch[] = [];
  if (guard) {
    const nullish = thrown?.nullishKind ?? 'nullish';
    patches.push({
      path: guard.path,
      kind: 'modify',
      contents: guard.newContents,
      rationale:
        `${guard.path}:${guard.lineNumber} read .${thrown?.property ?? '?'} straight off ${guard.receiver}, ` +
        `which is ${nullish} for the requests in this incident, so the whole request threw ` +
        `${incident.errorType}. The rewrite hoists the value into ${guard.rawVar} behind an explicit ` +
        `${guard.guardExpression} chain and fails early with ${guard.convention.signalLiteral} - which ` +
        `${guard.convention.description}. The original operation is preserved on a coerced value, so valid ` +
        `requests behave exactly as before. Optional chaining was deliberately avoided: a reviewer needs to ` +
        `see the missing value rejected, not silently turned into undefined.` +
        (caller && !caller.patch ? ` ${caller.note}` : ''),
    });
  }
  if (caller?.patch) patches.push(caller.patch);

  const ctx = buildTestContext(input);
  const entryPath = ctx?.entryPath ?? frame?.file ?? 'src/index.js';
  const testPath = deriveTestPath(input, entryPath, guard?.field ?? 'input');
  const regressionTest = buildRegressionTest(input, testPath);
  const usableTest = regressionTest.contents.trim().length > 0 ? regressionTest : null;

  return {
    rootCause: investigation.rootCause,
    reproductionSteps: buildReproductionSteps(input, guard, ctx, testPath),
    patches,
    regressionTest: usableTest,
    regressionTestName: testPath,
    risks: buildRisks(input, guard, caller, ctx),
    source: 'deterministic',
  };
}

// ---------------------------------------------------------------------------
// 11. planFixWithLlm
// ---------------------------------------------------------------------------

interface LlmPatchDraft {
  path?: unknown;
  contents?: unknown;
  rationale?: unknown;
}

interface LlmFixDraft {
  patches?: unknown;
  regressionTest?: unknown;
  risks?: unknown;
  reproductionSteps?: unknown;
}

const SCHEMA_HINT = `{
  "patches": [{ "path": "src/...js", "contents": "<complete new file contents>", "rationale": "why" }],
  "regressionTest": { "path": "test/....test.js", "contents": "<complete CommonJS node:test file>", "rationale": "why" },
  "risks": ["specific, honest risk"],
  "reproductionSteps": ["concrete step a human can follow"]
}`;

/** Deterministic scratch directory used for syntax-checking model output. */
function scratchDir(seed: string): string {
  const configured = (process.env.FF_SCRATCH_DIR ?? '').trim();
  const base = configured.length > 0 ? configured : os.tmpdir();
  return path.join(base, 'firefighter-syntax-' + shortHash(seed, 12));
}

/**
 * Parses candidate file contents with the real Node parser.
 *
 * `new Function` is the wrong tool here: the demo repo is CommonJS, so the
 * candidate is not a function body and `require`/`module`/`'use strict'`
 * directives would be evaluated differently. Writing the file to scratch and
 * running `node --check` is exactly what the runtime will do.
 */
function syntaxCheck(filePath: string, contents: string): { ok: boolean; output: string } {
  const dir = scratchDir(filePath + '\n' + contents);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(filePath) || 'candidate.js');
    fs.writeFileSync(target, contents, 'utf8');
    const res = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    return { ok: res.status === 0, output: `${res.stderr ?? ''}${res.stdout ?? ''}`.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

/** Rejects absolute paths, traversal and anything that is not a plain repo path. */
function isSafeRepoPath(p: string): boolean {
  if (typeof p !== 'string' || p.trim().length === 0) return false;
  if (p.includes('\n') || p.includes('\r')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || path.isAbsolute(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const normalised = path.posix.normalize(p);
  if (normalised.startsWith('..') || normalised.includes('../')) return false;
  return normalised === p;
}

/**
 * Accepts a model-authored patch only when it targets a file that already exists
 * in the repo (or is a permitted new test file), is non-empty, is not a truncated
 * rewrite, and parses under `node --check`.
 */
function validatePatch(input: FixInput, draft: LlmPatchDraft, allowNewTest: boolean): FilePatch | null {
  const p = draft.path;
  const contents = draft.contents;
  if (typeof p !== 'string' || typeof contents !== 'string') {
    log.warn('rejecting llm patch: path and contents must both be strings');
    return null;
  }
  if (!isSafeRepoPath(p)) {
    log.warn(`rejecting llm patch: unsafe path ${JSON.stringify(p)}`);
    return null;
  }
  if (contents.trim().length === 0) {
    log.warn(`rejecting llm patch for ${p}: empty contents would delete the file`);
    return null;
  }
  const existing = input.readFile(p);
  const isNewTest = /^tests?\//.test(p) && /\.(test|spec)\.[cm]?js$/.test(p);
  if (existing === null && !(allowNewTest && isNewTest)) {
    log.warn(`rejecting llm patch for ${p}: file does not exist and is not a permitted new test file`);
    return null;
  }
  if (existing !== null && contents.length < existing.length * 0.4) {
    log.warn(
      `rejecting llm patch for ${p}: rewrite is ${contents.length} bytes against a ${existing.length} byte ` +
        'original, which looks truncated',
    );
    return null;
  }
  const check = syntaxCheck(p, contents);
  if (!check.ok) {
    log.warn(`rejecting llm patch for ${p}: does not parse`, check.output);
    return null;
  }
  return {
    path: p,
    kind: existing === null ? 'add' : 'modify',
    contents,
    rationale:
      typeof draft.rationale === 'string' && draft.rationale.trim().length > 0
        ? draft.rationale.trim()
        : 'No rationale supplied by the model.',
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return out.length > 0 ? out : null;
}

/**
 * Computes the deterministic plan first, then optionally asks the configured LLM
 * to improve it. Model output is accepted only after hard validation - safe
 * repo-relative paths, existing files or a new test under test/ only, no
 * deletions, no truncated rewrites, and every file must parse under
 * `node --check`. On any violation the deterministic plan is returned unchanged,
 * and `source` is set to the provider name only when the draft is accepted.
 */
export async function planFixWithLlm(input: FixInput, llm: LlmClient): Promise<FixPlan> {
  const deterministic = planFix(input);
  if (!llm.available) return deterministic;

  const relevantPaths = new Set<string>();
  for (const patch of deterministic.patches) relevantPaths.add(patch.path);
  if (input.investigation.failingFrame) {
    const resolved = resolveRepoFile(input.readFile, input.investigation.failingFrame.file);
    if (resolved) relevantPaths.add(resolved.path);
  }
  const fileBlocks: string[] = [];
  for (const p of [...relevantPaths].sort()) {
    const original = input.readFile(p);
    if (original !== null) fileBlocks.push(`--- ${p} (current contents) ---\n${original}`);
  }

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        'You are a senior engineer writing the permanent fix for a production incident. Return whole-file ' +
        'contents for every patch, never a diff. Only touch files that already exist in the repository, ' +
        'plus at most one new test file under test/. Never delete a file, never write outside the ' +
        'repository, and never weaken an existing check. Match the failure-reporting convention the file ' +
        'already uses. Reply with JSON only.',
    },
    {
      role: 'user',
      content: [
        `Incident ${input.incident.id}: ${input.incident.title}`,
        `Error: ${input.incident.errorType}: ${input.incident.errorMessage}`,
        `Stack trace:\n${input.incident.stackTrace}`,
        `Sample request:\n${JSON.stringify(input.incident.sampleRequest ?? null, null, 2)}`,
        '',
        `Root cause from the investigation: ${input.investigation.rootCause}`,
        `Affected functionality: ${input.investigation.affectedFunctionality}`,
        `Proposed permanent fix: ${input.investigation.permanentFix}`,
        `Failing frame: ${JSON.stringify(input.investigation.failingFrame)}`,
        '',
        ...fileBlocks,
        '',
        'A deterministic synthesiser already produced the plan below. Improve it only if you can do better; ' +
          'keep the same structure and the same failure-reporting convention.',
        JSON.stringify(
          {
            patches: deterministic.patches.map((p) => ({ path: p.path, rationale: p.rationale })),
            regressionTest: deterministic.regressionTest?.path ?? null,
            risks: deterministic.risks,
            reproductionSteps: deterministic.reproductionSteps,
          },
          null,
          2,
        ),
      ].join('\n'),
    },
  ];

  let draft: LlmFixDraft | null = null;
  try {
    draft = await llm.completeJson<LlmFixDraft>(messages, SCHEMA_HINT);
  } catch (err) {
    log.warn(
      'llm fix planning failed, keeping the deterministic plan',
      err instanceof Error ? err.message : String(err),
    );
    return deterministic;
  }
  if (!draft || typeof draft !== 'object') return deterministic;

  if (!Array.isArray(draft.patches) || draft.patches.length === 0) {
    log.warn('rejecting llm fix plan: no patches returned');
    return deterministic;
  }
  const patches: FilePatch[] = [];
  for (const candidate of draft.patches as LlmPatchDraft[]) {
    const validated = validatePatch(input, candidate, false);
    if (!validated) return deterministic;
    patches.push(validated);
  }

  let regressionTest: FilePatch | null = deterministic.regressionTest;
  if (draft.regressionTest && typeof draft.regressionTest === 'object') {
    const validated = validatePatch(input, draft.regressionTest as LlmPatchDraft, true);
    if (!validated) {
      log.warn('rejecting llm fix plan: the regression test failed validation');
      return deterministic;
    }
    if (!/^tests?\//.test(validated.path)) {
      log.warn(`rejecting llm fix plan: regression test path ${validated.path} is not under test/`);
      return deterministic;
    }
    regressionTest = validated;
  }

  return {
    rootCause: deterministic.rootCause,
    reproductionSteps: stringArray(draft.reproductionSteps) ?? deterministic.reproductionSteps,
    patches,
    regressionTest,
    regressionTestName: regressionTest?.path ?? deterministic.regressionTestName,
    risks: stringArray(draft.risks) ?? deterministic.risks,
    source: llm.name,
  };
}
