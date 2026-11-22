import axios from 'axios';

export interface AskWebhookPayload {
  question: string;
  groupId: string;
  userId: string;
  repo: string;
  msgId?: string;
}

/** 把 /ask 问题转发给外部 webhook。headers 原样附带，Content-Type 固定为 JSON。 */
export async function postAskWebhook(
  webhookUrl: string,
  payload: AskWebhookPayload,
  headers: Record<string, string>,
): Promise<void> {
  await axios.post(webhookUrl, payload, {
    timeout: 10_000,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });
}
