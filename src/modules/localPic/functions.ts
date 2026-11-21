import fs from 'fs';
import path from 'path';
import axios from 'axios';

export const PICTURE_DIR = path.resolve('data/picture');

let cachedKeywords: string[] | null = null;

export function getKeywords(): string[] {
  if (cachedKeywords !== null) return cachedKeywords;
  if (!fs.existsSync(PICTURE_DIR)) return [];
  cachedKeywords = fs.readdirSync(PICTURE_DIR).filter((f) => fs.statSync(path.join(PICTURE_DIR, f)).isDirectory());
  return cachedKeywords;
}

export function refreshKeywords(): void {
  cachedKeywords = null;
}

export function getGallerySummary(): { keyword: string; count: number }[] {
  return getKeywords().map((keyword) => {
    const dir = path.join(PICTURE_DIR, keyword);
    const count = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    return { keyword, count };
  });
}

export function getRandomPicture(keyword: string): string | null {
  const dir = path.join(PICTURE_DIR, keyword);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  if (files.length === 0) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  return path.resolve(dir, file);
}

export async function downloadImage(url: string, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `${Date.now()}_${Math.floor(Math.random() * 10000)}.jpg`;
  const destPath = path.join(destDir, filename);
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(destPath, Buffer.from(response.data));
  return destPath;
}

/** 已发送图片的 ref_idx → 本地路径（保留最近 500 条） */
const SENT_CACHE_SIZE = 500;
const sentPictures = new Map<string, string>();

export function recordSentPicture(refIdx: string | undefined, picPath: string): void {
  if (!refIdx) return;
  sentPictures.set(refIdx, picPath);
  if (sentPictures.size > SENT_CACHE_SIZE) {
    const oldest = sentPictures.keys().next().value;
    if (oldest) sentPictures.delete(oldest);
  }
}

/** 按 ref_idx 删除 bot 发出的图片，返回所属关键词；查不到返回 null */
export function deleteSentPicture(refIdx: string): string | null {
  const picPath = sentPictures.get(refIdx);
  if (!picPath || !fs.existsSync(picPath)) return null;

  fs.unlinkSync(picPath);
  sentPictures.delete(refIdx);
  const dir = path.dirname(picPath);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
  refreshKeywords();
  return path.basename(dir);
}
