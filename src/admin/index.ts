import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { segment } from 'qq-official-bot';
import { botMode, runtimeState, sendGroupMessages } from '@/core/bot';
import { config, applyPanelConfig, getRedactedConfig, type PanelEditableConfig } from '@/core/config';
import { getRecentLogs, logError, logInfo, logWarn, subscribeLogs } from '@/core/logger';
import scheduler from '@/core/scheduler';
import storage from '@/core/storage';
import { getGallerySummary } from '@/modules/localPic/functions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SEND_GROUP_TEXT = 2000;

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validatePatch(v: unknown): v is PanelEditableConfig {
  if (!isRecord(v)) return false;
  return Array.isArray(v.admin)
    && isRecord(v.tweetPush)
    && isRecord(v.biliDynamicPush)
    && isRecord(v.ytLivePush)
    && isRecord(v.hPic)
    && isRecord(v.repeater)
    && isRecord(v.ask)
    && isRecord(v.ask.github);
}

function readPlatformError(err: unknown): { code?: number; message: string } {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const rawCode = record?.code ?? record?.err_code;
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? Number(rawCode) : undefined;
  const rawMessage = record?.message ?? record?.err_msg ?? record?.msg;
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage.trim()
    : err instanceof Error && err.message
      ? err.message
      : 'send failed';
  // qq-official-bot 把平台错误收成 `code(40034012): ...`，响应体不再挂在 error 上
  const wrapped = code === undefined ? message.match(/code\((\d+)\)/) : undefined;
  return { code: code ?? (wrapped ? Number(wrapped[1]) : undefined), message };
}

const MESSAGE_LIMIT_CODES = new Set([40034005, 40034100, 40034128]);
const MARKDOWN_REJECT_CODES = new Set([
  22006,
  304036,
  340069,
  40034008,
  40034009,
  40034010,
  40034011,
  40034012,
  40034124,
  40034127,
]);

function isMessageLimit(info: { code?: number; message: string }): boolean {
  if (info.code !== undefined && MESSAGE_LIMIT_CODES.has(info.code)) return true;
  return /40034005|40034100|40034128|msg limit|message limit|频控/i.test(info.message);
}

type GroupSendFormat = 'markdown' | 'text';

function parseSendGroupBody(v: unknown):
  | { ok: true; groupId: string; text: string; msgId?: string; format: GroupSendFormat }
  | { ok: false; error: string } {
  if (!isRecord(v)) return { ok: false, error: 'invalid body' };
  if (typeof v.groupId !== 'string' || typeof v.text !== 'string') {
    return { ok: false, error: 'groupId and text are required' };
  }
  const groupId = v.groupId.trim();
  const text = v.text.trim();
  if (!groupId || !text) return { ok: false, error: 'groupId and text are required' };
  if (text.length > MAX_SEND_GROUP_TEXT) return { ok: false, error: 'text too long' };

  let format: GroupSendFormat = 'markdown';
  if (v.format !== undefined) {
    if (v.format !== 'markdown' && v.format !== 'text') return { ok: false, error: 'invalid format' };
    format = v.format;
  }

  if (v.msgId === undefined || v.msgId === null || v.msgId === '') {
    return { ok: true, groupId, text, format };
  }
  if (typeof v.msgId !== 'string') return { ok: false, error: 'invalid msgId' };
  const msgId = v.msgId.trim();
  if (!msgId) return { ok: true, groupId, text, format };
  return { ok: true, groupId, text, msgId, format };
}

/** 平台拒绝了这条 markdown（无原生权限、模板权限、内容不合法等）。频率限制不在此列。 */
function isMarkdownRejection(info: { code?: number; message: string }): boolean {
  if (isMessageLimit(info)) return false;
  if (info.code !== undefined && MARKDOWN_REJECT_CODES.has(info.code)) return true;
  return /markdown|不允许发送原生/i.test(info.message);
}

export class AssistantAdmin {
  private server?: http.Server;

  start() {
    const port = Number(process.env.ADMIN_PORT || 9617);
    const host = process.env.ADMIN_HOST || '127.0.0.1';
    const envToken = process.env.ADMIN_TOKEN?.trim();
    const isLocal = host === '127.0.0.1' || host === 'localhost';

    if (!envToken && !isLocal) {
      logError('AdminPanel', '拒绝启动：绑定非本地地址时必须通过 ADMIN_TOKEN 设置固定令牌');
      return;
    }

    const token = envToken || crypto.randomBytes(16).toString('hex');
    if (!envToken) {
      logInfo('AdminPanel', `未设置 ADMIN_TOKEN，已生成临时令牌: ${token}`);
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res, token).catch((err) => {
        logError('AdminPanel', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
    });

    this.server.listen(port, host, () => {
      logInfo('AdminPanel', `http://${host}:${port}/?token=${token}`);
    });
  }

  stop() {
    this.server?.close();
  }

  private checkAuth(req: http.IncomingMessage, url: URL, token: string) {
    return req.headers['x-admin-token'] === token || url.searchParams.get('token') === token;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!this.checkAuth(req, url, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, {
        ready: runtimeState.ready,
        mode: botMode,
        uptimeMs: Date.now() - runtimeState.startedAt,
        jobs: scheduler.listJobs(),
        seenGroups: storage.getSeenGroups(),
        recentMessages: storage.getRecentIncomingMessages(50),
        gallery: getGallerySummary(),
      });
      return;
    }

    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      sendJson(res, 200, storage.getRecentIncomingMessages(limit));
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, getRedactedConfig());
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'body too large' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }

      if (!validatePatch(parsed)) {
        sendJson(res, 400, { error: 'invalid config shape' });
        return;
      }

      applyPanelConfig(parsed);
      logInfo('AdminPanel', '配置已通过管理面板更新');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/send_group' && req.method === 'POST') {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'body too large' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }

      const payload = parseSendGroupBody(parsed);
      if (!payload.ok) {
        sendJson(res, 400, { error: payload.error });
        return;
      }

      if (!Object.prototype.hasOwnProperty.call(config.ask.github.groups, payload.groupId)) {
        logWarn('AdminPanel', `send_group 拒绝未在 ask.github.groups 中的群 group_openid=${payload.groupId}`);
        sendJson(res, 403, { error: 'group not allowed' });
        return;
      }

      const source = payload.msgId ? { id: payload.msgId } : undefined;
      const deliver = (message: string | ReturnType<typeof segment.markdown>) => (
        sendGroupMessages(payload.groupId, [message], source)
      );

      let result = payload.format === 'text'
        ? await deliver(payload.text)
        : await deliver(segment.markdown(payload.text));
      let deliveredFormat: GroupSendFormat = payload.format;

      if (result.failed > 0 && payload.format === 'markdown') {
        const info = readPlatformError(result.error);
        if (isMarkdownRejection(info)) {
          logWarn(
            'AdminPanel',
            `send_group markdown 被拒绝 code=${info.code ?? '-'} group_openid=${payload.groupId}，改发明文: ${info.message}`,
          );
          result = await deliver(payload.text);
          deliveredFormat = 'text';
        }
      }

      if (result.failed > 0) {
        const info = readPlatformError(result.error);
        if (isMessageLimit(info)) {
          sendJson(res, 429, { error: info.message || 'message limit', code: info.code ?? 40034005 });
          return;
        }
        sendJson(res, 502, { error: info.message || 'send failed', ...(info.code !== undefined ? { code: info.code } : {}) });
        return;
      }

      logInfo('AdminPanel', `send_group 已发送 group_openid=${payload.groupId} len=${payload.text.length} format=${deliveredFormat} passive=${payload.msgId ? 'yes' : 'no'}`);
      sendJson(res, 200, { ok: true, format: deliveredFormat });
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(start|stop)$/);
    if (taskMatch && req.method === 'POST') {
      const [, id, action] = taskMatch;
      const ok = action === 'start' ? scheduler.startById(id) : scheduler.stopById(id);
      if (!ok) {
        sendJson(res, 404, { error: 'task not found' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 300)));
      sendJson(res, 200, getRecentLogs(limit));
      return;
    }

    if (url.pathname === '/api/logs/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      for (const entry of getRecentLogs(300)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      const unsubLog = subscribeLogs((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const unsubMsg = storage.subscribeIncomingMessages((record) => {
        res.write(`event: incoming_message\ndata: ${JSON.stringify(record)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubLog();
        unsubMsg();
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }
}
