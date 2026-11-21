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
}

export type PanelEditableConfig = Omit<
  AssistantConfig,
  'qqBot' | 'puppeteerExecutablePath' | 'nonokaService' | 'apiKeys'
>;

export const CONFIG_PATH = path.resolve('config.json');

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
  return rest;
}
