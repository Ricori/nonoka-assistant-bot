import { AsyncTask, SimpleIntervalJob } from 'toad-scheduler';
import { config } from '@/core/config';
import { runtimeState, sendGroupMessages } from '@/core/bot';
import storage from '@/core/storage';
import { logError, logInfo } from '@/core/logger';
import type { ScheduledJob } from '@/core/scheduler';
import { buildYoutubeLiveMessage, getYoutubeLiveStatus } from '@/service/youtube/live';

const checkedChannels = new Set<string>();

async function checkYtLive(channelName: string, groupIds: string[]) {
  try {
    const status = await getYoutubeLiveStatus(channelName);
    if (!status) return;

    const isFirstCheck = !checkedChannels.has(channelName);
    checkedChannels.add(channelName);

    if (!status.isLive || !status.videoId) return;
    if (storage.hasYtPushedVideoId(channelName, status.videoId)) return;
    storage.addYtPushedVideoId(channelName, status.videoId);
    if (isFirstCheck) return;

    const msg = await buildYoutubeLiveMessage(channelName, status);
    logInfo('YtLiveTask', `推送 ${channelName} 开播 (${status.videoId}) 到 ${groupIds.length} 个群`);
    for (const groupId of groupIds) {
      await sendGroupMessages(groupId, [msg]);
    }
  } catch (err) {
    logError('YtLiveTask', `检查频道 ${channelName} 异常:`, err);
  }
}

const task = new AsyncTask('ytLiveTask', async () => {
  if (!runtimeState.ready || !config.ytLivePush.enable || !config.nonokaService.apiKey) return;
  Object.entries(config.ytLivePush.config)
    .filter(([, groupIds]) => Array.isArray(groupIds) && groupIds.length > 0)
    .forEach(([channelName, groupIds], i) => {
      setTimeout(() => {
        checkYtLive(channelName, groupIds).catch(() => {});
      }, i * 1500);
    });
});

const YtLivePushJob: ScheduledJob = {
  id: 'ytLivePush',
  label: 'YouTube 开播推送',
  job: new SimpleIntervalJob({ seconds: 180 }, task, { id: 'ytLivePush', preventOverrun: true }),
};

export default YtLivePushJob;
