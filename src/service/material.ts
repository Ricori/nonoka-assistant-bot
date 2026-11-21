import axios from 'axios';
import { bot } from '@/core/bot';
import { logWarn } from '@/core/logger';

export type MaterialImageContentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ImageDimensions {
  width: number;
  height: number;
}

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

function inferImageMeta(buf: Buffer, contentTypeHeader?: unknown): { ext: string; contentType: MaterialImageContentType } {
  if (buf.length >= 4) {
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
  }

  const ct = String(contentTypeHeader ?? '').toLowerCase();
  if (ct.includes('png')) return { ext: 'png', contentType: 'image/png' };
  if (ct.includes('webp')) return { ext: 'webp', contentType: 'image/webp' };
  if (ct.includes('gif')) return { ext: 'gif', contentType: 'image/gif' };
  return { ext: 'jpg', contentType: 'image/jpeg' };
}

/** 上传本地图片 Buffer 为 QQ Markdown 素材，并自动附带 #widthpx #heightpx（确保手机端正常渲染） */
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

  const uploaded = await bot.materialService.uploadImage(buf, { fileName, contentType });
  const dims = getImageDimensions(buf);
  return dims
    ? bot.materialService.imageMarkdown(uploaded.url, options.alt ?? '', dims.width, dims.height)
    : bot.materialService.imageMarkdown(uploaded.url, options.alt ?? '');
}

/** 下载远程图片并上传为 QQ Markdown 素材（带尺寸后缀），失败返回 null */
export async function uploadUrlAsMarkdownImage(
  url: string,
  options: { alt?: string; fileNamePrefix?: string; timeout?: number } = {},
): Promise<string | null> {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: options.timeout ?? 15000 });
    const buf = Buffer.from(res.data);
    if (buf.length === 0) return null;
    const { contentType } = inferImageMeta(buf, res.headers['content-type']);
    return await uploadBufferAsMarkdownImage(buf, {
      alt: options.alt,
      fileNamePrefix: options.fileNamePrefix,
      contentType,
    });
  } catch (err) {
    logWarn('Material', `下载/上传 Markdown 图片失败 (${url}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
