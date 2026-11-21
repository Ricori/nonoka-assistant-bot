interface CachedMessage {
  imgUrls: string[];
  text: string;
}

export interface IncomingMessageRecord {
  id: number;
  time: string;
  timestamp: number;
  scene: 'group' | 'private';
  subType: string;
  groupId?: string;
  userId: string;
  userName?: string;
  content: string;
  imageCount: number;
}

interface RepeaterLog {
  msg: string;
  times: number;
  done: boolean;
}

const MSG_CACHE_LIMIT = 2000;
const INCOMING_HISTORY_LIMIT = 200;
const YT_HISTORY_LIMIT = 10;

function formatNow(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class AssistantStorage {
  private latestSNSUpdateTime = new Map<string, number>();

  private ytPushedVideoIds = new Map<string, string[]>();

  private repeaterData = new Map<string, RepeaterLog>();

  /** 最近群消息 msg_idx → 图片与文本缓存，用于引用搜图和 /加图兜底 */
  private recentMessages = new Map<string, CachedMessage>();

  /** 最近收到的消息记录（供管理面板实时查看消息与 group_openid） */
  private recentIncoming: IncomingMessageRecord[] = [];

  private nextIncomingId = 1;

  private incomingListeners = new Set<(record: IncomingMessageRecord) => void>();

  /** 已接触过的 group_openid → 最后活跃时间，方便面板复制 */
  private seenGroups = new Map<string, number>();

  setBiliLatestDynamicTime(uid: string, time: number) {
    this.latestSNSUpdateTime.set(`bili-${uid}`, time);
  }

  getBiliLatestDynamicTime(uid: string) {
    return this.latestSNSUpdateTime.get(`bili-${uid}`) ?? 0;
  }

  setTwitterLatestTweetTime(username: string, time: number) {
    this.latestSNSUpdateTime.set(`twitter-${username}`, time);
  }

  getTwitterLatestTweetTime(username: string) {
    return this.latestSNSUpdateTime.get(`twitter-${username}`) ?? 0;
  }

  hasYtPushedVideoId(channelName: string, videoId: string) {
    return this.ytPushedVideoIds.get(channelName)?.includes(videoId) ?? false;
  }

  addYtPushedVideoId(channelName: string, videoId: string) {
    const list = this.ytPushedVideoIds.get(channelName) ?? [];
    if (list.includes(videoId)) return;
    list.push(videoId);
    if (list.length > YT_HISTORY_LIMIT) list.shift();
    this.ytPushedVideoIds.set(channelName, list);
  }

  cacheMessage(msgIdx: string | undefined, text: string, imgUrls: string[]) {
    if (!msgIdx) return;
    if (imgUrls.length === 0 && !text) return;
    this.recentMessages.set(msgIdx, { text, imgUrls });
    if (this.recentMessages.size > MSG_CACHE_LIMIT) {
      const oldest = this.recentMessages.keys().next().value;
      if (oldest) this.recentMessages.delete(oldest);
    }
  }

  getCachedMessage(msgIdx: string | undefined) {
    return msgIdx ? this.recentMessages.get(msgIdx) : undefined;
  }

  noteGroup(groupId: string) {
    if (!groupId) return;
    this.seenGroups.set(groupId, Date.now());
  }

  getSeenGroups() {
    return [...this.seenGroups.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([groupId, lastSeenAt]) => ({ groupId, lastSeenAt }));
  }

  recordIncomingMessage(input: Omit<IncomingMessageRecord, 'id' | 'time' | 'timestamp'>): IncomingMessageRecord {
    const timestamp = Date.now();
    const record: IncomingMessageRecord = {
      id: this.nextIncomingId++,
      timestamp,
      time: formatNow(timestamp),
      ...input,
    };
    this.recentIncoming.push(record);
    if (this.recentIncoming.length > INCOMING_HISTORY_LIMIT) {
      this.recentIncoming.shift();
    }
    for (const fn of this.incomingListeners) {
      try {
        fn(record);
      } catch {
        // 忽略单个订阅者异常
      }
    }
    return record;
  }

  /** 返回最新收到的消息（按时间倒序，最新在前） */
  getRecentIncomingMessages(limit = 100): IncomingMessageRecord[] {
    return this.recentIncoming.slice(-limit).reverse();
  }

  subscribeIncomingMessages(fn: (record: IncomingMessageRecord) => void): () => void {
    this.incomingListeners.add(fn);
    return () => this.incomingListeners.delete(fn);
  }

  /** 记录某群连续相同消息数，已复读过返回 0 */
  saveRepeaterLog(groupId: string, msg: string): number {
    const logObj = this.repeaterData.get(groupId);
    if (!logObj || logObj.msg !== msg) {
      this.repeaterData.set(groupId, { msg, times: 1, done: false });
      return 1;
    }
    if (logObj.done) return 0;
    logObj.times += 1;
    return logObj.times;
  }

  setRepeaterDone(groupId: string) {
    const logObj = this.repeaterData.get(groupId);
    if (logObj) logObj.done = true;
  }
}

export default new AssistantStorage();
