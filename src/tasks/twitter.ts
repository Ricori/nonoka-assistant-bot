import { AsyncTask, SimpleIntervalJob } from 'toad-scheduler';
import { config } from '@/core/config';
import { notifyAdmin, runtimeState, sendGroupMessages } from '@/core/bot';
import storage from '@/core/storage';
import scheduler, { type ScheduledJob } from '@/core/scheduler';
import { logDebug, logError, logInfo } from '@/core/logger';
import { getLatestTweets } from '@/service/twitter/tweet';
import { createMsgFromTweetId } from '@/service/twitter/message';

let consecutiveFailCount = 0;
const MAX_TWEET_FAIL = 3;
const tweetFailRecords = new Map<string, { tweetId: string; failCount: number }>();

const RETRY_INTERVAL = 60 * 1000;
const TICK_SECONDS = 10;
let nextRunAt = 0;

function scheduleNext(nextReadyInS?: number) {
  nextRunAt = Date.now() + (nextReadyInS === undefined ? RETRY_INTERVAL : nextReadyInS * 1000);
}

async function pushLatestTweetForUser(username: string, groupIds: string[], latestTweet: { tweetId: string; time: number }) {
  const preTime = storage.getTwitterLatestTweetTime(username);
  if (latestTweet.time <= preTime) return;

  const msgs = await createMsgFromTweetId(latestTweet.tweetId).catch((err) => {
    logError('TwitterTask', `生成推文消息失败 (${username}):`, err);
    return undefined;
  });

  if (!msgs?.length) {
    const record = tweetFailRecords.get(username);
    const failCount = (record?.tweetId === latestTweet.tweetId ? record.failCount : 0) + 1;
    if (failCount >= MAX_TWEET_FAIL) {
      tweetFailRecords.delete(username);
      storage.setTwitterLatestTweetTime(username, latestTweet.time);
      logError('TwitterTask', `放弃推文 ${latestTweet.tweetId} (${username})，已失败 ${failCount} 次`);
    } else {
      tweetFailRecords.set(username, { tweetId: latestTweet.tweetId, failCount });
    }
    return;
  }

  tweetFailRecords.delete(username);
  storage.setTwitterLatestTweetTime(username, latestTweet.time);
  logInfo('TwitterTask', `推送 ${username} 推文 ${latestTweet.tweetId} 到 ${groupIds.length} 个群: ${groupIds.join(', ')}`);
  for (const groupId of groupIds) {
    await sendGroupMessages(groupId, msgs);
  }
}

async function checkLatestTweet() {
  const groupConfig = config.tweetPush.config;
  const usernames = Object.keys(groupConfig);
  if (usernames.length === 0) return;

  const result = await getLatestTweets(usernames);
  scheduleNext(result?.nextReadyInS);

  if (!result || result.failed) {
    consecutiveFailCount += 1;
    if (consecutiveFailCount === 10) {
      scheduler.stopById('twitterPush');
      await notifyAdmin('Twitter 推送连续失败 10 次，已自动停止任务。');
      return;
    }
    if (consecutiveFailCount % 5 === 0) {
      logError('TwitterTask', `连续拉取失败 ${consecutiveFailCount} 次`);
      await notifyAdmin(`Twitter 拉取连续失败 ${consecutiveFailCount} 次。`);
    }
    return;
  }
  consecutiveFailCount = 0;
  logDebug('TwitterTask', `拉取 ${usernames.length} 个账号完成，下次间隔 ${result.nextReadyInS ?? 60}s`);

  for (const username of usernames) {
    const groupIds = groupConfig[username];
    const latest = result.tweets.find((item) => item.username === username);
    if (Array.isArray(groupIds) && groupIds.length > 0 && latest) {
      try {
        await pushLatestTweetForUser(username, groupIds, latest);
      } catch (err) {
        logError('TwitterTask', `推送 ${username} 异常:`, err);
      }
    }
  }
}

const task = new AsyncTask('twitterTask', async () => {
  if (Date.now() < nextRunAt) return;
  if (!runtimeState.ready || !config.tweetPush.enable || !config.nonokaService.apiKey) return;
  await checkLatestTweet();
});

const TwitterPushJob: ScheduledJob = {
  id: 'twitterPush',
  label: 'Twitter 推文推送',
  job: new SimpleIntervalJob({ seconds: TICK_SECONDS }, task, { id: 'twitterPush', preventOverrun: true }),
  init: () => {
    nextRunAt = 0;
    consecutiveFailCount = 0;
    const now = Date.now();
    Object.keys(config.tweetPush.config).forEach((username) => {
      storage.setTwitterLatestTweetTime(username, now);
    });
  },
};

export default TwitterPushJob;
