import { segment, type Sendable } from 'qq-official-bot';
import { logError } from '@/core/logger';
import { uploadUrlAsMarkdownImage } from '@/service/material';
import { createUrlButton } from '@/utils/message';
import saucenaoSearch from './saucenao';
import whatAnimeSearch from './whatanime';
import { searchImageText } from './text';

export default async function searchImage(imgUrls: string[]): Promise<Sendable[]> {
  const results: Sendable[] = [];
  try {
    for (const imgUrl of imgUrls) {
      const sn = await saucenaoSearch(imgUrl);
      if (!sn) continue;

      const lines = [
        `### ${sn.displayTitle}`,
        `相似度：**${sn.similarity}%**${sn.creator ? ` · 作者：${sn.creator}` : ''}`,
      ];
      if (sn.thumbnail) {
        const thumbMd = await uploadUrlAsMarkdownImage(sn.thumbnail, { alt: '缩略图', fileNamePrefix: 'sn_thumb' });
        if (thumbMd) lines.push(thumbMd);
      }

      const md = segment.markdown(lines.join('\n\n'));
      const buttons = [];
      if (sn.memberUrl) {
        buttons.push(createUrlButton('1', '作者主页', sn.memberUrl, sn.url ? 0 : 4));
      }
      if (sn.url) {
        buttons.push(createUrlButton(String(buttons.length + 1), '查看来源', sn.url, 4));
      }
      results.push(buttons.length > 0 ? [md, ...buttons] : md);

      if (sn.isAnime) {
        const wa = await whatAnimeSearch(imgUrl);
        if (wa.success) {
          const waLines = [
            `### 番剧定位（相似度 ${wa.similarity}%）`,
            `- 截图出自：第 ${wa.episode} 集 ${wa.time}`,
          ];
          if (wa.cover) {
            const coverMd = await uploadUrlAsMarkdownImage(wa.cover, { alt: '封面', fileNamePrefix: 'wa_cover' });
            if (coverMd) waLines.push(coverMd);
          }
          if (wa.titles?.length) waLines.push(`- 片名：${wa.titles.join(' / ')}`);
          if (wa.typeFormat) waLines.push(`- 类型：${wa.typeFormat}`);
          if (wa.startDate) waLines.push(`- 开播时间：${wa.startDate}`);
          if (wa.isAdult) waLines.push(`- ${searchImageText.r18warn}`);
          results.push(segment.markdown(waLines.join('\n')));

          if (wa.videoUrl) {
            results.push(segment.video(wa.videoUrl));
          }
        } else if (wa.errorMsg) {
          results.push(wa.errorMsg);
        }
      }
    }

    return results.length > 0 ? results : [searchImageText.error];
  } catch (err) {
    logError('SearchImg', err);
    return [searchImageText.error];
  }
}
