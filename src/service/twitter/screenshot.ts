import puppeteer, { type Browser } from 'puppeteer';
import { config } from '@/core/config';
import { logError } from '@/core/logger';
import type { TweetPost } from './tweet';

interface TweetDisplayData {
  avatarUrl: string;
  displayName: string;
  username: string;
  mainText: string;
  transText: string;
  hashTags: string[];
  time: string;
  day: string;
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(str: string) {
  return escapeHtml(str.trim()).replace(/\r?\n/g, '<br>');
}

function extractAndRemoveTags(text: string) {
  const regex = /#([^\s#]+)/g;
  const tags: string[] = [];
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    tags.push(`#${match[1]}`);
    match = regex.exec(text);
  }
  return { tags, text: text.replace(regex, '') };
}

function formatTime(ts: number) {
  const date = new Date(ts);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours < 12 ? '上午' : '下午';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return {
    time: `${period}${h12}:${minutes}`,
    day: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
  };
}

function createHtml(d: TweetDisplayData) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .tweet { width: 598px; padding: 16px; }
    .header { display: flex; flex-direction: row; align-items: center; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; margin-right: 10px; flex-shrink: 0; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .name { font-weight: 700; font-size: 15px; color: rgb(15, 20, 25); line-height: 20px; }
    .handle { font-size: 15px; color: rgb(83, 100, 113); line-height: 20px; }
    .content { padding-top: 12px; }
    .main-text { word-break: break-word; color: rgb(15, 20, 25); font-size: 17px; line-height: 24px; }
    .hashtag { color: rgb(29, 155, 240); font-size: 17px; line-height: 24px; }
    .card { margin-top: 16px; font-size: 16px; background: #FBF5F5; padding: 12px; border-radius: 8px; }
    .ltr { color: rgb(15, 20, 25); font-size: 13px; line-height: 16px; }
    .ltr-blue { color: rgb(29, 155, 240); }
    .card-text { margin-top: 8px; line-height: 24px; }
    .footer { margin-top: 16px; color: rgb(83, 100, 113); font-size: 15px; line-height: 20px; }
  </style>
</head>
<body>
  <div class="tweet">
    <div class="header">
      <div class="avatar"><img src="${escapeHtml(d.avatarUrl)}" /></div>
      <div>
        <div class="name">${escapeHtml(d.displayName)}</div>
        <div class="handle">@${escapeHtml(d.username.replace(/^@/, ''))}</div>
      </div>
    </div>
    <div class="content">
      <div class="main-text">${nl2br(d.mainText)}</div>
      ${d.hashTags[0] ? `<br><div class="hashtag">${escapeHtml(d.hashTags[0])}</div>` : ''}
      ${d.hashTags[1] ? `<div class="hashtag">${escapeHtml(d.hashTags[1])}</div>` : ''}
    </div>
    ${d.transText ? `<div class="card">
      <div class="ltr"><span>由 ののか </span><span class="ltr-blue">翻译自 日语</span></div>
      <div class="card-text">${nl2br(d.transText)}</div>
      ${d.hashTags[0] ? `<br><div class="hashtag">${escapeHtml(d.hashTags[0])}</div>` : ''}
      ${d.hashTags[1] ? `<div class="hashtag">${escapeHtml(d.hashTags[1])}</div>` : ''}
    </div>` : ''}
    <div class="footer"><span>${escapeHtml(d.time)} · ${escapeHtml(d.day)}</span></div>
  </div>
</body>
</html>`;
}

let browserPromise: Promise<Browser> | null = null;

function launchBrowser() {
  const executablePath = config.puppeteerExecutablePath?.trim() || undefined;
  const promise = puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  browserPromise = promise;
  promise.catch(() => {
    if (browserPromise === promise) browserPromise = null;
  });
  return promise;
}

async function getBrowser(): Promise<Browser> {
  const current = browserPromise;
  if (!current) return launchBrowser();
  const browser = await current.catch(() => null);
  if (browser && browser.isConnected()) return browser;
  if (browserPromise === current) return launchBrowser();
  return getBrowser();
}

export async function createTweetScreenshot(data: TweetPost): Promise<Buffer | undefined> {
  const { tags, text } = extractAndRemoveTags(data.tweetText);
  const { time, day } = formatTime(data.time);

  const html = createHtml({
    avatarUrl: data.userProfile,
    displayName: data.username,
    username: data.userScreenName,
    mainText: text,
    transText: data.translatedText,
    hashTags: tags,
    time,
    day,
  });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 598, height: 1000, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });

    const el = await page.$('.tweet');
    if (!el) return undefined;
    const raw = await el.screenshot({ type: 'png' });
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64');
  } catch (err) {
    logError('Twitter', `生成推文截图失败: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    await page.close().catch(() => {});
  }
}
