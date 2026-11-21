import 'dotenv/config';
import { GroupMessageEvent, PrivateMessageEvent } from 'qq-official-bot';
import { bot, botMode, runtimeState } from '@/core/bot';
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
import { getCleanText, getOwnImageUrls } from '@/utils/message';

async function dispatchGroup(event: GroupMessageEvent) {
  storage.noteGroup(event.group_id);
  storage.cacheMessage(event.msg_idx, getCleanText(event.raw_message), getOwnImageUrls(event.message));

  if (await handleCommand(event)) return;
  if (await handleImageSearch(event)) return;
  if (await handleLocalPic(event)) return;
  if (await handleHPic(event)) return;
  await handleRepeater(event);
}

async function dispatchPrivate(event: PrivateMessageEvent) {
  storage.cacheMessage(event.msg_idx, getCleanText(event.raw_message), getOwnImageUrls(event.message));

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
  if ('group_id' in event && typeof event.group_id === 'string') {
    storage.noteGroup(event.group_id);
  }
  logInfo('Notice', event);
});

async function main() {
  scheduler.loadJobs([BilibiliPushJob, TwitterPushJob, YtLivePushJob]);
  new AssistantAdmin().start();

  await bot.start();
  runtimeState.ready = true;
  logInfo('Main', `nonoka-assistant-bot 已启动 (mode=${botMode})`);
}

main().catch((err) => {
  logError('Main', '启动失败:', err);
  process.exit(1);
});
