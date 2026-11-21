import { GroupMessageEvent, segment } from 'qq-official-bot';
import { sendGroupMessages } from '@/core/bot';
import { isBotAdmin, isGroupManager } from '@/core/permission';
import scheduler from '@/core/scheduler';
import { logError, logInfo } from '@/core/logger';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { sendSegmentedVoice, TTS_MAX_TOTAL_LENGTH } from '@/service/tts';
import { getCleanText, getRefIdx, type IncomingMessageEvent } from '@/utils/message';

const DEFAULT_BAN_MINUTES = 10;
const MAX_BAN_MINUTES = 30 * 24 * 60;

const TASK_IDS = new Map([
  ['twitter', 'twitterPush'],
  ['bilibili', 'bilibiliNewShared'],
  ['youtube', 'ytLivePush'],
]);

const HELP_TEXT = [
  '=== Nonoka Assistant 指令 ===',
  '/help                           查看帮助与当前会话 ID',
  '/ping                           连通性检查',
  '/p <推文链接或ID>                推送指定推文到当前会话',
  '/tts <文本>                     文字转语音（带假名自动按日文念）',
  '/ban <@某人|member_openid> [分钟] 管理员禁言成员（默认10分钟，0解除）',
  '/加图 <关键词>                   附带或引用图片入库',
  '/删图                           管理员引用 bot 发的图删除',
  '@bot 搜图 / 来源                 附带或引用图片以图搜源',
  '',
  '--- 管理员指令 ---',
  '/task <twitter|bilibili|youtube> <on|off>   控制定时推送任务',
  '/p <group_openid> <推文链接或ID>             推送推文到指定群',
  '/inspect                                    打印消息调试信息',
].join('\n');

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

export async function handleCommand(event: IncomingMessageEvent): Promise<boolean> {
  const cleanText = getCleanText(event.raw_message);
  if (!cleanText.startsWith('/')) return false;

  const isGroup = event instanceof GroupMessageEvent;

  if (cleanText === '/help') {
    const meta = isGroup
      ? `group_openid: ${event.group_id}\nuser_id: ${event.user_id}`
      : `user_id: ${event.user_id}`;
    await event.reply(`${HELP_TEXT}\n\n${meta}`);
    return true;
  }

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

  // 管理员跨群推文：/p <group_openid> <tweetUrl|tweetId>
  const adminPush = cleanText.match(/^\/p\s+([A-Za-z0-9_-]{16,64})\s+(?:\S*status\/)?(\d+)(?:[?#/]\S*)?\s*$/);
  if (adminPush && isBotAdmin(event.user_id)) {
    const [, targetGroupId, tweetId] = adminPush;
    const msgs = await createMsgFromTweetId(tweetId);
    if (!msgs?.length) {
      await event.reply(`获取推文 ${tweetId} 失败`);
      return true;
    }
    await sendGroupMessages(targetGroupId, msgs);
    await event.reply(`已推送推文 ${tweetId} 到群 ${targetGroupId}`);
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
