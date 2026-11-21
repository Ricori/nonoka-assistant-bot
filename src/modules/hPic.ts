import { GroupMessageEvent, segment } from 'qq-official-bot';
import { config } from '@/core/config';
import { logInfo } from '@/core/logger';
import { fetchHPicUrls, HPicLevel } from '@/service/hpic';
import { getCleanText, sleep, type IncomingMessageEvent } from '@/utils/message';

const TRIGGER_RE = /((要|发|份|点|张)大?(色|h|瑟|涩)图)/i;
/** 单次被动回复上限为 5 条，限制单次最多发 5 张 */
const MAX_COUNT = 5;

export async function handleHPic(event: IncomingMessageEvent): Promise<boolean> {
  if (!config.hPic.enable) return false;

  if (event instanceof GroupMessageEvent) {
    if (!config.hPic.whiteGroupIds.includes(event.group_id)) return false;
  }

  const cleanText = getCleanText(event.raw_message);
  if (!TRIGGER_RE.test(cleanText)) return false;

  let count = 1;
  const countExec = /([0-9]+)[张份]/.exec(cleanText);
  if (countExec?.[1]) count = Number(countExec[1]);
  count = Math.max(1, Math.min(MAX_COUNT, count));

  const level = config.hPic.enableR18 ? HPicLevel.MIX : HPicLevel.SAFE;
  logInfo('HPic', `触发涩图 count=${count} level=${level} user=${event.user_id}`);

  const urls = await fetchHPicUrls(count, level);
  if (!urls?.length) {
    await event.reply('色图库炸了！');
    return true;
  }

  for (let i = 0; i < urls.length; i += 1) {
    await event.reply(segment.image(urls[i]));
    if (i < urls.length - 1) await sleep(2500);
  }
  return true;
}
