import { segment, type Sendable } from 'qq-official-bot';
import { bot } from '@/core/bot';
import { logWarn } from '@/core/logger';
import { getTweetPost } from './tweet';
import { createTweetScreenshot } from './screenshot';

/** 根据推文 ID 生成可发送的消息列表（优先 Markdown 图文混排，视频单独发送） */
export async function createMsgFromTweetId(tweetId: string): Promise<Sendable[] | undefined> {
  const tweet = await getTweetPost(tweetId);
  if (!tweet) return undefined;

  const messages: Sendable[] = [];
  const mdLines: string[] = [];

  const screenshotBuf = await createTweetScreenshot(tweet);
  if (screenshotBuf) {
    try {
      const uploaded = await bot.materialService.uploadImage(screenshotBuf, {
        fileName: `tweet_${tweetId}.png`,
        contentType: 'image/png',
      });
      mdLines.push(`![推文截图](${uploaded.url})`);
    } catch (err) {
      logWarn('Twitter', `素材接口上传截图失败，退回普通图片发送: ${err instanceof Error ? err.message : String(err)}`);
      messages.push(segment.image(screenshotBuf));
    }
  } else {
    // 截图失败时降级为纯 Markdown 文本，保证推文不漏推
    mdLines.push(`### ${tweet.username} (@${tweet.userScreenName})`);
    if (tweet.tweetText) mdLines.push(tweet.tweetText);
    if (tweet.translatedText) mdLines.push(`> 译文：${tweet.translatedText}`);
  }

  for (const url of tweet.imgUrls.slice(0, 3)) {
    mdLines.push(`![推文图片](${url})`);
  }
  mdLines.push(`[查看原推文](${tweet.link})`);
  messages.push(segment.markdown(mdLines.join('\n\n')));

  for (const videoUrl of tweet.videoUrls.slice(0, 3)) {
    messages.push(segment.video(videoUrl));
  }

  return messages;
}
