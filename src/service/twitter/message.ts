import { segment, type Sendable } from 'qq-official-bot';
import { logWarn } from '@/core/logger';
import { uploadBufferAsMarkdownImage, uploadUrlAsMarkdownImage } from '@/service/material';
import { createUrlButton } from '@/utils/message';
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
      const imgMd = await uploadBufferAsMarkdownImage(screenshotBuf, {
        alt: '推文截图',
        fileNamePrefix: `tweet_${tweetId}`,
        contentType: 'image/png',
      });
      mdLines.push(imgMd);
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
    const imgMd = await uploadUrlAsMarkdownImage(url, {
      alt: '推文图片',
      fileNamePrefix: `tweet_media_${tweetId}`,
    });
    if (imgMd) mdLines.push(imgMd);
    else messages.push(segment.image(url));
  }
  const hasMarkdownImage = mdLines.some((line) => line.startsWith('!['));
  if (mdLines.length > 0) {
    messages.push([
      segment.markdown(mdLines.join('\n\n'), hasMarkdownImage ? { force_verify_image_resource: true } : undefined),
      createUrlButton('1', '查看原推文', tweet.link, 4),
    ]);
  } else {
    messages.push([
      segment.markdown(`### ${tweet.username} (@${tweet.userScreenName})`),
      createUrlButton('1', '查看原推文', tweet.link, 4),
    ]);
  }

  for (const videoUrl of tweet.videoUrls.slice(0, 3)) {
    messages.push(segment.video(videoUrl));
  }

  return messages;
}
