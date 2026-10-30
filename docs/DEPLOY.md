# Deploy your own copy / 一键部署同款

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/devinqiu888/weixin-agent-bridge)

[Use this GitHub template](https://github.com/new?template_name=weixin-agent-bridge&template_owner=devinqiu888) · [Fork the repository](https://github.com/devinqiu888/weixin-agent-bridge/fork)

## English

The button starts Cloudflare's guided deployment flow. It copies the public repository into **your GitHub account**, lets you choose your own Worker name, and provisions the Durable Objects from `wrangler.jsonc` in **your Cloudflare account**. The resulting deployment has separate storage; it does not inherit the author's Weixin binding, OAuth grants, messages, or secrets.

1. Click the button and sign in to your own Cloudflare/GitHub accounts. Choose the destination repository and Worker name. Review any account permissions or plan requirements presented by the platform.
2. Supply a **new random `BRIDGE_TOKEN`** of at least 32 characters. For example, generate a value locally with `openssl rand -hex 32` and enter it as a secret. The bundled `replace-me` value is intentionally too short to authenticate; do not use it.
3. Review the generated build/deploy commands. This repository's build script runs a Wrangler dry-run; its deploy script performs the actual deployment. Both Durable Object classes and their SQLite migrations are included.
4. Set `APP_ORIGIN` to your final Worker HTTPS origin, without `/mcp` or a trailing slash. If you do not know the URL until the first deployment completes, update this setting in **your copied repository's `wrangler.jsonc` and redeploy** before connecting ChatGPT. Do not leave `http://localhost:8787` in a cloud deployment. A dashboard-only edit may be overwritten by a future repository build.
5. Keep the stable OAuth redirect, set `EVENTS_DISCOVERY_ENABLED` to `true`, and configure only verified exact `CALLBACK_HOSTS`. The initial ChatGPT test used `connectors.api.openai.com`; verify the destination for your own installation. The template leaves event delivery disabled until configured.
6. Connect your `/mcp` URL in a compatible ChatGPT client using OAuth, open your Worker management page, and scan its QR code with your own Weixin account. Ask your dot to subscribe to `message.created` and reply to original messages. Follow [INSTALL.md](INSTALL.md) for details.
7. Send a test message only after the subscription is established, and confirm the reply on your phone.

“One-click” describes the deployment entry point. It does **not** bypass configuration, ChatGPT access requirements, OAuth consent, or Weixin QR verification. Cloudflare and ChatGPT usage may incur costs. This template flow has been checked against Cloudflare's documented format and local build checks; it has not yet been independently completed in another person's account.

## 中文

按钮会启动 Cloudflare 官方部署向导：将公开仓库复制到**使用者自己的 GitHub**，让使用者选择 Worker 名称，并在**自己的 Cloudflare 账号**中创建配置所需的 Durable Objects。每个部署拥有独立存储，不会继承作者的微信绑定、OAuth 授权、消息和密钥。

1. 点击按钮，登录自己的 Cloudflare / GitHub，选择仓库名称和 Worker 名称。平台要求的账号授权或套餐条件由使用者确认。
2. 填写**独立随机管理密钥 `BRIDGE_TOKEN`**，至少 32 字符。可在本机执行 `openssl rand -hex 32` 生成后填入 Secret。示例 `replace-me` 故意短于认证要求，不能直接使用。
3. 检查构建和部署命令：`build` 做 dry-run，`deploy` 才实际发布。仓库已经包含两个 Durable Object 类及 SQLite migrations。
4. 将 `APP_ORIGIN` 设为部署后的实际 HTTPS 根地址，不含 `/mcp` 和末尾斜线。若首次部署后才知道地址，修改**自己的仓库副本中的 `wrangler.jsonc` 并重新部署**，然后再连接 ChatGPT。云端不能保留 `http://localhost:8787`；只改控制台可能被下次仓库构建覆盖。
5. 保留稳定 OAuth 回调，将 `EVENTS_DISCOVERY_ENABLED` 设为 `true`，并核实后填写精确 `CALLBACK_HOSTS`。本项目首轮 ChatGPT 测试使用 `connectors.api.openai.com`，自己的安装仍需核实。模板默认不允许事件投递。
6. 在支持相关能力的 ChatGPT 客户端通过 OAuth 添加自己的 `/mcp` 地址，打开自己的 Worker 管理页，用本人微信扫码绑定，再让 dot 订阅 `message.created` 并回复原消息。详见 [INSTALL.md](INSTALL.md)。
7. 订阅建立后发送测试文字，确认手机原会话收到回复。

“一键”指部署入口，不代表免配置、免 ChatGPT 权限、免 OAuth 授权或免扫码。资源用量可能产生费用。目前已核对官方模板格式并完成本地构建检查，尚未在另一位用户的账号上独立完成这套向导验收。

## Copy, template, or fork?

- **Deploy button:** creates a copy and starts deployment through Cloudflare.
- **Use this template:** creates a fresh GitHub repository from the template; connect it to Workers Builds afterwards.
- **Fork:** keeps GitHub's fork relationship for tracking upstream updates; deploy the fork yourself.

Cloudflare's repository-copy flow is not necessarily a GitHub fork relationship. Secrets stay out of Git; choose a private copy if you intend to add personal deployment configuration. Before pulling upstream updates, review code and preserve your own configuration. Never publish credentials or conversation records.

Source / 官方依据：[Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
