import { GroupMessageEvent, PrivateMessageEvent } from 'qq-official-bot';
import { config } from './config';

export function isBotAdmin(userId: string): boolean {
  return config.admin.includes(userId);
}

/** 群主、群管理员或 bot 管理员均视为有群管理权限 */
export function isGroupManager(event: GroupMessageEvent | PrivateMessageEvent): boolean {
  if (isBotAdmin(event.user_id)) return true;
  if (!(event instanceof GroupMessageEvent)) return false;
  const perms = event.sender?.permissions ?? [];
  return perms.includes('owner' as never) || perms.includes('admin' as never);
}
