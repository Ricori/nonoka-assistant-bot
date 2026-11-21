import axios from 'axios';
import FormData from 'form-data';
import { logError } from '@/core/logger';
import { searchImageText } from './text';

export interface WhatAnimeOutput {
  success: boolean;
  similarity?: string;
  episode?: string | number;
  time?: string;
  cover?: string;
  titles?: string[];
  typeFormat?: string;
  startDate?: string;
  isAdult?: boolean;
  videoUrl?: string;
  errorMsg?: string;
}

const ANIME_INFO_QUERY = `
query ($id: Int) {
  Media (id: $id, type: ANIME) {
    id type format isAdult
    title { native romaji }
    startDate { year month day }
    coverImage { large }
  }
}`;

export default async function whatAnimeSearch(imgURL: string): Promise<WhatAnimeOutput> {
  const imgBuffer = await axios
    .get(imgURL, { responseType: 'arraybuffer', timeout: 15000 })
    .then((r) => Buffer.from(r.data))
    .catch((err) => {
      logError('WhatAnime', `下载图片失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  if (!imgBuffer) return { success: false };

  const form = new FormData();
  form.append('image', imgBuffer, 'image');

  let searchData: any = null;
  let code = 0;
  await axios
    .post('https://api.trace.moe/search', form, { headers: form.getHeaders(), timeout: 15000 })
    .then((ret) => {
      code = ret.status;
      searchData = ret.data;
    })
    .catch((err) => {
      logError('WhatAnime', `Search API Error: ${err instanceof Error ? err.message : String(err)}`);
      code = err.response?.status ?? 0;
      searchData = err.response?.data ?? null;
    });

  if (code !== 200 || !searchData?.result) return { success: false };
  if (searchData.result.length === 0) return { success: false, errorMsg: searchImageText.whatAnimeLimit };

  const res = searchData.result[0];
  const similarity = (res.similarity * 100).toFixed(2);
  if (Number(similarity) < 80) return { success: false };

  const s = Math.floor(res.from ?? 0);
  const time = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const info = await axios
    .post(`https://trace.moe/anilist/${res.anilist}`, {
      query: ANIME_INFO_QUERY,
      variables: { id: res.anilist },
    }, { timeout: 10000 })
    .then((r) => r.data?.data?.Media)
    .catch((err) => {
      logError('WhatAnime', `Anilist API Error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });

  if (!info) return { success: false };

  const rawTitles = ['native', 'romaji']
    .map((k) => (info.title?.[k] ? `「${info.title[k]}」` : ''))
    .filter(Boolean);
  const titles = [...new Set(rawTitles)];
  const sd = info.startDate ?? {};

  return {
    success: true,
    similarity,
    episode: res.episode ?? '-',
    time,
    cover: info.coverImage?.large,
    titles,
    typeFormat: `${info.type}-${info.format}`,
    startDate: [sd.year, sd.month, sd.day].filter(Boolean).join('-'),
    isAdult: Boolean(info.isAdult),
    videoUrl: info.isAdult || !res.video ? undefined : `${res.video}&size=l`,
  };
}
