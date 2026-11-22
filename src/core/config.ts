import fs from 'fs';
import path from 'path';
import { logWarn, setLogLevel } from './logger';

export interface QQBotConfig {
  appid: string;
  secret: string;
  /** 连接模式：websocket（本地调试免公网 IP）或 webhook（需公网 HTTPS） */
  mode: 'websocket' | 'webhook';
  /** 仅 mode=webhook 时生效 */
  webhookPort: number;
  /** 仅 mode=webhook 时生效 */
  webhookPath: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export interface AssistantConfig {
  qqBot: QQBotConfig;
  /** 可选：自定义 Puppeteer 浏览器路径（留空则使用自带 Chromium） */
  puppeteerExecutablePath: string;
  /** 管理员 user_openid 列表 */
  admin: string[];
  nonokaService: {
    baseUrl: string;
    apiKey: string;
    cdnHost: string;
  };
  apiKeys: {
    saucenao: string;
    lolicon: string;
  };
  biliDynamicPush: {
    enable: boolean;
    /** B站 UID → 目标 group_openid 列表 */
    config: Record<string, string[]>;
    cookie: string;
    refreshToken: string;
  };
  tweetPush: {
    enable: boolean;
    /** 推特用户名 → 目标 group_openid 列表 */
    config: Record<string, string[]>;
  };
  ytLivePush: {
    enable: boolean;
    /** YouTube 频道名/ID → 目标 group_openid 列表 */
    config: Record<string, string[]>;
  };
  hPic: {
    enable: boolean;
    /** 允许使用涩图的群 group_openid 白名单（留空则所有群禁用） */
    whiteGroupIds: string[];
    enableR18: boolean;
  };
  repeater: {
    enable: boolean;
    /** 复读机黑名单群 group_openid */
    blackList: string[];
  };
  /** 群内 /ask 代码问答 */
  ask: AskConfig;
}

export interface AskGithubConfig {
  /** Grok Bot routine webhook；留空则关闭 /ask */
  webhookUrl: string;
  /** 原样附加到 webhook 请求的额外头（例如面板上的发送方密钥）。属于密钥，接口返回时打码 */
  headers: Record<string, string>;
  /** 白名单：group_openid → 该群要查询的 GitHub 仓库。未列出的群不能使用 /ask */
  groups: Record<string, string>;
  /** 同一群两次 /ask 的最小间隔（秒） */
  cooldownSec: number;
  /** webhook 等待响应的超时（秒）。超时视为请求已发出，不在群里报失败 */
  timeoutSec: number;
}

export interface AskConfig {
  github: AskGithubConfig;
}

export type PanelEditableConfig = Omit<
  AssistantConfig,
  'qqBot' | 'puppeteerExecutablePath' | 'nonokaService' | 'apiKeys'
>;

export const CONFIG_PATH = path.resolve('config.json');

const SECRET_MASK = '******';

function isMaskedSecret(value: string): boolean {
  return value === SECRET_MASK || /^\*{3,}$/.test(value);
}

function normalizeStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim();
    if (!name || typeof value !== 'string') continue;
    out[name] = value;
  }
  return out;
}

function normalizeGroupRepos(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalizeStringRecord(input))) {
    const repo = value.trim();
    if (repo) out[key] = repo;
  }
  return out;
}

function normalizeCooldown(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), 24 * 60 * 60);
}

function normalizeTimeoutSec(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 24 * 60 * 60);
}

/** 非空密钥打码。管理面板往返保存时凭这个标记保留磁盘上的原值 */
export function maskSecretRecord(record: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    masked[key] = value ? SECRET_MASK : '';
  }
  return masked;
}

/** 面板/接口回写时：打码值还原为磁盘原值，避免把 ****** 写进 config.json */
function mergeSecretRecord(disk: Record<string, string>, incoming: unknown): Record<string, string> {
  if (incoming === undefined) return { ...disk };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { ...disk };
  const merged: Record<string, string> = { ...disk };
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.trim();
    if (!name || typeof value !== 'string') continue;
    if (isMaskedSecret(value)) {
      if (disk[name] === undefined) delete merged[name];
      else merged[name] = disk[name];
      continue;
    }
    merged[name] = value;
  }
  return merged;
}

function createDefaultConfig(): AssistantConfig {
  return {
    qqBot: {
      appid: '',
      secret: '',
      mode: 'websocket',
      webhookPort: 3000,
      webhookPath: '/webhook',
      logLevel: 'info',
    },
    puppeteerExecutablePath: '',
    admin: [],
    nonokaService: { baseUrl: '', apiKey: '', cdnHost: '' },
    apiKeys: { saucenao: '', lolicon: '' },
    biliDynamicPush: { enable: false, config: {}, cookie: '', refreshToken: '' },
    tweetPush: { enable: false, config: {} },
    ytLivePush: { enable: false, config: {} },
    hPic: { enable: false, whiteGroupIds: [], enableR18: false },
    repeater: { enable: true, blackList: [] },
    ask: {
      github: { webhookUrl: '', headers: {}, groups: {}, cooldownSec: 30, timeoutSec: 60 },
    },
  };
}

function mergeWithDefault(raw: Partial<AssistantConfig>): AssistantConfig {
  const def = createDefaultConfig();
  return {
    qqBot: {
      ...def.qqBot,
      ...(raw.qqBot ?? {}),
      appid: raw.qqBot?.appid != null ? String(raw.qqBot.appid) : def.qqBot.appid,
      secret: raw.qqBot?.secret != null ? String(raw.qqBot.secret) : def.qqBot.secret,
      mode: raw.qqBot?.mode === 'webhook' ? 'webhook' : 'websocket',
      webhookPort: Number(raw.qqBot?.webhookPort || def.qqBot.webhookPort),
      webhookPath: raw.qqBot?.webhookPath || def.qqBot.webhookPath,
      logLevel: raw.qqBot?.logLevel || def.qqBot.logLevel,
    },
    puppeteerExecutablePath: typeof raw.puppeteerExecutablePath === 'string'
      ? raw.puppeteerExecutablePath
      : def.puppeteerExecutablePath,
    admin: Array.isArray(raw.admin) ? raw.admin.map(String) : def.admin,
    nonokaService: { ...def.nonokaService, ...(raw.nonokaService ?? {}) },
    apiKeys: { ...def.apiKeys, ...(raw.apiKeys ?? {}) },
    biliDynamicPush: {
      ...def.biliDynamicPush,
      ...(raw.biliDynamicPush ?? {}),
      config: raw.biliDynamicPush?.config ?? def.biliDynamicPush.config,
    },
    tweetPush: {
      ...def.tweetPush,
      ...(raw.tweetPush ?? {}),
      config: raw.tweetPush?.config ?? def.tweetPush.config,
    },
    ytLivePush: {
      ...def.ytLivePush,
      ...(raw.ytLivePush ?? {}),
      config: raw.ytLivePush?.config ?? def.ytLivePush.config,
    },
    hPic: {
      ...def.hPic,
      ...(raw.hPic ?? {}),
      whiteGroupIds: Array.isArray(raw.hPic?.whiteGroupIds) ? raw.hPic.whiteGroupIds.map(String) : def.hPic.whiteGroupIds,
    },
    repeater: {
      ...def.repeater,
      ...(raw.repeater ?? {}),
      blackList: Array.isArray(raw.repeater?.blackList) ? raw.repeater.blackList.map(String) : def.repeater.blackList,
    },
    ask: {
      github: {
        webhookUrl: typeof raw.ask?.github?.webhookUrl === 'string'
          ? raw.ask.github.webhookUrl.trim()
          : def.ask.github.webhookUrl,
        headers: normalizeStringRecord(raw.ask?.github?.headers),
        groups: normalizeGroupRepos(raw.ask?.github?.groups),
        cooldownSec: normalizeCooldown(raw.ask?.github?.cooldownSec, def.ask.github.cooldownSec),
        timeoutSec: normalizeTimeoutSec(raw.ask?.github?.timeoutSec, def.ask.github.timeoutSec),
      },
    },
  };
}

function loadConfig(): AssistantConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    logWarn('Config', '未找到 config.json，使用默认空配置启动（可复制 config_demo.json 创建）');
    return createDefaultConfig();
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<AssistantConfig>;
  return mergeWithDefault(raw);
}

export const config: AssistantConfig = loadConfig();
setLogLevel(config.qqBot.logLevel);

/** 原子写回 config.json，避免写入中途损坏 */
export function saveConfigToDisk(next: AssistantConfig = config) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/** 面板热更新用：强制保留磁盘上的凭证与本地路径配置，不通过面板读写密钥 */
export function applyPanelConfig(patch: PanelEditableConfig) {
  const disk = fs.existsSync(CONFIG_PATH)
    ? mergeWithDefault(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<AssistantConfig>)
    : createDefaultConfig();

  const merged = mergeWithDefault({
    ...patch,
    qqBot: disk.qqBot,
    puppeteerExecutablePath: disk.puppeteerExecutablePath,
    nonokaService: disk.nonokaService,
    apiKeys: disk.apiKeys,
    ask: {
      github: {
        webhookUrl: typeof patch.ask?.github?.webhookUrl === 'string'
          ? patch.ask.github.webhookUrl
          : disk.ask.github.webhookUrl,
        headers: mergeSecretRecord(disk.ask.github.headers, patch.ask?.github?.headers),
        groups: patch.ask?.github?.groups ?? disk.ask.github.groups,
        cooldownSec: patch.ask?.github?.cooldownSec ?? disk.ask.github.cooldownSec,
        timeoutSec: patch.ask?.github?.timeoutSec ?? disk.ask.github.timeoutSec,
      },
    },
  });

  saveConfigToDisk(merged);
  Object.assign(config, merged);
}

export function getRedactedConfig(): PanelEditableConfig {
  const {
    qqBot: _q,
    puppeteerExecutablePath: _p,
    nonokaService: _n,
    apiKeys: _a,
    ...rest
  } = config;
  return {
    ...rest,
    ask: {
      ...rest.ask,
      github: {
        ...rest.ask.github,
        headers: maskSecretRecord(rest.ask.github.headers),
      },
    },
  };
}
