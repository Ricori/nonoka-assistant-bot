import { GroupMessageEvent, PrivateMessageEvent, type MessageElement, type Sendable } from 'qq-official-bot';
import storage from '@/core/storage';

export type IncomingMessageEvent = GroupMessageEvent | PrivateMessageEvent;

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 去掉 SDK 拼接的 <reply,...> / <at,...> 等尖括号标签，返回干净文本 */
export function getCleanText(rawMessage: string): string {
  return rawMessage
    .replace(/<(?:reply|at|image|video|audio|face|file)[^>]*>/g, '')
    .trim();
}

/** 获取引用消息的 ref_idx（优先 ref_msg_idx，其次 source） */
export function getRefIdx(event: IncomingMessageEvent): string | undefined {
  return event.ref_msg_idx || event.source?.ref_idx || event.source?.id || undefined;
}

function collectElementImages(elements?: MessageElement[]): string[] {
  if (!elements?.length) return [];
  const urls: string[] = [];
  for (const el of elements) {
    for (const att of el.attachments ?? []) {
      const url = (att as { url?: string; content_type?: string }).url;
      const contentType = (att as { content_type?: string }).content_type ?? '';
      if (url && (!contentType || contentType.startsWith('image'))) {
        urls.push(url.startsWith('//') ? `https:${url}` : url);
      }
    }
    if (el.msg_elements?.length) {
      urls.push(...collectElementImages(el.msg_elements));
    }
  }
  return urls;
}

/** 提取当前消息本身附带的图片 URL */
export function getOwnImageUrls(message: Sendable): string[] {
  const list = Array.isArray(message) ? message : [message];
  const urls: string[] = [];
  for (const seg of list) {
    if (typeof seg === 'object' && seg !== null && seg.type === 'image') {
      const url = seg.data.url || (typeof seg.data.file === 'string' ? seg.data.file : '');
      if (url) urls.push(url.startsWith('//') ? `https:${url}` : url);
    }
  }
  return urls;
}

/** 提取图片 URL：先看引用消息（msg_elements + 本地缓存），再拼当前消息图片 */
export function extractImagesWithQuote(event: IncomingMessageEvent): string[] {
  const urls: string[] = [];
  const refIdx = getRefIdx(event);

  if (event.msg_elements?.length) {
    urls.push(...collectElementImages(event.msg_elements));
  }
  if (urls.length === 0 && refIdx) {
    const cached = storage.getCachedMessage(refIdx);
    if (cached?.imgUrls.length) urls.push(...cached.imgUrls);
  }

  urls.push(...getOwnImageUrls(event.message));
  return [...new Set(urls)];
}
