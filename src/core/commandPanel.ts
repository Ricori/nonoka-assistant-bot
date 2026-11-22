import { panel, type CommandPanel, type PanelItem } from 'qq-official-bot';
import { bot } from './bot';
import { logError, logInfo } from './logger';

const GROUP_PANEL_REMARK = 'nonoka-assistant-group-commands';

export const GROUP_COMMAND_ITEMS: PanelItem[] = [
  panel.command('/ask', { desc: '向本群绑定的代码仓库提问' }),
  panel.command('/p', { desc: '推送推文（填链接或ID）' }),
  panel.command('/tts', { desc: '文字转语音（支持中日文）' }),
  panel.command('/加图', { desc: '附带或引用图片加入图库' }),
  panel.command('/删图', { desc: '引用机器人图片删除', onlyAdmin: true }),
  panel.command('/ban', { desc: '禁言或解禁群成员', onlyAdmin: true }),
  panel.command('/task', { desc: '启停定时推送任务', onlyAdmin: true }),
];

function normalizeItems(items: PanelItem[] = []) {
  return items.map((item) => ({
    name: item.name.replace(/^\/+/, ''),
    type: item.type,
    desc: item.desc ?? '',
    only_admin: Boolean(item.only_admin),
    link: item.link ?? '',
  }));
}

function isSamePanelItems(a: PanelItem[] | undefined, b: PanelItem[]) {
  return JSON.stringify(normalizeItems(a)) === JSON.stringify(normalizeItems(b));
}

/** 幂等同步群聊全局 `/` 指令面板（存在则按需更新，不存在则创建） */
export async function syncGroupCommandPanel(): Promise<{ action: 'created' | 'updated' | 'unchanged'; panelId: string } | null> {
  const desired: CommandPanel = panel.build(GROUP_COMMAND_ITEMS, GROUP_PANEL_REMARK);
  try {
    const list = await bot.getCommandPanels({ scope: 'group' });
    const records = list.records ?? [];
    const existing = records.find((r) => r.panel?.remark === GROUP_PANEL_REMARK)
      ?? records.find((r) => r.target_type === 'all');

    if (existing) {
      if (isSamePanelItems(existing.panel?.items, GROUP_COMMAND_ITEMS) && existing.panel?.remark === GROUP_PANEL_REMARK) {
        logInfo('CommandPanel', `群指令面板已是最新 (panel_id=${existing.panel_id}, count=${GROUP_COMMAND_ITEMS.length})`);
        return { action: 'unchanged', panelId: existing.panel_id };
      }
      const res = await bot.updateCommandPanel(existing.panel_id, desired);
      logInfo('CommandPanel', `群指令面板已更新 (panel_id=${existing.panel_id}, version=${res.version}, count=${GROUP_COMMAND_ITEMS.length})`);
      return { action: 'updated', panelId: existing.panel_id };
    }

    const created = await bot.createCommandPanel({
      scope: 'group',
      target_type: 'all',
      panel: desired,
    });
    logInfo('CommandPanel', `群指令面板已创建 (panel_id=${created.panel_id}, count=${GROUP_COMMAND_ITEMS.length})`);
    return { action: 'created', panelId: created.panel_id };
  } catch (err) {
    logError('CommandPanel', '同步群指令面板失败:', err);
    return null;
  }
}
