import axios from 'axios';
import { config } from '@/core/config';
import { logError } from '@/core/logger';

export enum HPicLevel {
  SAFE = 0,
  R18 = 1,
  MIX = 2,
}

export async function fetchHPicUrls(count: number, level: HPicLevel): Promise<string[] | null> {
  const apikey = config.apiKeys.lolicon;
  const url = `https://api.lolicon.app/setu/?apikey=${encodeURIComponent(apikey)}&r18=${level}&num=${count}&excludeAI=true`;
  try {
    const ret = await axios.get(url, { timeout: 15000 });
    if (ret.data?.code !== 0 || !Array.isArray(ret.data?.data) || !ret.data.data.length) {
      logError('HPic', 'Lolicon API 返回异常:', ret.data);
      return null;
    }
    return ret.data.data.map((item: { url: string }) => item.url).filter(Boolean);
  } catch (err) {
    logError('HPic', 'Lolicon API 请求失败:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
