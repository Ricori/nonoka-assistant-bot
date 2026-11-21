import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { botMode, runtimeState } from '@/core/bot';
import { applyPanelConfig, getRedactedConfig, type AssistantConfig } from '@/core/config';
import { getRecentLogs, logError, logInfo, subscribeLogs } from '@/core/logger';
import scheduler from '@/core/scheduler';
import storage from '@/core/storage';
import { getGallerySummary } from '@/modules/localPic/functions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
const MAX_BODY_BYTES = 1024 * 1024;

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

function validatePatch(v: unknown): v is Omit<AssistantConfig, 'nonokaService' | 'apiKeys'> {
  if (!isRecord(v)) return false;
  return Array.isArray(v.admin)
    && isRecord(v.tweetPush)
    && isRecord(v.biliDynamicPush)
    && isRecord(v.ytLivePush)
    && isRecord(v.hPic)
    && isRecord(v.repeater);
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
        gallery: getGallerySummary(),
      });
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
      const unsub = subscribeLogs((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }
}
