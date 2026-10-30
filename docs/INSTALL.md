# 部署与 OAuth 接入

希望通过网页复制并部署？先看 [一键部署指南](DEPLOY.md)。

本指南面向个人自托管。每个部署只绑定一个微信账号；不要把同一个管理令牌分发给多个用户。

## 1. 检查项目

```sh
npm ci
npm run check
npm run build
```

测试使用模拟微信上游。`build` 是 dry-run，不会部署或要求扫码。

## 2. 配置 Cloudflare

修改 `wrangler.jsonc` 的 Worker 名称和 `vars.APP_ORIGIN`，使用自己的最终 HTTPS origin，不带 `/mcp` 或末尾斜线。保留两个 Durable Object 绑定和 `v1`、`v2` SQLite migrations。

按当前账号的实际安装流程配置非敏感变量，例如：

```json
{
  "APP_ORIGIN": "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  "OAUTH_REDIRECT_URIS": "https://chatgpt.com/connector_platform_oauth_redirect",
  "EVENTS_DISCOVERY_ENABLED": "true",
  "CALLBACK_HOSTS": "connectors.api.openai.com"
}
```

这个回调主机在本项目首轮 ChatGPT 实测中被确认使用，不能据此假定所有客户端或未来安装都会使用它。仅允许经过核验的官方精确主机，不使用通配符，不自动信任客户端请求传入的地址。未配置 `CALLBACK_HOSTS` 时，即使启用事件发现，实际订阅仍会失败。

OAuth 回调 URI 与事件回调主机是两种不同配置：前者用于完成登录，后者接收事件。代码默认支持上述稳定 OAuth 回调；如果自己的安装流程还要求动态回调，应精确加入完整 URI，同时保留稳定回调。不要复制他人的私人回调 ID。

登录 Cloudflare，以交互方式设置至少 32 字符、密码学随机生成的管理令牌：

```sh
npx wrangler login
npx wrangler secret put BRIDGE_TOKEN
npm run deploy
```

如果首次设置 secret 时提示 Worker 尚不存在，可先部署，再设置 secret。密钥未设置时不要进行连接验收。不要把管理令牌放入 URL、Git、插件包、聊天提示词或 shell 命令参数。

`BRIDGE_TOKEN` 用于自己的管理页和授权同意页；ChatGPT 使用 OAuth access token，不应直接持有管理令牌。

## 3. 连接 ChatGPT

在支持自定义 MCP 的 ChatGPT 客户端中添加：

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
```

使用 OAuth 与动态客户端注册。代码提供授权服务器与受保护资源发现。`mcp.json` 是使用占位地址的配置模板，上传插件包前应替换为自己的服务地址。

完成授权后，在目标 dot 验证 `wechat_status` 可调用，四个工具可见，并能发现 `message.created`。尚未扫码时 `connected:false` 是预期结果。新 OAuth 授权会撤销旧连接及事件订阅；不要为“刷新状态”反复授权。

参考：[OpenAI 连接 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[OAuth 插件配置](https://developers.openai.com/plugins/build/plugins#use-automatic-oauth-client-registration)。具体界面和权限以当前账号为准。

## 4. 扫码绑定微信

打开自己的 Worker 根页面，在管理表单中安全输入令牌，再生成二维码，使用本人微信扫码确认。二维码有时效，不必提前生成。

确认 `wechat_status` 返回 `connected:true`。本版遇到附加验证码或 IDC 重定向仅报告状态，尚未实现交互续接。

## 5. 建立事件任务并验收

向自己的 dot 发出指令，例如：

> 订阅这个插件的 message.created 事件。每当我绑定账号本人发来文字时，处理消息，并通过 wechat_reply 携带原始 messageId 回复原会话。不要创建定时轮询；不要重复回复；发送结果不确定时不要自动重发。敏感操作保留必要确认。

确认 `activeSubscriptions:1`，再从微信 ClawBot 发送唯一测试文字。分别验证消息入库、事件被接收、dot 自动执行，以及手机原会话实际收到回复。HTTP 2xx 仅表示回调被接受，不代表模型或回复已完成。

事件订阅有到期时间，需由客户端续订；长期续订可靠性仍需验证。使用结束后可取消任务或断开微信。断开会删除本应用保存的绑定和消息数据，操作前应了解数据影响。

## 更新部署

配置中的 `durable_objects.code_update_strategy.mode` 为 `immediate`。常驻长轮询可能延迟对象代码更新；即时更新保留持久化绑定，但可能中断正在处理的请求。

直接使用传统 Worker PUT 上传 API 时，在 multipart 的 `metadata` JSON 顶层设置：

```json
{"code_update_strategy":{"mode":"immediate"}}
```

不要依赖先 PUT、再对相同版本 POST 部署来保证立即应用。即使设置即时更新，也应复核管理诊断版本与实际行为。发送结果为 `uncertain` 或 `outcome_unknown` 时禁止盲目重试。
