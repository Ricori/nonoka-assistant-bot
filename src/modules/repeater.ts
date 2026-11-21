import { GroupMessageEvent } from 'qq-official-bot';
import { config } from '@/core/config';
import storage from '@/core/storage';
import { logError, logInfo } from '@/core/logger';
import { getCleanText, getOwnImageUrls } from '@/utils/message';

/** 群聊复读机：仅处理非 @ 的纯文本消息，连续 2~3 条相同后延迟复读一次 */
export async function handleRepeater(event: GroupMessageEvent): Promise<boolean> {
  if (event.sub_type !== 'normal') return false;
  if (!config.repeater.enable) return false;
  if (config.repeater.blackList.includes(event.group_id)) return false;

  // 跳过带图片/纯非文本消息，避免官方协议无法原样复读媒体
  if (getOwnImageUrls(event.message).length > 0) return false;
  const text = getCleanText(event.raw_message);
  if (!text) return false;

  const times = storage.saveRepeaterLog(event.group_id, text);
  const threshold = 2 + Math.floor(Math.random() * 2);
  if (times < threshold) return false;

  storage.setRepeaterDone(event.group_id);
  logInfo('Repeater', `触发复读 group_openid=${event.group_id}: ${text}`);
  setTimeout(() => {
    event.reply(text).catch((err) => logError('Repeater', err));
  }, 1200);
  return true;
}
