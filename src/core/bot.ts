import { Bot, ReceiverMode, type Sendable } from 'qq-official-bot';
import { config } from './config';
import { logError, logInfo } from './logger';

const appid = process.env.QQ_APPID?.trim();
const secret = process.env.QQ_SECRET?.trim();
if (!appid || !secret) {
  throw new Error('请先在 .env 中填写 QQ_APPID 和 QQ_SECRET');
}

export const botMode = process.env.QQ_MODE === 'webhook' ? ReceiverMode.WEBHOOK : ReceiverMode.WEBSOCKET;
const logLevel = (process.env.QQ_LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error') || 'info';

export const bot = botMode === ReceiverMode.WEBHOOK
  ? new Bot({
    appid,
    secret,
    removeAt: true,
    logLevel,
    intents: ['GROUP_AND_C2C_EVENT'],
    mode: ReceiverMode.WEBHOOK,
    port: Number(process.env.QQ_WEBHOOK_PORT || 3000),
    path: process.env.QQ_WEBHOOK_PATH || '/webhook',
  })
  : new Bot({
    appid,
    secret,
    removeAt: true,
    logLevel,
    maxRetry: 10,
    intents: ['GROUP_AND_C2C_EVENT'],
    mode: ReceiverMode.WEBSOCKET,
  });

export const runtimeState = {
  startedAt: Date.now(),
  ready: false,
};

/** 向指定群依次发送多条主动消息 */
export async function sendGroupMessages(groupId: string, messages: Sendable[]) {
  for (const msg of messages) {
    try {
      await bot.group(groupId).send(msg);
    } catch (err) {
      logError('Bot', `推送到群 ${groupId} 失败:`, err);
    }
  }
}

/** 通知首位管理员（需先与机器人建立过单聊） */
export async function notifyAdmin(text: string) {
  const adminId = config.admin[0];
  if (!adminId) return;
  try {
    await bot.user(adminId).send(text);
    logInfo('Bot', `已通知管理员 ${adminId}: ${text}`);
  } catch (err) {
    logError('Bot', `通知管理员 ${adminId} 失败:`, err);
  }
}
