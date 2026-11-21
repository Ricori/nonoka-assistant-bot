import { GroupMessageEvent } from 'qq-official-bot';
import { sendGroupMessages } from '@/core/bot';
import { isBotAdmin } from '@/core/permission';
import scheduler from '@/core/scheduler';
import { logInfo } from '@/core/logger';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { getCleanText, getRefIdx, type IncomingMessageEvent } from '@/utils/message';

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
  '/加图 <关键词>                   附带或引用图片入库',
  '/删图                           管理员引用 bot 发的图删除',
  '@bot 搜图 / 来源                 附带或引用图片以图搜源',
  '',
  '--- 管理员指令 ---',
  '/task <twitter|bilibili|youtube> <on|off>   控制定时推送任务',
  '/p <group_openid> <推文链接或ID>             推送推文到指定群',
  '/inspect                                    打印消息调试信息',
].join('\n');

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
      msgIdx: event.msg_idx,
      refIdx: getRefIdx(event),
      msgElements: event.msg_elements?.length ?? 0,
    };
    logInfo('Inspect', info);
    await event.reply(JSON.stringify(info, null, 2));
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
