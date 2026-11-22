import axios, { isAxiosError } from 'axios';
import { logError, logInfo, logWarn } from '@/core/logger';

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

/** 把 /ask 问题转发给外部 webhook。headers 原样附带，Content-Type 固定为 JSON。 */
export async function postAskWebhook(
  webhookUrl: string,
  payload: AskWebhookPayload,
  headers: Record<string, string>,
  timeoutSec = 60,
): Promise<void> {
  const timeout = Math.max(1, timeoutSec) * 1000;
  const bytes = askPayloadBytes(payload);
  const started = Date.now();
  logInfo('Ask', `webhook POST bytes=${bytes} images=${payload.images?.length ?? 0} timeoutSec=${timeoutSec}`);
  try {
    await axios.post(webhookUrl, payload, {
      timeout,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const detail = readTransport(err, bytes, elapsedMs);
    const line = formatAskTransport(detail);
    if (isAxiosError(err) && err.response) {
      logError('Ask', `webhook 非 2xx status=${err.response.status} ${line} body=`, err.response.data);
      throw new AskWebhookHttpError(err.response.status, err.response.data, detail);
    }
    const code = isAxiosError(err) ? err.code : undefined;
    const aborted = (code === 'ECONNABORTED' || code === 'ETIMEDOUT') && !(isAxiosError(err) && err.response);
    if (aborted && elapsedMs + 1000 >= timeout) {
      logWarn('Ask', `webhook 超时 ${line}，请求可能已送达`);
      throw new AskWebhookTimeoutError(detail);
    }
    logError('Ask', `webhook 连接失败 ${line}`);
    throw new AskWebhookConnectionError(detail);
  }
}
