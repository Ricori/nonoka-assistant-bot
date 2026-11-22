import https from 'https';
import tls from 'tls';
import axios, { isAxiosError } from 'axios';
import { logError, logInfo, logWarn } from '@/core/logger';

/** 单次 TCP/TLS 连接等待。短于系统默认 SYN 超时，避免一次失败就占满 20 秒。不影响连接建立后的响应超时。 */
const CONNECT_TIMEOUT_MS = 8_000;

const CONNECT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const PRE_CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

class ConnectTimeoutAgent extends https.Agent {
  constructor(private readonly connectTimeoutMs: number) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: tls.ConnectionOptions,
    _callback?: (err: Error | null, stream: tls.TLSSocket) => void,
  ) {
    // 返回尚未连上的 socket。Agent 会立刻收下它；超时只在握手完成前销毁，避免吃掉之后的响应等待。
    const socket = tls.connect({ ...options, timeout: this.connectTimeoutMs });
    const onTimeout = () => {
      const host = options.host ?? options.servername ?? '';
      const port = options.port ?? '';
      const error = new Error(`connect ETIMEDOUT ${host}:${port}`) as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      socket.destroy(error);
    };
    socket.once('timeout', onTimeout);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      socket.removeListener('timeout', onTimeout);
    });
    return socket;
  }
}

const connectAgent = new ConnectTimeoutAgent(CONNECT_TIMEOUT_MS);

export interface AskWebhookPayload {
  question: string;
  groupId: string;
  userId: string;
  repo: string;
  msgId?: string;
  /** 当前消息图片附件的 https URL，不含图片内容 */
  images?: string[];
}

export interface AskTransportDetail {
  code?: string;
  message: string;
  cause?: string;
  bytes: number;
  elapsedMs: number;
}

/** 请求已发出，并且一直等到超时还没有响应。 */
export class AskWebhookTimeoutError extends Error {
  readonly detail: AskTransportDetail;

  constructor(detail: AskTransportDetail) {
    super('webhook timeout');
    this.name = 'AskWebhookTimeoutError';
    this.detail = detail;
  }
}

/** webhook 返回了非 2xx。 */
export class AskWebhookHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly detail: AskTransportDetail;

  constructor(status: number, body: unknown, detail: AskTransportDetail) {
    super(`webhook status ${status}`);
    this.name = 'AskWebhookHttpError';
    this.status = status;
    this.body = body;
    this.detail = detail;
  }
}

/** 连接被中断，或耗时还没到超时就收到了 ECONNABORTED / ETIMEDOUT。 */
export class AskWebhookConnectionError extends Error {
  readonly detail: AskTransportDetail;

  constructor(detail: AskTransportDetail) {
    super(detail.message);
    this.name = 'AskWebhookConnectionError';
    this.detail = detail;
  }
}

export function askPayloadBytes(payload: AskWebhookPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export function formatAskTransport(detail: AskTransportDetail): string {
  return `code=${detail.code ?? '-'} message=${detail.message} cause=${detail.cause ?? '-'} bytes=${detail.bytes} elapsedMs=${detail.elapsedMs}`;
}

function readCause(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isConnectMessage(message: string): boolean {
  const parts = message.split(';').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.startsWith('connect '));
}

/** 请求还没送到对端：连接/DNS 失败，或全是这类错误的 AggregateError。已有 HTTP 响应则不是。 */
function isConnectPhaseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isAxiosError(err) && err.response) return false;
  if ('response' in err && (err as { response?: unknown }).response) return false;

  const code = isAxiosError(err) ? err.code : errnoCode(err);
  const message = err instanceof Error ? err.message : '';
  if (code && PRE_CONNECT_CODES.has(code)) return true;
  if (code && CONNECT_CODES.has(code) && isConnectMessage(message)) return true;

  const cause = isAxiosError(err)
    ? err.cause
    : (err as { cause?: unknown }).cause;
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors.every((item) => isConnectPhaseError(item));
  }
  return false;
}

/** 连接已经建立，axios 一直等到 timeoutSec 才中断。这种请求可能已经送达，不能重试。 */
function isDeliveredTimeout(err: unknown, elapsedMs: number, timeoutMs: number): boolean {
  if (isConnectPhaseError(err)) return false;
  if (isAxiosError(err) && err.response) return false;
  const code = isAxiosError(err) ? err.code : errnoCode(err);
  if (code !== 'ECONNABORTED' && code !== 'ETIMEDOUT') return false;
  return elapsedMs + 1000 >= timeoutMs;
}

function readTransport(err: unknown, bytes: number, elapsedMs: number): AskTransportDetail {
  const axiosErr = isAxiosError(err) ? err : undefined;
  const cause = axiosErr?.cause ?? (err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined);
  return {
    code: axiosErr?.code,
    message: axiosErr?.message ?? (err instanceof Error ? err.message : String(err)),
    cause: readCause(cause),
    bytes,
    elapsedMs,
  };
}

export interface AskWebhookCallOptions {
  timeoutSec?: number;
  /** 连接失败后的额外次数。默认 2，一共 3 次 */
  retries?: number;
  retryDelaySec?: number;
}

/** 把 /ask 问题转发给外部 webhook。headers 原样附带，Content-Type 固定为 JSON。 */
export async function postAskWebhook(
  webhookUrl: string,
  payload: AskWebhookPayload,
  headers: Record<string, string>,
  options: AskWebhookCallOptions = {},
): Promise<void> {
  const timeoutSec = Math.max(1, options.timeoutSec ?? 60);
  const retries = Math.max(0, options.retries ?? 2);
  const retryDelaySec = Math.max(0, options.retryDelaySec ?? 3);
  const total = retries + 1;
  const timeout = timeoutSec * 1000;
  const bytes = askPayloadBytes(payload);
  const httpsUrl = webhookUrl.startsWith('https://');

  for (let attempt = 1; attempt <= total; attempt += 1) {
    const started = Date.now();
    logInfo('Ask', `webhook POST attempt ${attempt}/${total} bytes=${bytes} images=${payload.images?.length ?? 0} timeoutSec=${timeoutSec}`);
    try {
      await axios.post(webhookUrl, payload, {
        timeout,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        ...(httpsUrl ? { httpsAgent: connectAgent } : {}),
      });
      return;
    } catch (err) {
      const elapsedMs = Date.now() - started;
      const detail = readTransport(err, bytes, elapsedMs);
      const line = formatAskTransport(detail);
      if (isAxiosError(err) && err.response) {
        logError('Ask', `webhook 非 2xx status=${err.response.status} ${line} body=`, err.response.data);
        throw new AskWebhookHttpError(err.response.status, err.response.data, detail);
      }
      if (isDeliveredTimeout(err, elapsedMs, timeout)) {
        logWarn('Ask', `webhook 超时 ${line}，请求可能已送达`);
        throw new AskWebhookTimeoutError(detail);
      }
      if (isConnectPhaseError(err) && attempt < total) {
        const delaySec = retryDelaySec * attempt;
        logWarn('Ask', `webhook 重试 attempt ${attempt + 1}/${total} code=${detail.code ?? '-'} elapsedMs=${elapsedMs} delaySec=${delaySec}`);
        if (delaySec > 0) await sleep(delaySec * 1000);
        continue;
      }
      logError('Ask', `webhook 连接失败 ${line}`);
      throw new AskWebhookConnectionError(detail);
    }
  }
}
