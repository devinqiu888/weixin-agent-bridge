# Deploy with an agent skill / 用 Skill 部署

The repository includes [`deploy-weixin-bridge`](../skills/deploy-weixin-bridge/SKILL.md), a reusable agent skill that guides an assistant through deploying an independent bridge in the requesting user's own account. It includes a local configuration helper, not a hidden hosted service.

仓库内提供可安装的 [`deploy-weixin-bridge`](../skills/deploy-weixin-bridge/SKILL.md)。安装后，让 agent 执行部署，它会检查目标账号、准备配置与独立密钥、部署并验证连接，在需要本人登录、授权或扫码时提示。

## Install in Codex / 安装

Ask Codex with its skill installer:

```text
Use $skill-installer to install the skill from
https://github.com/devinqiu888/weixin-agent-bridge/tree/main/skills/deploy-weixin-bridge
```

或者在已安装标准 Codex skill-installer 的环境执行：

```sh
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo devinqiu888/weixin-agent-bridge \
  --path skills/deploy-weixin-bridge
```

If your Codex installation uses a custom skills directory, use that installation's installer path. Restart Codex after installation so it discovers the skill. An alternative is to copy the whole `skills/deploy-weixin-bridge` directory into your agent's supported skill directory; do not copy only `SKILL.md`, because its helper and runbook are required. Other agents must support the skill format and required deployment tools; compatibility has not been tested universally.

安装后重启 Codex。也可以将整个 skill 文件夹放入客户端支持的技能目录，不能只复制 `SKILL.md`。其他 agent 是否可用取决于其 skill 格式和工具能力，不宣称通用兼容。

## Invoke / 使用

中文：

```text
用 $deploy-weixin-bridge 帮我在自己的 Cloudflare 账号部署微信 ClawBot 到 ChatGPT dot 的桥接。
自动完成可执行的配置、部署和检查；需要我登录、授权或扫码时告诉我。
如果已有同名服务，先核实用途，不要覆盖。
```

English:

```text
Use $deploy-weixin-bridge to deploy my own Weixin ClawBot-to-ChatGPT dot bridge on Cloudflare.
Complete the configuration, deployment, and verification you can perform, and tell me when I need to sign in, authorize, or scan.
Check any existing same-name service before making changes.
```

A request to deploy infrastructure alone does not authorize connecting personal accounts or sending messages. Tell your agent whether you want the full connection and a text round-trip test.

## What the skill handles / 能做什么

- Resolve the target account and avoid overwriting an unrelated deployment.
- Prepare a fresh checkout, explicit service origin, and a random private secret outside Git.
- Run checks and deploy Workers plus the two SQLite Durable Objects.
- Configure OAuth and verified callback destinations, then guide ChatGPT connection and Weixin QR binding.
- Verify subscription, automatic execution, and actual reply receipt as separate stages.

It does not include the author's account, credential, subscription, or deployment. It cannot supply a Cloudflare account, ChatGPT feature access, or substitute for human login/consent/QR verification. No additional model API key is required by this bridge, but platform usage may incur costs.

Skill 并不附带作者账号、密钥、订阅或部署，也不会替代本人完成登录、授权和扫码。“一句话部署”是 agent 帮你完成流程，不是跳过这些前提。

## Validation / 验证边界

The preparation helper has offline tests for side-effect-free dry runs, private secret handling, repeatability, and conflicting-target refusal. These tests do not prove a fresh third-party cloud account can complete every step. The original bridge has passed text round-trip tests; this newly packaged skill still needs an independent real-account onboarding test.

配置脚本已验证离线准备行为；原桥接服务已通过真实文字往返测试。新封装的 skill 尚未在另一人的账号完成独立全流程验收。
