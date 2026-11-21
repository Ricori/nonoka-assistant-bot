import { Bot, ReceiverMode, type Sendable } from 'qq-official-bot';
import { config } from './config';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { summarizeSendable } from '@/utils/message';

const appid = config.qqBot.appid.trim();
const secret = config.qqBot.secret.trim();
if (!appid || !secret) {
  throw new Error('请先在 config.json 的 qqBot 中填写 appid 和 secret');
}

export const botMode = config.qqBot.mode === 'webhook' ? ReceiverMode.WEBHOOK : ReceiverMode.WEBSOCKET;
const { logLevel } = config.qqBot;

export const bot = botMode === ReceiverMode.WEBHOOK
  ? new Bot({
    appid,
    secret,
    removeAt: true,
    handleProcessErrors: false,
    logLevel,
    intents: ['GROUP_AND_C2C_EVENT'],
    mode: ReceiverMode.WEBHOOK,
    port: config.qqBot.webhookPort,
    path: config.qqBot.webhookPath,
  })
  : new Bot({
    appid,
    secret,
    removeAt: true,
    handleProcessErrors: false,
    logLevel,
    maxRetry: 10,
    intents: ['GROUP_AND_C2C_EVENT'],
    mode: ReceiverMode.WEBSOCKET,
  });

// 接管未捕获异常，避免被 SDK 默认降级到 debug 日志而静默丢失
process.on('unhandledRejection', (reason) => {
  logError('Process', 'UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  logError('Process', 'UncaughtException:', err);
});

/** 将 qq-official-bot 内部 log4js 日志桥接到项目 logger（跳过与 [Recv] 重复的 recv 行） */
function attachSdkLoggerBridge() {
  const sdkLogger = bot.logger as unknown as Record<string, (...args: unknown[]) => void>;
  const isSdkRecvLine = (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('recv from ');
  sdkLogger.info = (...args: unknown[]) => {
    if (!isSdkRecvLine(args)) logInfo('QQBot', ...args);
  };
  sdkLogger.warn = (...args: unknown[]) => {
    logWarn('QQBot', ...args);
  };
  sdkLogger.error = (...args: unknown[]) => {
    logError('QQBot', ...args);
  };
  sdkLogger.fatal = (...args: unknown[]) => {
    logError('QQBot', ...args);
  };
  sdkLogger.debug = (...args: unknown[]) => {
    logDebug('QQBot', ...args);
  };
  sdkLogger.trace = (...args: unknown[]) => {
    logDebug('QQBot', ...args);
  };
}

function safeSummary(message: Sendable): string {
  try {
    return summarizeSendable(message);
  } catch {
    return '[消息摘要解析失败]';
  }
}

function logSendResult(
  tag: 'Send' | 'Push',
  action: string,
  targetLabel: string,
  summary: string,
  res: { id?: string; audit_status?: string; reason?: string } | undefined,
) {
  if (res?.audit_status) {
    logWarn(tag, `${action}进入审核 ${targetLabel} audit_id=${res.id ?? '-'} status=${res.audit_status}${res.reason ? ` reason=${res.reason}` : ''}: ${summary}`);
    return;
  }
  if (!res?.id) {
    logWarn(tag, `${action}返回异常(无消息ID) ${targetLabel}: ${summary} res=`, res);
    return;
  }
  logInfo(tag, `${action} ${targetLabel} id=${res.id}: ${summary}`);
}

/** 统一拦截所有群聊/私聊/频道发送与回复，记录到实时日志 */
function attachOutgoingMessageLogger() {
  const svc = bot.messageService;
  const origGroupSend = svc.sendGroupMessage.bind(svc);
  const origPrivateSend = svc.sendPrivateMessage.bind(svc);
  const origDirectSend = svc.sendDirectMessage.bind(svc);
  const origGuildSend = svc.sendGuildMessage.bind(svc);
  const origStreamSend = svc.sendPrivateStreamMessage.bind(svc);

  svc.sendGroupMessage = async (groupId, message, source, options) => {
    const isPush = !source;
    const tag = isPush ? 'Push' : 'Send';
    const action = isPush ? '推送群消息' : '回复群消息';
    const targetLabel = `group_openid=${groupId}`;
    const summary = safeSummary(message);
    try {
      const res = await origGroupSend(groupId, message, source, options);
      logSendResult(tag, action, targetLabel, summary, res);
      return res;
    } catch (err) {
      logError(tag, `${action}失败 ${targetLabel} (${summary}):`, err);
      throw err;
    }
  };

  svc.sendPrivateMessage = async (userId, message, source, options) => {
    const isPush = !source;
    const tag = isPush ? 'Push' : 'Send';
    const action = isPush ? '主动私聊' : '回复私聊';
    const targetLabel = `user_openid=${userId}`;
    const summary = safeSummary(message);
    try {
      const res = await origPrivateSend(userId, message, source, options);
      logSendResult(tag, action, targetLabel, summary, res);
      return res;
    } catch (err) {
      logError(tag, `${action}失败 ${targetLabel} (${summary}):`, err);
      throw err;
    }
  };

  svc.sendDirectMessage = async (guildId, message, source, options) => {
    const isPush = !source;
    const tag = isPush ? 'Push' : 'Send';
    const action = isPush ? '主动频道私信' : '回复频道私信';
    const targetLabel = `guild=${guildId}`;
    const summary = safeSummary(message);
    try {
      const res = await origDirectSend(guildId, message, source, options);
      logSendResult(tag, action, targetLabel, summary, res);
      return res;
    } catch (err) {
      logError(tag, `${action}失败 ${targetLabel} (${summary}):`, err);
      throw err;
    }
  };

  svc.sendGuildMessage = async (channelId, message, source, options) => {
    const isPush = !source;
    const tag = isPush ? 'Push' : 'Send';
    const action = isPush ? '推送频道消息' : '回复频道消息';
    const targetLabel = `channel=${channelId}`;
    const summary = safeSummary(message);
    try {
      const res = await origGuildSend(channelId, message, source, options);
      logSendResult(tag, action, targetLabel, summary, res);
      return res;
    } catch (err) {
      logError(tag, `${action}失败 ${targetLabel} (${summary}):`, err);
      throw err;
    }
  };

  svc.sendPrivateStreamMessage = async (userId, payload) => {
    try {
      return await origStreamSend(userId, payload);
    } catch (err) {
      logError('Send', `私聊流式消息发送失败 user_openid=${userId}:`, err);
      throw err;
    }
  };
}

attachSdkLoggerBridge();
attachOutgoingMessageLogger();

export const runtimeState = {
  startedAt: Date.now(),
  ready: false,
};

/** 向指定群依次发送多条主动消息 */
export async function sendGroupMessages(groupId: string, messages: Sendable[]) {
  let sent = 0;
  let failed = 0;
  for (const msg of messages) {
    try {
      await bot.group(groupId).send(msg);
      sent += 1;
    } catch {
      failed += 1;
      // 发送失败已由 sendGroupMessage 拦截器记录，此处吞掉以继续后续发送
    }
  }
  return { total: messages.length, sent, failed };
}

/** 通知首位管理员（需先与机器人建立过单聊） */
export async function notifyAdmin(text: string) {
  const adminId = config.admin[0];
  if (!adminId) return;
  try {
    await bot.user(adminId).send(text);
  } catch {
    // 失败已由 sendPrivateMessage 拦截器记录
  }
}
