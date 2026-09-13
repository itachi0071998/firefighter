/**
 * V8 stack-trace parsing.
 *
 * Production stack traces arrive with deployment-container paths
 * (`/app/src/...`, `/usr/src/app/src/...`) while every other part of the system
 * — git, the diff, the code search index — speaks repo-relative paths
 * (`src/...`). Bridging those two worlds is this module's whole job: without it
 * the analyzer can never line a failing frame up against a pull request's
 * changed files, which is the single strongest root-cause signal we have.
 *
 * Everything here is pure and synchronous: same input string, same frames,
 * forever.
 */
import type { StackFrame } from '../types.ts';

/**
 * Container / CI roots that get prepended to source paths at deploy time.
 * Longest-first so `/usr/src/app/` wins before any shorter sibling.
 */
const DEPLOY_PREFIXES: readonly RegExp[] = [
  /^\/opt\/render\/project\/src\//,
  /^\/home\/circleci\/project\//,
  /^\/github\/workspace\//,
  /^\/var\/app\/current\//,
  /^\/usr\/src\/app\//,
  /^\/home\/node\/app\//,
  /^\/vercel\/path0\//,
  /^\/home\/app\//,
  /^\/srv\/www\//,
  /^\/srv\/app\//,
  /^\/opt\/app\//,
  /^\/usr\/app\//,
  /^\/workspace\//,
  /^\/var\/task\//,
  /^\/app\//,
  /^\/code\//,
];

/**
 * Directory names that conventionally start a repo-relative path. Used to cut a
 * stubbornly absolute path (a local dev checkout, say) down to size.
 */
const SOURCE_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'server',
  'client',
  'services',
  'components',
  'test',
  'tests',
  'spec',
  '__tests__',
  'scripts',
  'bin',
  'dist',
  'build',
]);

/** Locations V8 emits that name no real file. */
const NON_FILE_LOCATIONS: ReadonlySet<string> = new Set([
  'native',
  '<anonymous>',
  'unknown location',
  '<unknown>',
  '',
]);

const AT_WITH_FN = /^at\s+(.+?)\s+\((.+)\)$/;
const AT_BARE = /^at\s+(.+)$/;
const LOCATION_LINE_COL = /^(.*):(\d+):(\d+)$/;
const LOCATION_LINE = /^(.*):(\d+)$/;

/**
 * Turn a stack-trace file path into a repo-relative path.
 *
 * Strips `file://` URLs, Windows drive letters, a deployment prefix
 * (`/app/`, `/srv/app/`, `/usr/src/app/`, `/var/task/`, ...) and, for a path
 * that is still absolute, everything ahead of the last conventional source root
 * (`src/`, `lib/`, `test/`, ...). A path that resists all of that keeps its
 * segments and merely loses its leading slash, so callers can still
 * suffix-match it. The function is idempotent — normalising an already
 * normalised path returns it unchanged — and `node:` scheme paths are passed
 * through untouched so internal frames stay recognisable.
 *
 * @param file Raw path exactly as it appeared in the stack frame.
 * @returns Repo-relative path such as `src/validators/CheckoutValidator.js`.
 */
export function normalizePath(file: string): string {
  if (!file) return '';
  let p = file.trim();
  if (!p) return '';
  if (p.startsWith('node:')) return p;

  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    if (!p.startsWith('/')) p = '/' + p;
    try {
      p = decodeURIComponent(p);
    } catch {
      // A malformed escape sequence is not worth failing an investigation over.
    }
  }

  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/?[A-Za-z]:\//, '/');
  p = p.replace(/\/{2,}/g, '/');

  for (const prefix of DEPLOY_PREFIXES) {
    if (prefix.test(p)) {
      p = p.replace(prefix, '');
      break;
    }
  }

  if (p.startsWith('/')) {
    const segments = p.split('/').filter(Boolean);
    let cut = -1;
    // Scan right-to-left but never treat the basename itself as a root, so
    // `/Users/me/work/src/checkout.js` yields `src/checkout.js`.
    for (let i = segments.length - 2; i >= 0; i--) {
      if (SOURCE_ROOT_SEGMENTS.has(segments[i])) {
        cut = i;
        break;
      }
    }
    p = (cut >= 0 ? segments.slice(cut) : segments).join('/');
  }

  p = p.replace(/^\.\//, '');
  return p;
}

/**
 * Clean a V8 frame's function label into a bare symbol path.
 *
 * `async CheckoutValidator.validate` -> `CheckoutValidator.validate`,
 * `new CheckoutValidator` -> `CheckoutValidator`,
 * `Foo.bar [as baz]` -> `Foo.bar`.
 */
function cleanFunctionName(raw: string): string {
  let fn = raw.trim();
  fn = fn.replace(/^async\s+/, '');
  fn = fn.replace(/^new\s+/, '');
  fn = fn.replace(/\s*\[as\s+[^\]]+\]\s*$/, '');
  return fn.trim() || '<anonymous>';
}

interface ParsedLocation {
  file: string;
  line: number;
  column: number | null;
}

/**
 * Split a `path:line:column` location. Tolerates a missing column, a missing
 * line number, and `eval at ...` wrappers by reaching for the inner location.
 */
function parseLocation(rawLocation: string): ParsedLocation | null {
  let location = rawLocation.trim();
  if (!location) return null;

  if (location.startsWith('eval at ')) {
    const inner = /\(([^()]+)\)/.exec(location);
    if (!inner) return null;
    location = inner[1].trim();
  }

  const withCol = LOCATION_LINE_COL.exec(location);
  if (withCol) {
    return { file: withCol[1], line: Number(withCol[2]), column: Number(withCol[3]) };
  }
  const withLine = LOCATION_LINE.exec(location);
  if (withLine) {
    return { file: withLine[1], line: Number(withLine[2]), column: null };
  }
  if (NON_FILE_LOCATIONS.has(location)) return null;
  // A bare path with no position still identifies a file worth matching.
  if (location.includes('/') || /\.[A-Za-z0-9]+$/.test(location)) {
    return { file: location, line: 0, column: null };
  }
  return null;
}

/**
 * Parse a V8 stack trace into structured frames.
 *
 * Handles both frame shapes V8 emits — named
 * (`    at CheckoutValidator.country (/app/src/validators/CheckoutValidator.js:34:31)`)
 * and anonymous (`    at /app/src/checkout.js:28:31`) — plus `async`, `new`,
 * `[as alias]`, `file://` URLs and `eval at` wrappers. The leading
 * `TypeError: ...` message line and any other non-frame line is ignored, and an
 * unparsable frame is skipped rather than throwing.
 *
 * Frame paths are returned already normalised by {@link normalizePath}, so
 * `frame.file` is repo-relative and directly comparable with git paths.
 *
 * @param stack Raw multi-line stack trace.
 * @returns Frames in stack order, innermost (the throw site) first.
 */
export function parseStackTrace(stack: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];

  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('at ')) continue;

    let fn = '<anonymous>';
    let locationText: string;

    const named = AT_WITH_FN.exec(line);
    if (named) {
      fn = cleanFunctionName(named[1]);
      locationText = named[2];
    } else {
      const bare = AT_BARE.exec(line);
      if (!bare) continue;
      locationText = bare[1].replace(/^async\s+/, '');
    }

    const loc = parseLocation(locationText);
    if (!loc) continue;

    const file = normalizePath(loc.file);
    if (!file) continue;

    frames.push({ fn, file, line: loc.line, column: loc.column });
  }

  return frames;
}

/**
 * True when a frame belongs to the runtime rather than to application code:
 * `node:` builtins, legacy `internal/*` paths, dependency code under
 * `node_modules/`, and frames with no real file.
 *
 * @param frame Frame to classify.
 */
export function isInternalFrame(frame: StackFrame): boolean {
  const raw = (frame.file ?? '').trim();
  if (!raw) return true;
  if (raw.startsWith('node:')) return true;
  const file = normalizePath(raw);
  if (!file) return true;
  if (/^internal\//.test(file)) return true;
  if (/(^|\/)node_modules\//.test(file)) return true;
  if (NON_FILE_LOCATIONS.has(file)) return true;
  return false;
}

/**
 * True when two repo-relative paths identify the same file, allowing for one
 * side carrying extra leading directories (a checkout root, a monorepo prefix).
 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
}

/**
 * Pick the frame that best identifies the application code that blew up.
 *
 * Runtime frames (`node:*`, `internal/*`, `node_modules/*`) are always skipped.
 * When `repoFiles` is supplied, the first frame whose normalised path is a file
 * in the repository wins — this is what stops a framework frame that happens to
 * sit above application code from being blamed. Without `repoFiles`, or when no
 * frame matches one, the first non-internal frame is returned.
 *
 * @param frames Frames in stack order, innermost first.
 * @param repoFiles Optional repo-relative paths known to exist in the repo.
 * @returns The failing application frame, or null if the stack has none.
 */
export function topAppFrame(frames: StackFrame[], repoFiles?: string[]): StackFrame | null {
  const appFrames = frames.filter((f) => !isInternalFrame(f));
  if (appFrames.length === 0) return null;

  if (repoFiles && repoFiles.length > 0) {
    const known = repoFiles.map((f) => normalizePath(f)).filter(Boolean);
    if (known.length > 0) {
      const matched = appFrames.find((frame) => {
        const file = normalizePath(frame.file);
        return known.some((candidate) => samePath(file, candidate));
      });
      if (matched) return matched;
    }
  }

  return appFrames[0];
}
