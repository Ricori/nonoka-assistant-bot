import { AsyncTask, SimpleIntervalJob } from 'toad-scheduler';
import { config } from '@/core/config';
import { runtimeState, sendGroupMessages } from '@/core/bot';
import storage from '@/core/storage';
import { logError, logInfo } from '@/core/logger';
import type { ScheduledJob } from '@/core/scheduler';
import { buildBiliMessage, getBiliDynamic } from '@/service/bilibili/dynamic';

async function checkBiliDynamic(uid: string, groupIds: string[]) {
  try {
    const dy = await getBiliDynamic(uid);
    if (!dy || dy.pubDate <= storage.getBiliLatestDynamicTime(uid)) return;
    storage.setBiliLatestDynamicTime(uid, dy.pubDate);

    const msg = await buildBiliMessage(uid, dy);
    if (!msg) return;
    logInfo('BiliTask', `推送 UP(${uid}) 动态到 ${groupIds.length} 个群`);
    for (const groupId of groupIds) {
      await sendGroupMessages(groupId, [msg]);
    }
  } catch (err) {
    logError('BiliTask', `检查 UID(${uid}) 异常:`, err);
  }
}

const task = new AsyncTask('biliTask', async () => {
  const { enable, cookie, config: map } = config.biliDynamicPush;
  if (!enable || !cookie || !runtimeState.ready) return;
  Object.entries(map)
    .filter(([, groupIds]) => Array.isArray(groupIds) && groupIds.length > 0)
    .forEach(([uid, groupIds], i) => {
      setTimeout(() => {
        checkBiliDynamic(uid, groupIds).catch(() => {});
      }, i * 2000);
    });
});

const BilibiliPushJob: ScheduledJob = {
  id: 'bilibiliNewShared',
  label: 'B站动态推送',
  job: new SimpleIntervalJob({ seconds: 180 }, task, { id: 'bilibiliNewShared', preventOverrun: true }),
  init: () => {
    const now = Date.now();
    Object.keys(config.biliDynamicPush.config).forEach((uid) => {
      storage.setBiliLatestDynamicTime(uid, now);
    });
  },
};

export default BilibiliPushJob;
