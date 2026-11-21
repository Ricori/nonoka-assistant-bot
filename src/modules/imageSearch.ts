import { GroupMessageEvent } from 'qq-official-bot';
import searchImage from '@/service/searchImg';
import { logInfo } from '@/core/logger';
import { extractImagesWithQuote, getCleanText, type IncomingMessageEvent } from '@/utils/message';

/** 搜图：私聊或群内 @bot 时触发，支持附带图片或引用含图消息 */
export async function handleImageSearch(event: IncomingMessageEvent): Promise<boolean> {
  if (event instanceof GroupMessageEvent && event.sub_type !== 'at') return false;

  const cleanText = getCleanText(event.raw_message);
  if (!cleanText.includes('搜图') && !cleanText.includes('来源')) return false;

  const urls = extractImagesWithQuote(event);
  if (urls.length === 0) return false;

  logInfo('ImageSearch', `收到搜图请求 (${urls.length} 张) user=${event.user_id}`);
  const resultMsgs = await searchImage(urls);
  for (const msg of resultMsgs) {
    await event.reply(msg);
  }
  return true;
}
