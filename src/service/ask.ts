import axios, { isAxiosError } from 'axios';

export interface AskWebhookPayload {
  question: string;
  groupId: string;
  userId: string;
  repo: string;
  msgId?: string;
}

/** 请求已发出，但在超时时间内没有收到响应。 */
export class AskWebhookTimeoutError extends Error {
  constructor() {
    super('webhook timeout');
    this.name = 'AskWebhookTimeoutError';
  }
}

/** webhook 返回了非 2xx。 */
export class AskWebhookHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`webhook status ${status}`);
    this.name = 'AskWebhookHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 把 /ask 问题转发给外部 webhook。headers 原样附带，Content-Type 固定为 JSON。 */
export async function postAskWebhook(
  webhookUrl: string,
  payload: AskWebhookPayload,
  headers: Record<string, string>,
  timeoutSec = 60,
): Promise<void> {
  const timeout = Math.max(1, timeoutSec) * 1000;
  try {
    await axios.post(webhookUrl, payload, {
      timeout,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    if (isAxiosError(err)) {
      const code = err.code;
      if ((code === 'ECONNABORTED' || code === 'ETIMEDOUT') && !err.response) {
        throw new AskWebhookTimeoutError();
      }
      if (err.response) {
        throw new AskWebhookHttpError(err.response.status, err.response.data);
      }
    }
    throw err;
  }
}
