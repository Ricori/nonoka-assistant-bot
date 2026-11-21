import path from 'path';
import { GroupMessageEvent, segment } from 'qq-official-bot';
import { isGroupManager } from '@/core/permission';
import { logError, logInfo } from '@/core/logger';
import { extractImagesWithQuote, getCleanText, getRefIdx } from '@/utils/message';
import {
  deleteSentPicture,
  downloadImage,
  getKeywords,
  getRandomPicture,
  PICTURE_DIR,
  recordSentPicture,
  refreshKeywords,
} from './functions';

async function handleAddPicture(event: GroupMessageEvent, cleanText: string) {
  const match = cleanText.match(/\/加图\s+(\S+)/);
  if (!match) {
    await event.reply('格式：/加图 关键词（可附带或引用图片）');
    return;
  }

  const keyword = match[1];
  if (keyword.length < 2) {
    await event.reply('关键词至少需要两个字');
    return;
  }
  if (keyword.includes('龙') || /[\\/:*?"<>|.]/.test(keyword)) {
    await event.reply('该关键词不允许使用');
    return;
  }

  const imgUrls = extractImagesWithQuote(event);
  if (imgUrls.length === 0) {
    await event.reply('未找到图片，请附带图片或引用含图消息发送 /加图');
    return;
  }

  const destDir = path.join(PICTURE_DIR, keyword);
  let successCount = 0;

  for (const url of imgUrls) {
    try {
      await downloadImage(url, destDir);
      successCount += 1;
    } catch (err) {
      logError('LocalPic', `下载图片失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (successCount > 0) {
    refreshKeywords();
    await event.reply(`已存储 ${successCount} 张图片到「${keyword}」`);
    logInfo('LocalPic', `${event.user_id} 添加了 ${successCount} 张图片到 ${keyword}`);
  } else {
    await event.reply('图片保存失败，请重试');
  }
}

async function handleDeletePicture(event: GroupMessageEvent) {
  if (!isGroupManager(event)) {
    await event.reply('只有管理员可以删图');
    return;
  }

  const refIdx = getRefIdx(event);
  if (!refIdx) {
    await event.reply('请引用要删除的图片发送 /删图');
    return;
  }

  let keyword: string | null = null;
  try {
    keyword = deleteSentPicture(refIdx);
  } catch (err) {
    logError('LocalPic', `删图失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (keyword) {
    await event.reply(`已从「${keyword}」删除图片`);
    logInfo('LocalPic', `${event.user_id} 从 ${keyword} 删除了图片`);
  } else {
    await event.reply('找不到这张图，请引用 bot 最近发出的图片');
  }
}

async function handleSendPicture(event: GroupMessageEvent, keyword: string) {
  const picPath = getRandomPicture(keyword);
  if (!picPath) return;

  logInfo('LocalPic', `命中关键词「${keyword}」 group_openid=${event.group_id}`);
  const res = await event.reply(segment.image(picPath));
  const refIdx = res.ref_idx || res.ext_info?.ref_idx;
  recordSentPicture(refIdx, picPath);
}

/** 处理关键词图库：返回 true 表示已命中并消费该消息 */
export async function handleLocalPic(event: GroupMessageEvent): Promise<boolean> {
  const cleanText = getCleanText(event.raw_message);
  if (!cleanText) return false;

  if (cleanText.includes('/加图')) {
    await handleAddPicture(event, cleanText);
    return true;
  }

  if (cleanText === '/删图') {
    await handleDeletePicture(event);
    return true;
  }

  const keywords = getKeywords();
  if (keywords.includes(cleanText)) {
    await handleSendPicture(event, cleanText);
    return true;
  }

  return false;
}
