import axios from 'axios';
import { segment, type Sendable } from 'qq-official-bot';
import { config } from '@/core/config';
import { logError } from '@/core/logger';
import { rewriteToCDN } from '@/service/cdn';
import { uploadUrlAsMarkdownImage } from '@/service/material';
import { createUrlButton } from '@/utils/message';

export interface YoutubeLiveStatus {
  isLive: boolean;
  videoId?: string;
  title?: string;
  thumbnail?: string;
}

export async function getYoutubeLiveStatus(channelName: string): Promise<YoutubeLiveStatus | null> {
  const { baseUrl, apiKey } = config.nonokaService;
  if (!baseUrl || !apiKey) return null;
  const url = `${baseUrl}/youtube/live-status/${encodeURIComponent(channelName)}?apikey=${apiKey}`;

  try {
    const res = await axios.get(url, { timeout: 20000 });
    if (!res.data?.success) return null;
    return res.data as YoutubeLiveStatus;
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } }; message?: string }).response?.data?.error
      ?? (err instanceof Error ? err.message : String(err));
    logError('YouTube', `查询直播状态失败 (${channelName}): ${msg}`);
    return null;
  }
}

async function buildThumbnailMarkdown(videoId: string | undefined, rawThumb?: string): Promise<string | null> {
  const candidates = [
    rawThumb,
    videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : undefined,
    videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : undefined,
  ]
    .filter((u): u is string => Boolean(u))
    .map((u) => rewriteToCDN(u));

  for (const url of [...new Set(candidates)]) {
    const imgMd = await uploadUrlAsMarkdownImage(url, {
      alt: '封面',
      fileNamePrefix: `yt_${videoId || 'live'}`,
    });
    if (imgMd) return imgMd;
  }
  return null;
}

export async function buildYoutubeLiveMessage(channelName: string, status: YoutubeLiveStatus): Promise<Sendable> {
  const lines = [`### ${status.title ?? `${channelName} 直播`} 开始了！`];
  const imgMd = await buildThumbnailMarkdown(status.videoId, status.thumbnail);
  if (imgMd) {
    lines.push(imgMd);
  }

  const liveUrl = `https://www.youtube.com/watch?v=${status.videoId}`;
  const translateUrl = `https://nonoka.live/live?channel=@${encodeURIComponent(channelName)}`;

  return [
    segment.markdown(lines.join('\n\n')),
    createUrlButton('1', '实时同传', translateUrl, 0),
    createUrlButton('2', '观看直播', liveUrl, 4),
  ];
}
