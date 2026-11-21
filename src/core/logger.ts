import fs from 'fs';
import path from 'path';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  tag: string;
  text: string;
}

const MAX_BUFFER = 1000;
const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'assistant.log');

let nextId = 1;
let currentLogLevel = 'info';
const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

export function setLogLevel(level: string) {
  currentLogLevel = level || 'info';
}

function nowString() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendToFile(entry: LogEntry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${entry.time}] [${entry.level.toUpperCase()}] [${entry.tag}] ${entry.text}\n`, 'utf8');
  } catch {
    // 写盘失败不影响主流程
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    const extra: string[] = [];
    const e = value as Error & {
      code?: unknown;
      response?: { status?: unknown; data?: unknown };
    };
    if (e.code) extra.push(`code=${String(e.code)}`);
    if (e.response?.status) extra.push(`status=${String(e.response.status)}`);
    if (e.response?.data !== undefined) {
      try {
        extra.push(`data=${typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)}`);
      } catch {
        extra.push(`data=${String(e.response.data)}`);
      }
    }
    const base = value.stack || value.message;
    return extra.length ? `${base} [${extra.join(', ')}]` : base;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level: LogLevel, tag: string, parts: unknown[]) {
  const text = parts
    .map(safeStringify)
    .join(' ');
  const entry: LogEntry = {
    id: nextId++,
    time: nowString(),
    level,
    tag,
    text,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  appendToFile(entry);

  const line = `[${entry.time}] [${level.toUpperCase()}] [${tag}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // 忽略单个订阅者异常
    }
  }
}

export function logInfo(tag: string, ...parts: unknown[]) {
  emit('info', tag, parts);
}

export function logWarn(tag: string, ...parts: unknown[]) {
  emit('warn', tag, parts);
}

export function logError(tag: string, ...parts: unknown[]) {
  emit('error', tag, parts);
}

export function logDebug(tag: string, ...parts: unknown[]) {
  if (currentLogLevel === 'debug' || currentLogLevel === 'trace') {
    emit('debug', tag, parts);
  }
}

export function getRecentLogs(limit = 300): LogEntry[] {
  return buffer.slice(-limit);
}

export function subscribeLogs(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
