# 代码问答（/ask）

群内 `/ask <问题>` 把问题转发给外部 webhook（例如 Grok Bot routine）。该服务查阅代码后，调用管理接口把答案发回同一个群。

## 启用

在 `config.json` 里填写 `ask.github`。`webhookUrl` 为空时功能关闭。只有 `groups` 里列出的群能使用 `/ask`，其它群里这条指令不会回复。同一群默认 30 秒冷却（`cooldownSec`），用来避开 QQ 主动消息频率限制。

```json
"ask": {
  "github": {
    "webhookUrl": "https://example.com/webhook/ask",
    "headers": {
      "X-Sender-Key": "面板上显示的发送方密钥"
    },
    "groups": {
      "<group_openid>": "Ricori/nonoka-sub-x"
    },
    "cooldownSec": 30,
    "timeoutSec": 60,
    "retries": 2,
    "retryDelaySec": 3
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `ask.github.webhookUrl` | 外部服务的 webhook。留空则关闭 `/ask` |
| `ask.github.headers` | 原样附加到 webhook 请求上的额外头（例如发送方密钥）。同时固定发送 `Content-Type: application/json` |
| `ask.github.groups` | 白名单。键是群 `group_openid`（事件里的 `group_id`），值是该群要查询的 GitHub 仓库 |
| `ask.github.cooldownSec` | 同一群两次 `/ask` 的最小间隔，单位秒，默认 30。`0` 表示不冷却 |
| `ask.github.timeoutSec` | 连接建立后等待 webhook 响应的超时，单位秒，默认 60。到点视为请求已发出 |
| `ask.github.retries` | 连接阶段失败后的额外重试次数，默认 2（一共尝试 3 次）。`0` 表示不重试 |
| `ask.github.retryDelaySec` | 重试退避基数，单位秒，默认 3。第 n 次失败后等待 `n × retryDelaySec` |

`headers` 的值是密钥。管理面板可以改 `webhookUrl`、冷却时间、超时时间、连接重试和群白名单；`GET /api/config` 会把非空 header 值打码为 `******`。请在服务器的 `config.json` 里填写 `ask.github.headers`。面板把打码后的配置存回去时，会保留磁盘上的原值。

## 群里怎么用

- 空问题会回复：`用法：/ask <问题>`。问题正文最长 2000 字。
- 私聊里会提示到群里使用。未出现在 `ask.github.groups` 中的群不回复。
- 受理后机器人立刻回复「收到，正在查询，稍后回复～」，并异步 `POST webhookUrl`。等待响应的时间是 `ask.github.timeoutSec`（默认 60 秒）。
- 可以只发图片，或图片配一句短文字。问题文本里的 `[图片]` 占位不会转发出去。
- 单次连接最长约 8 秒。`ETIMEDOUT` / `ECONNREFUSED` / `ECONNRESET` / `EHOSTUNREACH` / `ENETUNREACH` / `EAI_AGAIN` / `ENOTFOUND` 出现在连接阶段（含这类错误组成的 `AggregateError`，且没有 HTTP 响应）时，按 `retries` 重试。日志形如 `attempt 2/3 code=ETIMEDOUT elapsedMs=...`。全部失败后才在群里回复「代码查询失败，请稍后再试」。
- 已经连上并等到 `timeoutSec`（默认 60 秒）仍无响应，记警告、不重试、不在群里发失败提示，避免把可能已经送达的请求再发一次。
- 任何 HTTP 状态（包括 4xx / 5xx）都不重试。非 2xx 会记下状态码和响应体，并在群里回复失败。每次发送都会记下请求体字节数，失败日志还带 `code`、`message`、`cause`。

请求体：

```json
{
  "question": "这个命令在哪注册？",
  "groupId": "<group_openid>",
  "userId": "<user_openid>",
  "repo": "Ricori/nonoka-sub-x",
  "msgId": "<消息 ID，事件里有则带上>",
  "images": ["https://multimedia.nt.qq.com.cn/download?......"]
}
```

`msgId` 只在事件带了消息 ID 时出现，回传答案时带上它可以走被动回复。`images` 只在当前消息带图片附件时出现，元素是绝对 https URL，不含图片字节或 base64。没有文字、只有图片时 `question` 为空字符串。

## 把答案发回群里

外部服务要能访问这台机器上的管理服务，答案才能回到群里。把 `ADMIN_HOST` 设为 `0.0.0.0`，用 HTTPS 反向代理暴露 `ADMIN_PORT`，并设置足够长的随机 `ADMIN_TOKEN`。管理端口不要以明文 HTTP 直接暴露在公网上。

### `POST /api/send_group`

鉴权与其它管理接口相同：请求头 `x-admin-token: <ADMIN_TOKEN>`，或查询参数 `?token=<ADMIN_TOKEN>`。

```json
{
  "groupId": "<group_openid>",
  "text": "答案正文，默认按 Markdown 发送",
  "msgId": "<可选，/ask 上报的 msgId>",
  "format": "markdown"
}
```

`text` 默认通过 `segment.markdown(text)` 发送，对应 QQ 的 markdown 消息（`msg_type = 2`，正文就是 `text`）。这要求在 QQ 开放平台为该机器人开通**原生 Markdown** 权限。平台拒绝 markdown 时（例如 `40034012` 不允许发送原生 markdown，以及模板权限、markdown 内容不合法等错误码），机器人会把错误码写入日志，并用同一段 `text` 再发一条纯文本。频率、配额或 `msg_id` 次数限制（`40034005`、`40034100`、`40034128`）直接返回 `429`，不会再补发一条。

带了 `msgId` 时按被动回复发送（`qq-official-bot` 的 `source.id` 等于该消息的 `msg_id`）。省略 `msgId` 时主动推送。

| 项 | 约定 |
| --- | --- |
| `groupId` | 非空字符串，且必须是 `ask.github.groups` 的键 |
| `text` | 非空字符串，最长 2000 字。`format` 为 markdown 时作为 Markdown 正文 |
| `msgId` | 可选。有值时被动回复；省略时主动推送 |
| `format` | 可选，`"markdown"` 或 `"text"`。省略时为 `"markdown"` |
| `200` | `{ "ok": true, "format": "markdown" \| "text" }`。`format` 是实际发出的形式；markdown 被拒绝并降级后为 `"text"` |
| `400` | `{ "error": "invalid json" \| "invalid body" \| "groupId and text are required" \| "text too long" \| "invalid msgId" \| "invalid format" }` |
| `401` | `{ "error": "unauthorized" }` |
| `403` | `{ "error": "group not allowed" }`，群不在 `ask.github.groups` |
| `413` | `{ "error": "body too large" }` |
| `429` | `{ "error": "<平台说明>", "code": 40034005 }`。`code` 也可能是 `40034100` 或 `40034128` |
| `502` | `{ "error": "<平台说明>", "code": <平台错误码> }`。其它发送失败。`code` 仅在平台返回了错误码时出现 |
