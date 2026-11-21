import axios from 'axios';
import { config } from '@/core/config';
import { logError } from '@/core/logger';
import { translateText } from '@/service/translate';
import { rewriteToCDN } from '@/service/cdn';

export interface TweetPost {
  username: string;
  userScreenName: string;
  userProfile: string;
  time: number;
  link: string;
  tweetText: string;
  translatedText: string;
  imgUrls: string[];
  videoUrls: string[];
}

export interface LatestTweetInfo {
  username: string;
  tweetId: string;
  time: number;
}

export interface LatestTweetsResult {
  tweets: LatestTweetInfo[];
  failed: boolean;
  stale: boolean;
  nextReadyInS: number;
}

const DEFAULT_NEXT_READY_S = 240;

function getTweetId(url?: string | null) {
  if (!url) return null;
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function getTimestampFromTweetId(id: string) {
  return Number(BigInt(id) / 4194304n) + 1288834974657;
}

export async function getLatestTweets(usernames: string[]): Promise<LatestTweetsResult | null> {
  const { baseUrl, apiKey } = config.nonokaService;
  if (!baseUrl || !apiKey) return null;
  const nnkURL = `${baseUrl}/tweets/latest?apikey=${apiKey}`;

  try {
    const { data } = await axios.post(nnkURL, { usernames }, { timeout: 30000 });
    if (!data?.success) return null;

    const nextReadyInS = typeof data.next_ready_in_s === 'number' ? data.next_ready_in_s : DEFAULT_NEXT_READY_S;
    if (data.status !== 'success') {
      logError('Twitter', `getLatestTweets upstream failed: ${data.error ?? ''}`);
      return { tweets: [], failed: true, stale: false, nextReadyInS };
    }
    if (data.stale) {
      logError('Twitter', 'getLatestTweets: 上游降级返回旧数据（stale）');
    }

    const userList = (data.users ?? []) as { username: string; latest?: string | null }[];
    const tweets = userList
      .map((user) => {
        const tweetId = getTweetId(user.latest);
        if (!tweetId) return null;
        return { username: user.username, tweetId, time: getTimestampFromTweetId(tweetId) };
      })
      .filter((item): item is LatestTweetInfo => item !== null);

    return { tweets, failed: false, stale: Boolean(data.stale), nextReadyInS };
  } catch (err) {
    logError('Twitter', `getLatestTweets API Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function getTweetPost(tweetId: string, translate = true): Promise<TweetPost | undefined> {
  const ret = await axios.get(`https://api.vxtwitter.com/tt/status/${tweetId}`, { timeout: 15000 }).catch((err) => {
    logError('Twitter', `Vxtwitter Fetch Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (!ret?.data || typeof ret.data === 'string') {
    logError('Twitter', `Vxtwitter API Error (${tweetId})`);
    return undefined;
  }

  const apiResponse = ret.data as Record<string, any>;
  const tweetText: string = apiResponse.text || '';
  const translatedText = tweetText && translate ? (await translateText(tweetText)) ?? '' : '';

  const imgUrls: string[] = [];
  const videoUrls: string[] = [];
  for (const media of apiResponse.media_extended ?? []) {
    const mediaUrl = rewriteToCDN(media.url || '');
    if (media.type === 'image') imgUrls.push(mediaUrl);
    else if (media.type === 'video' || media.type === 'gif') videoUrls.push(mediaUrl);
  }

  return {
    username: apiResponse.user_name || '',
    userScreenName: apiResponse.user_screen_name || '',
    userProfile: rewriteToCDN(apiResponse.user_profile_image_url || ''),
    time: new Date(apiResponse.date || '').getTime(),
    link: apiResponse.tweetURL || `https://x.com/i/status/${tweetId}`,
    tweetText,
    translatedText,
    imgUrls,
    videoUrls,
  };
}
