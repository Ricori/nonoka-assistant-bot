import { GroupMessageEvent, segment } from 'qq-official-bot';
import { sendGroupMessages } from '@/core/bot';
import { config } from '@/core/config';
import { isBotAdmin, isGroupManager } from '@/core/permission';
import scheduler from '@/core/scheduler';
import { logError, logInfo } from '@/core/logger';
import { postAskWebhook } from '@/service/ask';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { sendSegmentedVoice, TTS_MAX_TOTAL_LENGTH } from '@/service/tts';
import { getCleanText, getRefIdx, type IncomingMessageEvent } from '@/utils/message';

const ASK_QUESTION_MAX = 2000;
const askLastAt = new Map<string, number>();

const DEFAULT_BAN_MINUTES = 10;
const MAX_BAN_MINUTES = 30 * 24 * 60;

const TASK_IDS = new Map([
  ['twitter', 'twitterPush'],
  ['bilibili', 'bilibiliNewShared'],
  ['youtube', 'ytLivePush'],
]);

async function handleTTS(event: IncomingMessageEvent, text: string) {
  const lang = /[぀-ヿ]/.test(text) ? 'ja' : 'zh';
  if (text.trim().length > TTS_MAX_TOTAL_LENGTH) {
    await event.reply(`文本太长，最多 ${TTS_MAX_TOTAL_LENGTH} 字`);
    return;
  }

  const { sent, rest } = await sendSegmentedVoice(
    text,
    (audio) => event.reply(segment.audio(audio.dataUri, { name: audio.fileName })),
    { lang },
  );
  if (!sent) {
    await event.reply('TTS 合成失败');
  } else if (rest) {
    await event.reply(`这段没合成出来：${rest}`);
  }
}

async function handleBan(event: GroupMessageEvent, cleanText: string) {
  if (!isGroupManager(event)) {
    await event.reply('只有管理员可以禁言');
    return;
  }

  // 优先取被 @ 的目标成员（排除机器人自身），否则从参数里解析 member_openid
  const mentionedTarget = event.mentions?.find((m) => !m.is_you)?.member_openid;
  const parts = cleanText.replace(/^\/ban\b/, '').trim().split(/\s+/).filter(Boolean);

  let targetOpenId = mentionedTarget;
  let minutesStr: string | undefined;

  if (targetOpenId) {
    minutesStr = parts.find((p) => /^\d+$/.test(p));
  } else if (parts[0] && /^[A-Za-z0-9_-]{16,64}$/.test(parts[0])) {
    targetOpenId = parts[0];
    minutesStr = parts[1];
  }

  if (!targetOpenId) {
    await event.reply(`用法：/ban @某人 [分钟]（或填 member_openid），默认 ${DEFAULT_BAN_MINUTES} 分钟，0 为解除禁言`);
    return;
  }

  const minutes = minutesStr === undefined ? DEFAULT_BAN_MINUTES : Number(minutesStr);
  if (Number.isNaN(minutes) || minutes < 0) {
    await event.reply('分钟数必须是非负整数');
    return;
  }
  if (minutes > MAX_BAN_MINUTES) {
    await event.reply(`禁言最长 ${MAX_BAN_MINUTES} 分钟（30 天）`);
    return;
  }

  try {
    if (minutes === 0) {
      await event.group.unmute(targetOpenId);
      await event.reply(`已解除 ${targetOpenId} 的禁言`);
    } else {
      const expireAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      await event.group.mute(targetOpenId, expireAt);
      await event.reply(`已禁言 ${targetOpenId} ${minutes} 分钟`);
    }
    logInfo('Command', `${event.user_id} 在群 ${event.group_id} 禁言 ${targetOpenId} ${minutes} 分钟`);
  } catch (err) {
    logError('Command', '禁言失败:', err);
    await event.reply('禁言失败（机器人无群管权限、对方是管理员或不在群内）');
  }
}

async function handleAsk(event: GroupMessageEvent, cleanText: string) {
  const groupId = event.group_id;
  const repo = config.ask.github.groups[groupId];
  if (!repo) return;

  const question = cleanText.replace(/^\/ask\b/, '').trim();
  if (!question) {
    await event.reply('用法：/ask <问题>');
    return;
  }
  if (question.length > ASK_QUESTION_MAX) {
    await event.reply(`问题太长，最多 ${ASK_QUESTION_MAX} 字`);
    return;
  }

  const webhookUrl = config.ask.github.webhookUrl.trim();
  if (!webhookUrl) {
    await event.reply('代码问答未启用');
    return;
  }

  const cooldownMs = Math.max(0, config.ask.github.cooldownSec) * 1000;
  const now = Date.now();
  const remainMs = (askLastAt.get(groupId) ?? 0) + cooldownMs - now;
  if (cooldownMs > 0 && remainMs > 0) {
    await event.reply(`提问太频繁，请 ${Math.ceil(remainMs / 1000)} 秒后再试`);
    return;
  }
  askLastAt.set(groupId, now);

  const msgId = event.message_id || event.id || '';
  try {
    await event.reply('收到，正在查阅代码，稍后回复～');
  } catch (err) {
    askLastAt.delete(groupId);
    throw err;
  }

  logInfo('Ask', `${event.user_id} 在群 ${groupId} 提问 repo=${repo}`);
  const payload = {
    question,
    groupId,
    userId: event.user_id,
    repo,
    ...(msgId ? { msgId } : {}),
  };
  const headers = { ...config.ask.github.headers };
  void postAskWebhook(webhookUrl, payload, headers).catch((err) => {
    logError('Ask', `webhook 请求失败 group=${groupId}:`, err);
    event.reply('代码查询失败，请稍后再试').catch((replyErr) => {
      logError('Ask', '失败提示发送失败:', replyErr);
    });
  });
}

export async function handleCommand(event: IncomingMessageEvent): Promise<boolean> {
  const cleanText = getCleanText(event.raw_message);
  if (!cleanText.startsWith('/')) return false;

  const isGroup = event instanceof GroupMessageEvent;

  if (cleanText === '/ping') {
    await event.reply(`pong! (${new Date().toLocaleTimeString('zh-CN', { hour12: false })})`);
    return true;
  }

  if (cleanText === '/inspect') {
    const info = {
      type: isGroup ? `group(${event.sub_type})` : 'private',
      groupId: isGroup ? event.group_id : undefined,
      userId: event.user_id,
      permissions: event.sender?.permissions,
      mentions: isGroup ? event.mentions : undefined,
      msgIdx: event.msg_idx,
      refIdx: getRefIdx(event),
      msgElements: event.msg_elements?.length ?? 0,
    };
    logInfo('Inspect', info);
    await event.reply(JSON.stringify(info, null, 2));
    return true;
  }

  const ttsMatch = cleanText.match(/^\/tts\s+(.+)$/s);
  if (ttsMatch) {
    await handleTTS(event, ttsMatch[1]);
    return true;
  }

  if (/^\/ban(\s|$)/.test(cleanText)) {
    if (!isGroup) {
      await event.reply('请在群聊中使用 /ban');
      return true;
    }
    await handleBan(event, cleanText);
    return true;
  }

  if (/^\/ask(\s|$)/.test(cleanText)) {
    if (!isGroup) {
      await event.reply('请在群聊中使用 /ask');
      return true;
    }
    await handleAsk(event, cleanText);
    return true;
  }

  // 管理员跨群推文：/p <group_openid> <tweetUrl|tweetId>
  const adminPush = cleanText.match(/^\/p\s+([A-Za-z0-9_-]{16,64})\s+(?:\S*status\/)?(\d+)(?:[?#/]\S*)?\s*$/);
  if (adminPush && isBotAdmin(event.user_id)) {
    const [, targetGroupId, tweetId] = adminPush;
    const msgs = await createMsgFromTweetId(tweetId);
    if (!msgs?.length) {
      await event.reply(`获取推文 ${tweetId} 失败`);
      return true;
    }
    const res = await sendGroupMessages(targetGroupId, msgs);
    if (res.failed > 0) {
      await event.reply(`推文 ${tweetId} 推送到群 ${targetGroupId}：成功 ${res.sent}/${res.total}，失败 ${res.failed}（详见日志）`);
    } else {
      await event.reply(`已推送推文 ${tweetId} 到群 ${targetGroupId}`);
    }
    return true;
  }

  // 当前会话推文：/p <tweetUrl|tweetId>
  const localPush = cleanText.match(/^\/p\s+(?:\S*status\/)?(\d+)(?:[?#/]\S*)?\s*$/);
  if (localPush) {
    const tweetId = localPush[1];
    const msgs = await createMsgFromTweetId(tweetId);
    if (!msgs?.length) {
      await event.reply(`获取推文 ${tweetId} 失败`);
      return true;
    }
    for (const msg of msgs) {
      await event.reply(msg);
    }
    return true;
  }

  // 管理员控制定时任务：/task <name> <on|off>
  const taskMatch = cleanText.match(/^\/task\s+(\w+)\s+(on|off)$/);
  if (taskMatch) {
    if (!isBotAdmin(event.user_id)) {
      await event.reply('只有管理员可以控制定时任务');
      return true;
    }
    const taskId = TASK_IDS.get(taskMatch[1]);
    if (!taskId) {
      await event.reply('不支持的任务名，可选：twitter | bilibili | youtube');
      return true;
    }
    const enable = taskMatch[2] === 'on';
    if (enable) scheduler.startById(taskId);
    else scheduler.stopById(taskId);
    await event.reply(`任务 ${taskMatch[1]} 已${enable ? '开启' : '停止'}`);
    return true;
  }

  return false;
}
