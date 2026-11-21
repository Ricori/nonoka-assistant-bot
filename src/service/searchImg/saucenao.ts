import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '@/core/config';
import { logError } from '@/core/logger';

interface ISaucenaoResult {
  header: {
    similarity: string;
    thumbnail: string;
    index_name: string;
  };
  data: {
    ext_urls?: string[];
    title?: string;
    pixiv_id?: number;
    member_name?: string;
    member_id?: string;
    author_name?: string;
    jp_name?: string;
    creator?: string;
    source?: string;
  };
}

export interface SaucenaoOutput {
  success: boolean;
  displayTitle: string;
  similarity: string;
  thumbnail: string;
  url: string;
  creator?: string;
  memberUrl?: string;
  isAnime: boolean;
  isBook: boolean;
}

async function getDanbooruSource(url: string) {
  const ret = await axios.get(url, { responseType: 'text', timeout: 8000 }).catch((err) => {
    logError('SearchImg', `Danbooru Fetch Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const $ = cheerio.load(ret?.data || '');
  return $('#content .image-container').attr('data-normalized-source');
}

async function getKonachanSource(url: string) {
  const ret = await axios.get(url, { responseType: 'text', timeout: 8000 }).catch((err) => {
    logError('SearchImg', `Konachan Fetch Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const $ = cheerio.load(ret?.data || '');
  let source: string | undefined;
  $('#stats li').each((_i, e) => {
    if (/^Source:/.test($(e).text())) {
      source = $(e).find('a').attr('href');
    }
  });
  return source;
}

export default async function saucenaoSearch(imgURL: string): Promise<SaucenaoOutput | null> {
  const ret = await axios
    .get<{ results?: ISaucenaoResult[] }>('https://saucenao.com/search.php', {
      params: {
        api_key: config.apiKeys.saucenao,
        db: 999,
        output_type: 2,
        numres: 1,
        url: imgURL,
      },
      responseType: 'json',
      timeout: 10000,
    })
    .catch((err) => {
      logError('SearchImg', `SauceNAO Fetch Error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

  const res = ret?.data?.results?.[0];
  if (!res) {
    logError('SearchImg', 'SauceNAO 未返回有效结果');
    return null;
  }

  const { similarity = '0', thumbnail = '' } = res.header ?? {};
  const {
    ext_urls: extUrls = [],
    title,
    pixiv_id: pixivId,
    member_name,
    member_id,
    author_name,
    source,
    creator,
    jp_name,
  } = res.data ?? {};

  let url = extUrls[0] || '';
  if (pixivId) {
    url = `https://www.pixiv.net/artworks/${pixivId}`;
  } else {
    const pidMatch = /pixiv.+illust_id=([0-9]+)/.exec(url);
    for (const u of extUrls) {
      if (pidMatch) {
        url = `https://www.pixiv.net/artworks/${pidMatch[1]}`;
        break;
      }
      if (u.includes('danbooru')) {
        url = u;
        break;
      }
    }
    url = url.replace('http://', 'https://');
  }

  if (url.includes('danbooru')) {
    const s = await getDanbooruSource(url);
    if (s) url = s;
  } else if (url.includes('konachan')) {
    const s = await getKonachanSource(url);
    if (s) url = s;
  }

  const isAnime = url.includes('anidb.net');
  const isBook = Boolean(jp_name);

  let displayTitle = '';
  if (title) {
    displayTitle = member_name || author_name ? `「${title}」/「${member_name || author_name}」` : `「${title}」`;
  } else if (jp_name) {
    displayTitle = jp_name;
  } else if (source) {
    displayTitle = source;
  } else {
    displayTitle = isAnime ? '[AniDB]' : '[NnkDB]';
  }

  return {
    success: true,
    displayTitle,
    similarity,
    thumbnail,
    url,
    creator,
    memberUrl: member_id ? `https://www.pixiv.net/users/${member_id}` : undefined,
    isAnime,
    isBook,
  };
}
