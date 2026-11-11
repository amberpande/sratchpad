/**
 * Structured logs: one JSON object per line (BI_LOG=json, the default in production), a readable
 * line (BI_LOG=pretty, the dev default) or nothing (BI_LOG=off, tests). Never log tokens, query
 * results or request bodies.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty' | 'off';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function errorFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return fields;
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 6).join('\n') } : v;
  }
  return out;
}

export function createLogger(options: { format?: LogFormat; level?: LogLevel; write?: (line: string) => void } = {}): Logger {
  const format = options.format ?? 'pretty';
  const min = ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (format === 'off' || ORDER[level] < min) return;
    const f = errorFields(fields);
    if (format === 'json') {
      write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...f }));
    } else {
      const rest = f && Object.keys(f).length ? ` ${Object.entries(f).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}` : '';
      write(`${level.toUpperCase().padEnd(5)} ${msg}${rest}`);
    }
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = createLogger({ format: 'off' });
