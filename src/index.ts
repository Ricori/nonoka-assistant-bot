import { GroupMessageEvent, PrivateMessageEvent } from 'qq-official-bot';
import { bot, botMode, runtimeState } from '@/core/bot';
import { syncGroupCommandPanel } from '@/core/commandPanel';
import { logError, logInfo } from '@/core/logger';
import scheduler from '@/core/scheduler';
import storage from '@/core/storage';
import { AssistantAdmin } from '@/admin';
import { handleCommand } from '@/modules/command';
import { handleImageSearch } from '@/modules/imageSearch';
import { handleLocalPic } from '@/modules/localPic';
import { handleHPic } from '@/modules/hPic';
import { handleRepeater } from '@/modules/repeater';
import BilibiliPushJob from '@/tasks/bilibili';
import TwitterPushJob from '@/tasks/twitter';
import YtLivePushJob from '@/tasks/youtube';
import { formatIncomingPreview, getCleanText, getOwnImageUrls } from '@/utils/message';

async function dispatchGroup(event: GroupMessageEvent) {
  storage.noteGroup(event.group_id);
  const cleanText = getCleanText(event.raw_message);
  const imgUrls = getOwnImageUrls(event.message);
  const preview = formatIncomingPreview(event.raw_message, imgUrls);
  const userName = event.sender?.member_nickname || event.sender?.user_name || '';

  storage.cacheMessage(event.msg_idx, cleanText, imgUrls);
  storage.recordIncomingMessage({
    scene: 'group',
    subType: event.sub_type,
    groupId: event.group_id,
    userId: event.user_id,
    userName: userName || undefined,
    content: preview,
    imageCount: imgUrls.length,
  });

  const senderLabel = userName ? `${userName}(${event.user_id})` : event.user_id;
  const kindLabel = event.sub_type === 'at' ? '@bot' : '普通';
  logInfo('Recv', `群消息 group_openid=${event.group_id} user=${senderLabel} [${kindLabel}]: ${preview}`);

  if (await handleCommand(event)) return;
  if (await handleImageSearch(event)) return;
  if (await handleLocalPic(event)) return;
  if (await handleHPic(event)) return;
  await handleRepeater(event);
}

async function dispatchPrivate(event: PrivateMessageEvent) {
  const cleanText = getCleanText(event.raw_message);
  const imgUrls = getOwnImageUrls(event.message);
  const preview = formatIncomingPreview(event.raw_message, imgUrls);
  const userName = event.sender?.member_nickname || event.sender?.user_name || '';

  storage.cacheMessage(event.msg_idx, cleanText, imgUrls);
  storage.recordIncomingMessage({
    scene: 'private',
    subType: event.sub_type,
    userId: event.user_id,
    userName: userName || undefined,
    content: preview,
    imageCount: imgUrls.length,
  });

  const senderLabel = userName ? `${userName}(${event.user_id})` : event.user_id;
  logInfo('Recv', `私聊消息 user_openid=${senderLabel} [${event.sub_type}]: ${preview}`);

  if (await handleCommand(event)) return;
  if (await handleImageSearch(event)) return;
  await handleHPic(event);
}

bot.on('message.group', (event) => {
  dispatchGroup(event).catch((err) => logError('GroupFlow', err));
});

bot.on('message.private', (event) => {
  dispatchPrivate(event).catch((err) => logError('PrivateFlow', err));
});

bot.on('notice.group', (event) => {
  const groupId = 'group_id' in event && typeof event.group_id === 'string' ? event.group_id : undefined;
  const subType = 'sub_type' in event && typeof event.sub_type === 'string' ? event.sub_type : 'unknown';
  if (groupId) {
    storage.noteGroup(groupId);
    logInfo('Notice', `群事件 [${subType}] group_openid=${groupId}`);
  } else {
    logInfo('Notice', `群事件 [${subType}]`, event);
  }
});

bot.on('message.audit.reject', (event) => {
  logError('Audit', '消息审核被拒绝:', event);
});

bot.on('message.audit.pass', (event) => {
  logInfo('Audit', '消息审核已通过:', event);
});

async function main() {
  scheduler.loadJobs([BilibiliPushJob, TwitterPushJob, YtLivePushJob]);
  new AssistantAdmin().start();

  await bot.start();
  runtimeState.ready = true;
  await syncGroupCommandPanel();
  logInfo('Main', `nonoka-assistant-bot 已启动 (mode=${botMode})`);
}

main().catch((err) => {
  logError('Main', '启动失败:', err);
  process.exit(1);
});
