import axios from 'axios';
import { segment, type Sendable } from 'qq-official-bot';
import { config } from '@/core/config';
import { logError } from '@/core/logger';
import { rewriteToCDN } from '@/service/cdn';

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

export function buildYoutubeLiveMessage(channelName: string, status: YoutubeLiveStatus): Sendable {
  const lines = [`### ${status.title ?? '直播'} 开始了！`];
  if (status.thumbnail) {
    lines.push(`![封面](${rewriteToCDN(status.thumbnail)})`);
  }
  lines.push(`- 直播链接：[点击观看](https://www.youtube.com/watch?v=${status.videoId})`);
  lines.push(`- 实时翻译：[打开同传](https://nonoka.live/live?channel=@${channelName})`);
  return segment.markdown(lines.join('\n'));
}
