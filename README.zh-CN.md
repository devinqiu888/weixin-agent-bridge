# Weixin Agent Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

**通过微信 ClawBot 与你的 ChatGPT dot 聊天，桥接服务只需部署在 Cloudflare。**

Weixin Agent Bridge 把绑定账号本人发给微信 ClawBot 的文字消息接入 ChatGPT dot，再将 dot 的回复送回原微信会话。桥接服务运行在 Cloudflare Workers 与 SQLite Durable Objects 上，不需要 VPS、本地常驻程序或完整 OpenClaw 环境。

项目使用 MCP Events 触发 dot 工作，无需让模型每隔几秒循环检查消息。桥接服务负责微信接入、持久化队列、OAuth 授权和消息回发；模型执行由兼容的 ChatGPT 客户端承担。服务本身不调用模型 API，也不需要 OpenAI API Key。

这是一个供个人自行部署的实验性开源项目，当前每个部署只服务一个账号，不是多用户托管平台，也不是腾讯或 OpenAI 官方产品。

## 工作方式

```text
微信 ClawBot
    ↓ iLink 长轮询
Cloudflare Worker + Durable Objects
    ↓ MCP Events 签名事件
ChatGPT dot 处理消息
    ↓ wechat_reply
回复原微信会话
```

“只用 Worker”指桥接基础设施全部在 Cloudflare：仍使用 Durable Objects 保存绑定、消息、OAuth 状态和事件队列，ChatGPT 负责模型推理。

## 已实现

- 微信二维码绑定及绑定状态检查。
- 仅接收扫码账号本人文字，按原消息回复，不提供任意联系人发送功能。
- OAuth、PKCE 和动态客户端注册。
- `wechat_status`、`wechat_receive`、`wechat_reply`、`wechat_disconnect` 四个 MCP 工具。
- `message.created` 事件订阅、回调签名验证、持久化投递队列。
- 消息去重和发送预约；发送结果不确定时不自动重发。
- 管理端脱敏计数诊断，不把聊天正文写入诊断字段。

## 实测结果

2026 年 10 月 30 日完成首轮真实账号验证：**4 条文字消息均由事件自动触发 dot，4 次回复发送成功，用户确认微信端收到回复。**

本轮从事件生成到发送成功约需 **34–95 秒**，依据任务运行记录估算，不是压测结果，也不保证秒回。图片、语音、文件、多用户隔离和长期稳定运行尚未验证。

## 快速开始

准备 Node.js 22.13+、npm、支持 Workers 和 SQLite Durable Objects 的 Cloudflare 账号、可用的微信 ClawBot，以及支持自定义 OAuth MCP 和 MCP Events 的 ChatGPT 账号与客户端。

```sh
git clone https://github.com/devinqiu888/weixin-agent-bridge.git
cd weixin-agent-bridge
npm ci
npm run check
npm run build
```

`build` 仅执行部署预检查，不会发布。随后按 [部署与授权指南](docs/INSTALL.md) 配置服务地址、管理密钥、OAuth 回调和可信事件回调主机，完成 ChatGPT 安装、微信扫码与 dot 事件订阅。

本地开发可复制 `.dev.vars.example` 为 `.dev.vars`，填写独立随机管理令牌，再运行 `npm run dev`。不要提交真实令牌。

## 当前边界

- 每个部署只支持一个微信绑定、一个有效 OAuth 连接和一个活跃事件订阅；新授权会替换旧授权。
- 事件投递默认关闭，需明确配置可信回调主机。精确域名白名单不能替代完整的 DNS 重绑定防护，不适合作为任意客户端的公共回调中转服务。
- 待处理消息会按期限清理；已发送或发送结果不确定的记录保留用于去重，断开时清除本地保存数据。详情见 [数据与安全说明](docs/SECURITY.md)。
- 普通 MCP 工具连接不等于后台自动触发能力；是否可用仍取决于 ChatGPT 客户端、账号权限和平台规则。
- 不消耗本项目自己的模型 API 额度，但 Cloudflare 资源及 ChatGPT 使用可能收费。持续长轮询会使 Durable Object 保持活跃，不能承诺永久免费。
- 当前为实验版本，尚未提交或通过官方插件目录审核。

## 文档

- [部署与 OAuth 接入](docs/INSTALL.md)
- [项目说明初稿与路线图](docs/PROJECT.md)
- [数据与安全说明](docs/SECURITY.md)
- [验证记录](docs/VALIDATION.md)

## 开源许可

采用 [MIT License](LICENSE)。腾讯协议相关代码归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目与腾讯、OpenAI、OpenClaw 项目不存在官方隶属或背书关系。
