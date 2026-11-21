import fs from 'fs';
import path from 'path';
import { logWarn } from './logger';

export interface AssistantConfig {
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
}

export const CONFIG_PATH = path.resolve('config.json');

function createDefaultConfig(): AssistantConfig {
  return {
    admin: [],
    nonokaService: { baseUrl: '', apiKey: '', cdnHost: '' },
    apiKeys: { saucenao: '', lolicon: '' },
    biliDynamicPush: { enable: false, config: {}, cookie: '', refreshToken: '' },
    tweetPush: { enable: false, config: {} },
    ytLivePush: { enable: false, config: {} },
    hPic: { enable: false, whiteGroupIds: [], enableR18: false },
  };
}

function mergeWithDefault(raw: Partial<AssistantConfig>): AssistantConfig {
  const def = createDefaultConfig();
  return {
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

/** 原子写回 config.json，避免写入中途损坏 */
export function saveConfigToDisk(next: AssistantConfig = config) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/** 面板热更新用：强制保留磁盘上的 nonokaService 与 apiKeys，不通过面板读写密钥 */
export function applyPanelConfig(patch: Omit<AssistantConfig, 'nonokaService' | 'apiKeys'>) {
  const disk = fs.existsSync(CONFIG_PATH)
    ? mergeWithDefault(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<AssistantConfig>)
    : createDefaultConfig();

  const merged = mergeWithDefault({
    ...patch,
    nonokaService: disk.nonokaService,
    apiKeys: disk.apiKeys,
  });

  saveConfigToDisk(merged);
  Object.assign(config, merged);
}

export function getRedactedConfig() {
  const { nonokaService: _n, apiKeys: _a, ...rest } = config;
  return rest;
}
