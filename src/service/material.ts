import axios from 'axios';
import { bot } from '@/core/bot';
import { logInfo, logWarn } from '@/core/logger';
import { sleep } from '@/utils/message';

export type MaterialImageContentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ImageDimensions {
  width: number;
  height: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
/** QQ 单机器人素材库上限为 100 张，超过阈值自动清理最早的素材（官方说明删除不影响已发历史消息） */
const MATERIAL_PRUNE_THRESHOLD = 80;
const MATERIAL_KEEP_COUNT = 50;
const MATERIAL_CHECK_INTERVAL = 10;
/** completeImageUpload 后稍作等待，避免立刻发消息时 COS/转存链路尚未就绪 */
const POST_UPLOAD_SETTLE_MS = 800;

let uploadsSinceQuotaCheck = MATERIAL_CHECK_INTERVAL;
let pruningPromise: Promise<void> | null = null;

/** 从 PNG / JPEG / GIF / WebP Buffer 头部解析图片宽高 */
export function getImageDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 16) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf.length >= 10) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8 ') {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }

  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xff) break;
      while (offset < buf.length && buf[offset] === 0xff) offset += 1;
      if (offset >= buf.length) break;
      const marker = buf[offset];
      offset += 1;

      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone

      if (offset + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > buf.length) break;

      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof && offset + 7 <= buf.length) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segLen;
    }
  }

  return null;
}

function detectImageMetaByMagic(buf: Buffer): { ext: string; contentType: MaterialImageContentType } | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  return null;
}

function inferImageMeta(buf: Buffer, contentTypeHeader?: unknown): { ext: string; contentType: MaterialImageContentType } {
  const byMagic = detectImageMetaByMagic(buf);
  if (byMagic) return byMagic;

  const ct = String(contentTypeHeader ?? '').toLowerCase();
  if (ct.includes('png')) return { ext: 'png', contentType: 'image/png' };
  if (ct.includes('webp')) return { ext: 'webp', contentType: 'image/webp' };
  if (ct.includes('gif')) return { ext: 'gif', contentType: 'image/gif' };
  return { ext: 'jpg', contentType: 'image/jpeg' };
}

function getDownloadHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA };
  if (/hdslb\.com|bilibili\.com/i.test(url)) {
    headers.Referer = 'https://www.bilibili.com/';
  }
  return headers;
}

function isQuotaExceededError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const data = (err as { response?: { data?: { code?: number; message?: string } } })?.response?.data;
  return data?.code === 40035007 || /40035007|上限|quota|limit/i.test(`${msg} ${data?.message ?? ''}`);
}

async function pruneOldMaterials(force = false): Promise<void> {
  if (!force && uploadsSinceQuotaCheck < MATERIAL_CHECK_INTERVAL) return;
  if (pruningPromise) {
    await pruningPromise;
    return;
  }

  pruningPromise = (async () => {
    try {
      uploadsSinceQuotaCheck = 0;
      const images = await bot.materialService.getImages();
      if (!force && images.length < MATERIAL_PRUNE_THRESHOLD) return;
      const keepCount = Math.min(MATERIAL_KEEP_COUNT, Math.max(0, images.length - 1));
      const sorted = [...images].sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
      const toDelete = sorted.slice(0, Math.max(0, sorted.length - keepCount));
      let deleted = 0;
      for (const item of toDelete) {
        try {
          await bot.materialService.deleteImage(item.image_id);
          deleted += 1;
        } catch (err) {
          logWarn('Material', `清理旧素材失败 (${item.image_id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (deleted > 0) {
        logInfo('Material', `已自动清理 ${deleted} 张旧素材（清理前 ${images.length} 张，保留 ${images.length - deleted} 张）`);
      }
    } catch (err) {
      logWarn('Material', `检查/清理素材库配额失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pruningPromise = null;
    }
  })();

  await pruningPromise;
}

/** 上传本地图片 Buffer 为 QQ Markdown 素材，并自动附带 #widthpx #heightpx（确保多端正常渲染） */
export async function uploadBufferAsMarkdownImage(
  buf: Buffer,
  options: { alt?: string; fileNamePrefix?: string; contentType?: MaterialImageContentType } = {},
): Promise<string> {
  const inferred = inferImageMeta(buf, options.contentType);
  const contentType = options.contentType ?? inferred.contentType;
  const extMap: Record<MaterialImageContentType, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const ext = extMap[contentType];
  const fileName = `${options.fileNamePrefix || 'img'}_${Date.now()}.${ext}`;

  await pruneOldMaterials(false);

  let uploaded;
  try {
    uploaded = await bot.materialService.uploadImage(buf, { fileName, contentType });
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err;
    logWarn('Material', 'QQ 素材库配额已满，立即清理旧素材并重试上传');
    await pruneOldMaterials(true);
    uploaded = await bot.materialService.uploadImage(buf, { fileName, contentType });
  }

  uploadsSinceQuotaCheck += 1;
  await sleep(POST_UPLOAD_SETTLE_MS);

  const dims = getImageDimensions(buf);
  return dims
    ? bot.materialService.imageMarkdown(uploaded.url, options.alt ?? '', dims.width, dims.height)
    : bot.materialService.imageMarkdown(uploaded.url, options.alt ?? '');
}

/** 下载远程图片并上传为 QQ Markdown 素材（带尺寸后缀与重试），失败返回 null */
export async function uploadUrlAsMarkdownImage(
  url: string,
  options: { alt?: string; fileNamePrefix?: string; timeout?: number } = {},
): Promise<string | null> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: options.timeout ?? 15000,
        headers: getDownloadHeaders(url),
      });
      const buf = Buffer.from(res.data);
      if (buf.length === 0) throw new Error('图片内容为空');

      const byMagic = detectImageMetaByMagic(buf);
      const ctHeader = String(res.headers['content-type'] ?? '').toLowerCase();
      if (!byMagic && !ctHeader.startsWith('image/')) {
        throw new Error(`响应不是有效图片 (content-type=${ctHeader || 'unknown'})`);
      }

      const { contentType } = byMagic ?? inferImageMeta(buf, ctHeader);
      return await uploadBufferAsMarkdownImage(buf, {
        alt: options.alt,
        fileNamePrefix: options.fileNamePrefix,
        contentType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        logWarn('Material', `下载/上传 Markdown 图片失败，准备重试 (${attempt}/${maxAttempts}) (${url}): ${msg}`);
        await sleep(1000);
      } else {
        logWarn('Material', `下载/上传 Markdown 图片失败 (${url}): ${msg}`);
      }
    }
  }
  return null;
}
