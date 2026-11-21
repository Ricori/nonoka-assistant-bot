import { config } from '@/core/config';

const CDN_HOST_MAP: Record<string, string> = {
  'pbs.twimg.com': 'x/pbs',
  'video.twimg.com': 'x/video',
  'i.ytimg.com': 'yt/img',
};

/** 将受墙媒体域名重写为自建 CDN 反代地址；未配置 cdnHost 时原样返回 */
export function rewriteToCDN(url: string): string {
  const { cdnHost } = config.nonokaService;
  if (!url || !cdnHost) return url;
  for (const [host, prefix] of Object.entries(CDN_HOST_MAP)) {
    if (url.includes(host)) {
      return url.replace(host, `${cdnHost}/${prefix}`);
    }
  }
  return url;
}
