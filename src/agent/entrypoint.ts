/**
 * Entry-point resolution.
 *
 * Both the reproduction driver and the regression-test generator need to answer
 * the same three questions about a service:
 *
 *   1. which module do I call into?
 *   2. is the export a plain function, or a class I must instantiate first?
 *   3. does it take an HTTP request envelope, or the domain object directly?
 *
 * Getting (3) wrong is subtle and expensive: a method declared
 * `createOrder(request: CheckoutRequest)` is *named* like an HTTP handler but
 * takes a domain object, so wrapping the payload in `{method, path, body}`
 * silently produces a call that fails for the wrong reason. The decision is
 * therefore made from what the function body actually dereferences, never from
 * the parameter's name.
 */
import path from 'node:path';
import { StackFrame } from '../types.ts';
import { parseStackTrace, normalizePath } from './stacktrace.ts';

/** Reads a repo-relative path, returning null when absent. */
export type FileReader = (repoPath: string) => string | null;

export interface EntryPoint {
  /** Repo-relative module path. */
  path: string;
  /** Exported symbol to import. */
  symbol: string;
  /** True when `symbol` is a class that must be instantiated. */
  isClass: boolean;
  /** Method to invoke on the instance; null for a plain function. */
  method: string | null;
  /** Parameter names of the invoked function. */
  params: string[];
  /** True when the callee reads `.body`/`.method`/`.headers` off its argument. */
  wantsHttpEnvelope: boolean;
  /** True when the module is ES-module syntax. */
  esm: boolean;
}

interface ExportedSymbol {
  name: string;
  isClass: boolean;
}

/** ES-module exports, flagged as class or not. */
export function parseEsmExportSymbols(text: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
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

/** CommonJS exports. */
export function parseCjsExportSymbols(text: string): ExportedSymbol[] {
  const names = new Set<string>();
  const objectForm = /module\.exports\s*=\s*\{([^}]*)\}/.exec(text);
  if (objectForm) {
    for (const piece of objectForm[1].split(',')) {
      const key = piece.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  let m: RegExpExecArray | null;
  const propRe = /module\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = propRe.exec(text)) !== null) names.add(m[1]);
  const exportsRe = /(?<!module\.)\bexports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = exportsRe.exec(text)) !== null) names.add(m[1]);
  const single = /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(text);
  if (single) names.add(single[1]);
  return [...names].map((name) => ({
    name,
    isClass: new RegExp(`class\\s+${name}\\b`).test(text),
  }));
}

/** Parameter names of a named function or method, with TS annotations stripped. */
export function parameterNames(text: string, fnName: string): string[] {
  const re = new RegExp(
    `(?:function\\s+${fnName}|\\b${fnName})\\s*(?:<[^>]*>)?\\s*\\(([^)]*)\\)`,
  );
  const m = re.exec(text);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((p) => p.trim().split(':')[0].trim().replace(/^\.\.\./, ''))
    .filter((p) => p.length > 0 && /^[A-Za-z_$][\w$]*$/.test(p));
}

/**
 * Does this function treat its first argument as an HTTP request envelope?
 *
 * Decided by what the body dereferences, because parameter names lie: a domain
 * method is frequently called `request` while taking a plain object.
 */
export function usesHttpEnvelope(text: string, fnName: string, paramName: string): boolean {
  if (!paramName) return false;
  const start = text.search(new RegExp(`(?:function\\s+${fnName}|\\b${fnName})\\s*(?:<[^>]*>)?\\s*\\(`));
  if (start === -1) return false;
  // Take a generous window: the whole function body is hard to delimit cheaply,
  // and an envelope access appears early if it appears at all.
  const window = text.slice(start, start + 2000);
  return new RegExp(`\\b${paramName}\\s*(?:\\?)?\\.\\s*(body|method|headers|query|params|originalUrl|url)\\b`).test(
    window,
  );
}

/** Conventional entry modules, used when the stack trace yields nothing. */
function conventionalCandidates(readFile: FileReader): string[] {
  const out: string[] = [];
  const pkg = readFile('package.json');
  if (pkg) {
    try {
      const main = (JSON.parse(pkg) as { main?: unknown }).main;
      if (typeof main === 'string' && main.trim()) out.push(main.trim());
    } catch {
      /* unreadable package.json */
    }
  }
  out.push(
    'src/checkout.js',
    'src/checkout/checkout.service.ts',
    'src/index.js',
    'src/index.ts',
    'index.js',
    'src/app.js',
    'src/server.js',
    'src/handler.js',
  );
  return [...new Set(out)];
}

/**
 * Resolve the module and callable that reproduce the incident.
 *
 * Candidates are taken from the stack trace, outermost application frame first
 * (that is the caller you would hit in production), then conventional paths.
 *
 * @param readFile    repo-relative file reader
 * @param stackTrace  the incident's stack trace
 * @param failingFrame the innermost application frame, when known
 */
export function resolveEntryPoint(
  readFile: FileReader,
  stackTrace: string,
  failingFrame?: StackFrame | null,
): EntryPoint | null {
  const frames = parseStackTrace(stackTrace);
  // Outermost first: the caller is the realistic entry point, and calling it
  // exercises the failing frame underneath.
  const framePaths = [...frames].reverse().map((f) => normalizePath(f.file));
  const candidates = [...new Set([...framePaths, ...conventionalCandidates(readFile)])].filter(Boolean);

  const frameFns = frames.map((f) => f.fn.split('.').pop() ?? f.fn);
  const frameClasses = frames
    .map((f) => (f.fn.includes('.') ? f.fn.split('.')[0] : null))
    .filter((n): n is string => n !== null);

  const pkg = readFile('package.json') ?? '';
  const pkgIsEsm = /"type"\s*:\s*"module"/.test(pkg);

  for (const candidate of candidates) {
    const text = readFile(candidate);
    if (!text) continue;

    const esmSymbols = parseEsmExportSymbols(text);
    const cjsSymbols = parseCjsExportSymbols(text);
    const symbols = esmSymbols.length ? esmSymbols : cjsSymbols;
    if (!symbols.length) continue;

    const chosen =
      symbols.find((s) => frameFns.includes(s.name)) ??
      symbols.find((s) => frameClasses.includes(s.name)) ??
      (symbols.length === 1 ? symbols[0] : null);
    if (!chosen) continue;

    let method: string | null = null;
    if (chosen.isClass) {
      // Call the method belonging to this class that appears on the stack.
      const owned = frames.find((f) => f.fn.startsWith(chosen.name + '.'));
      method = owned ? (owned.fn.split('.').pop() ?? null) : null;
      if (!method) continue;
    }

    const callable = method ?? chosen.name;
    const params = parameterNames(text, callable);
    return {
      path: candidate,
      symbol: chosen.name,
      isClass: chosen.isClass,
      method,
      params,
      wantsHttpEnvelope: usesHttpEnvelope(text, callable, params[0] ?? ''),
      esm: esmSymbols.length > 0 || pkgIsEsm || /\.m?tsx?$/.test(candidate),
    };
  }

  // Nothing matched by symbol; fall back to the failing frame's own file so the
  // caller at least gets a usable error rather than silence.
  if (failingFrame) {
    const p = normalizePath(failingFrame.file);
    if (readFile(p)) {
      return {
        path: p,
        symbol: failingFrame.fn.split('.')[0] ?? failingFrame.fn,
        isClass: failingFrame.fn.includes('.'),
        method: failingFrame.fn.includes('.') ? (failingFrame.fn.split('.').pop() ?? null) : null,
        params: [],
        wantsHttpEnvelope: false,
        esm: pkgIsEsm || /\.m?tsx?$/.test(p),
      };
    }
  }
  return null;
}

/**
 * Build the argument to pass, in the shape the entry point expects.
 *
 * @param entry  resolved entry point
 * @param sample the incident's captured request, if any
 * @param body   the payload to send (defaults to the sample's body)
 */
export function callArgument(
  entry: EntryPoint,
  sample: { method: string; path: string; headers?: Record<string, string>; body?: unknown } | undefined,
  body?: unknown,
): unknown {
  const payload = body !== undefined ? body : (sample?.body ?? {});
  if (!entry.wantsHttpEnvelope) return payload;
  return {
    method: sample?.method ?? 'POST',
    path: sample?.path ?? '/',
    ...(sample?.headers ? { headers: sample.headers } : {}),
    body: payload,
  };
}

/** Import specifier to reach `entry` from a file in `fromDir`. */
export function importSpecifier(fromDir: string, entryPath: string): string {
  const rel = path.posix.relative(fromDir, entryPath);
  return rel.startsWith('.') ? rel : './' + rel;
}
