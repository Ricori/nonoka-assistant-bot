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
const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

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

function emit(level: LogLevel, tag: string, parts: unknown[]) {
  const text = parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p)))
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
  if (process.env.QQ_LOG_LEVEL === 'debug' || process.env.QQ_LOG_LEVEL === 'trace') {
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
