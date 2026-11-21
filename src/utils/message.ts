import { GroupMessageEvent, PrivateMessageEvent, segment, type MessageElement, type Sendable } from 'qq-official-bot';
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

export function truncateText(text: string, maxLen = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}…`;
}

/** 生成收到消息的简洁预览文本 */
export function formatIncomingPreview(rawMessage: string, imageUrls: string[], maxLen = 200): string {
  const clean = getCleanText(rawMessage);
  const parts: string[] = [];
  if (clean) parts.push(clean);
  if (imageUrls.length === 1) parts.push('[图片]');
  else if (imageUrls.length > 1) parts.push(`[图片 x${imageUrls.length}]`);
  if (parts.length === 0) {
    return truncateText(rawMessage || '[空消息]', maxLen);
  }
  return truncateText(parts.join(' '), maxLen);
}

/** 将 Sendable 转换为适合日志展示的简洁摘要 */
export function summarizeSendable(message: Sendable, maxLen = 180): string {
  const list = Array.isArray(message) ? message : [message];
  const parts: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const seg = item as { type?: string; data?: Record<string, unknown> };
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        if (typeof data.text === 'string' && data.text.trim()) parts.push(data.text.trim());
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'audio':
        parts.push(typeof data.name === 'string' && data.name ? `[语音:${data.name}]` : '[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'markdown': {
        const md = typeof data.content === 'string'
          ? data.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/\s+/g, ' ').trim()
          : '';
        parts.push(md ? `[Markdown] ${md}` : '[Markdown]');
        break;
      }
      case 'button': {
        const renderData = data.render_data as { label?: string } | undefined;
        parts.push(renderData?.label ? `[按钮:${renderData.label}]` : '[按钮]');
        break;
      }
      case 'keyboard':
        parts.push('[按钮键盘]');
        break;
      case 'at':
        parts.push(data.user_id === 'all' ? '@全体成员' : `@${String(data.user_id ?? '')}`);
        break;
      case 'reply':
        parts.push('[引用]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      default:
        parts.push(`[${seg.type || 'segment'}]`);
        break;
    }
  }
  return truncateText(parts.join(' ') || '[空消息]', maxLen);
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

/** 创建 QQ 底部跳转按钮（style: 0 灰线框 / 1 蓝线框 / 3 白底红字 / 4 蓝底白字） */
export function createUrlButton(id: string, label: string, url: string, style: 0 | 1 | 3 | 4 = 4) {
  return segment.button({
    id,
    render_data: {
      label,
      visited_label: label,
      style,
    },
    action: {
      type: 0,
      permission: { type: 2 },
      data: url,
      unsupport_tips: '当前版本暂不支持此按钮',
    },
  });
}
