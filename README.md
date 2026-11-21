# nonoka-assistant-bot

QQ 官方功能机器人，承接从 `nonoka-ai` 拆分出来的工具与推送能力，自带实时日志与配置管理面板。

## 功能

- **Twitter 推文推送 & `/p <推文>`**：定时轮询 + 推文截图 + Markdown 图文混排 + 视频推送
- **B 站动态推送**：WBI 签名、Cookie 自动续期、Markdown 图文 + 底部按钮卡片推送
- **YouTube 开播推送**：首次检查去重、按 `videoId` 防重推、Markdown 封面 + 底部直播/同传按钮卡片
- **以图搜源**：`@bot 搜图/来源`（支持直接附带或引用含图消息），SauceNAO + Danbooru/Konachan + WhatAnime 番剧定位
- **关键词图库**：`/加图 <关键词>`、`/删图`（管理员引用 bot 发出的图片删除）、群聊免 `@` 关键词随机出图
- **涩图（HPic）**：群白名单门控，支持 SFW / R18 开关
- **复读机（Repeater）**：群聊连续相同文本达到 2~3 次延迟自动复读一次，支持黑名单群
- **群指令**：`/tts <文本>`（自动识别中日文切块合成语音）、`/ban <@某人|member_openid> [分钟]`
- **Web 管理面板**：默认 `http://127.0.0.1:9617`，支持热改推送订阅/白名单/复读机、启停定时任务、SSE 实时日志查看与过滤

## 快速开始

1. 安装依赖：
   ```bash
   yarn install
   ```
2. 复制 `config_demo.json` 为 `config.json`，填写 `qqBot`（`appid` / `secret`）、`nonokaService` 和 `apiKeys`（其余订阅配置与白名单可在 Web 面板中热修改）。
3. 启动：
   ```bash
   yarn dev
   ```

## 服务器 PM2 部署

复制 `ecosystem_demo.config.cjs` 为 `ecosystem.config.cjs`，按需修改 `ADMIN_HOST` / `ADMIN_PORT` / `ADMIN_TOKEN` 后启动：

```bash
pm2 start ecosystem.config.cjs
```

## 指令速查

| 指令 | 说明 |
| --- | --- |
| `/p <推文链接或ID>` | 推送推文到当前会话（管理员支持 `/p <group_openid> <推文>`） |
| `/tts <文本>` | 文字转语音（含假名自动按日文合成） |
| `/ban <@某人\|member_openid> [分钟]` | 管理员禁言成员（默认 10 分钟，`0` 为解除禁言） |
| `/task <twitter\|bilibili\|youtube> <on\|off>` | 管理员即时启停定时任务 |
| `@bot 搜图` / `@bot 来源` | 附带或引用图片以图搜源 |
| `/加图 <关键词>` | 附带或引用图片加入本地图库 |
| `/删图` | 管理员引用 bot 发出的图库图片删除 |
| `来点涩图` 等 | 仅在 `hPic.whiteGroupIds` 白名单群或私聊生效 |
