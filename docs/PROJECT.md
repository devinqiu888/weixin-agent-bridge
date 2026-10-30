# 项目说明初稿 / Project draft

## 中文介绍

Weixin Agent Bridge 希望让微信成为与个人 AI 助手对话的入口。用户将服务部署到自己的 Cloudflare 账号，授权 ChatGPT 连接，扫码绑定微信 ClawBot，即可通过微信文字触发 dot 工作，并在原会话收到回复。

首版聚焦最小可用链路：单账号、文字输入、事件触发、原会话回复。它不运行模型，不依赖完整 OpenClaw，不通过逆向 Muse 获取控制能力。微信适配参考腾讯公开代码；ChatGPT 接入使用 OAuth、MCP 工具与 MCP Events。

## English introduction

Weixin Agent Bridge turns Weixin ClawBot into a messaging interface for your personal ChatGPT dot. Deploy the bridge to your own Cloudflare account, authorize the ChatGPT connection, and bind Weixin with a QR code. Incoming text messages can trigger the dot through MCP Events, with responses delivered back to the original conversation.

The first release focuses on a small, practical scope: one owner, text messages, event-triggered execution, and replies to existing messages. It does not host a model, require the full OpenClaw runtime, or reverse engineer Muse. The Weixin adapter is based on Tencent's published code, while the ChatGPT connection uses OAuth, MCP tools, and MCP Events.

## Architecture

- **Worker:** HTTP management interface, OAuth routes, MCP discovery and tools.
- **WeixinAccount Durable Object:** account binding, iLink polling, message deduplication, send reservations, event subscriptions, and delivery queue.
- **OAuthState Durable Object:** client registration, authorization grants, token hashes, token rotation, and revocation.
- **ChatGPT dot:** event handling, model reasoning, tool use, and response generation.

## 首版设计取舍

1. 一部署一用户，降低账号隔离与运维复杂度；不宣称支持多租户。
2. 由 Worker 轮询微信，再用事件触发模型，避免模型不断调用接收工具。
3. 发送前持久化预约；接口结果不确定时保留记录并停止自动重发。
4. 只向既有消息对应的原会话回复，不开放任意收件人参数。
5. 默认关闭事件投递，由部署者核实可信回调域名后启用。

## 后续方向（尚未承诺实现）

- 测量和解释不同阶段的延迟，验证长期续订与故障恢复。
- 改善安装引导、凭据管理和数据保留控制。
- 在明确权限与存储策略后扩展图片、语音和文件。
- 补齐更严格的回调网络验证，并评估正式目录发布要求。
- 若确有需求，再设计多租户隔离；不能直接共享现有管理令牌实现。

当前完成情况见 [验证记录](VALIDATION.md)。路线图中的内容均不代表现有功能。
