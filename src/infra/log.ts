/**
 * Structured logger with rotating files and secret redaction. Writes JSON lines
 * so the Logs screen and the diagnostics bundle can parse them. Also fans
 * events into Storage.recordEvent when a sink is attached, so lifecycle/errors
 * appear in History.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger } from '../core/types';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const REDACT_KEYS = /pass(word)?|token|secret|cookie|authorization|apikey|api_key/i;

export interface EventSink {
  (e: { at: number; kind: string; level: Level; source: string; message: string; data?: unknown }): void;
}

export interface LoggerOptions {
  filePath?: string;
  minLevel?: Level;
  maxBytes?: number;
  maxFiles?: number;
  now: () => number;
  sink?: EventSink;
  console?: boolean;
}

export function redact(data: unknown): unknown {
  if (data == null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

class RotatingLogger implements Logger {
  constructor(
    private readonly opts: LoggerOptions,
    private readonly source: string,
  ) {}

  child(source: string): Logger {
    return new RotatingLogger(this.opts, source);
  }

  debug(msg: string, data?: unknown): void { this.log('debug', msg, data); }
  info(msg: string, data?: unknown): void { this.log('info', msg, data); }
  warn(msg: string, data?: unknown): void { this.log('warn', msg, data); }
  error(msg: string, data?: unknown): void { this.log('error', msg, data); }

  private log(level: Level, message: string, data?: unknown): void {
    const min = this.opts.minLevel ?? 'debug';
    if (LEVEL_ORDER[level] < LEVEL_ORDER[min]) return;
    const at = this.opts.now();
    const safeData = data === undefined ? undefined : redact(data);
    const entry = { at, level, source: this.source, message, data: safeData };
    if (this.opts.console) {
      // eslint-disable-next-line no-console
      (console[level] ?? console.log)(`[${level}] ${this.source}: ${message}`, safeData ?? '');
    }
    if (this.opts.filePath) this.writeFile(JSON.stringify(entry));
    this.opts.sink?.({ at, kind: 'log', level, source: this.source, message, data: safeData });
  }

  private writeFile(line: string): void {
    const file = this.opts.filePath!;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      const max = this.opts.maxBytes ?? 5 * 1024 * 1024;
      if (existsSync(file) && statSync(file).size > max) this.rotate(file);
    } catch {
      /* ignore stat errors */
    }
    appendFileSync(file, line + '\n');
  }

  private rotate(file: string): void {
    const maxFiles = this.opts.maxFiles ?? 10;
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new RotatingLogger(opts, 'app');
}

export function logFilePath(dataDir: string): string {
  return join(dataDir, 'logs', 'stock-sentinel.log');
}
