const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.FF_LOG_LEVEL as Level) ?? 'info'] ?? 20;
const quiet = process.env.FF_QUIET === '1';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (quiet && level !== 'error') return;
  if (LEVELS[level] < threshold) return;
  const color = COLORS[level];
  const line = `${color}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[35m${scope.padEnd(18)}\x1b[0m ${msg}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
  if (extra !== undefined) {
    const text = typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2);
    stream.write(
      text
        .split('\n')
        .map((l) => '      \x1b[90m' + l + '\x1b[0m')
        .join('\n') + '\n',
    );
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}
