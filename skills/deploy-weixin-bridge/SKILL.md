---
name: deploy-weixin-bridge
description: Deploy a personal Weixin ClawBot-to-ChatGPT dot bridge on the user's own Cloudflare account, including independent repository setup, OAuth configuration, QR binding, and text round-trip verification. Use when asked to deploy or install Weixin Agent Bridge; not for deploying unrelated Workers.
---

# Deploy Weixin Agent Bridge

Deploy https://github.com/devinqiu888/weixin-agent-bridge into the requesting user's own account. The bridge uses Workers + SQLite Durable Objects; model execution remains in a compatible ChatGPT dot. No OpenAI API key, VPS, full OpenClaw runtime, or Muse reverse engineering is needed.

Treat “one-click” as agent-assisted deployment: perform the authorized setup and checks, then hand off actual login, platform consent, or QR scanning when required. Do not claim those identity steps can be automated away.

## Establish the target

- Prefer available GitHub/Cloudflare connectors; use authenticated `gh`/Wrangler or the official deployment UI when a connector lacks the needed capability.
- Inspect the authenticated owner and available Cloudflare accounts. Reuse an unambiguous account; ask only when the destination cannot be determined. Do not reuse the author's deployment, secrets, OAuth grant, or QR code.
- Respect an explicitly chosen repository, visibility, Worker name, or domain. Otherwise suggest a fresh `weixin-agent-bridge` deployment; use a private repository copy by default if a new remote is wanted. Do not publish a new public repository without scope for that.
- Inspect existing resources before creating anything. An existing Worker with the same name is not permission to replace it. If resuming the user's existing bridge, preserve its bindings, migrations, secrets, grant, and data; skip fresh-secret preparation.

## Deploy

Read [references/deploy-runbook.md](references/deploy-runbook.md) for the exact workflow and integration pitfalls. Read the checked-out repository's `docs/INSTALL.md` and `docs/SECURITY.md` before configuring a live account.

1. Obtain a fresh source checkout in the workspace. Record the source commit. Inspect applicable repository instructions before running its scripts.
2. Discover the actual workers.dev subdomain or configured custom domain. Set an explicit HTTPS `APP_ORIGIN`; never guess another person's hostname or derive the issuer from untrusted request headers.
3. On a fresh checkout, use `scripts/prepare_deployment.py` to configure the Worker and generate a private management secret outside the repository. Its dry run validates inputs without creating a secret. It neither uploads nor prints the secret.
4. Install locked dependencies, regenerate types, run checks and the dry run. Deploy both Durable Object classes with their existing migrations. Set `BRIDGE_TOKEN` through the secret mechanism, not a plaintext var. Verify the returned URL and OAuth metadata before connecting ChatGPT.
5. Enable event discovery. Keep callback delivery disabled until the exact platform callback hostname is independently verified. Configure only that trusted host; do not disable verification or broaden to a wildcard to fix an error.
6. Complete the user's ChatGPT OAuth connection and verify tools plus `message.created` discovery. If the environment cannot operate their ChatGPT client, provide the concrete MCP URL and the next manual step, and report installation as pending.
7. Generate the QR only when ready to bind; notify the user immediately and wait for their scan. Verify `connected:true`, then establish an event task and confirm `activeSubscriptions:1` before asking for a test message.
8. Confirm automatic dot execution, successful `wechat_reply`, and actual reply receipt in the original Weixin conversation. Keep these separate from deployment, OAuth success, and webhook HTTP 2xx.

## Non-obvious boundaries

- Runtime is single-owner. Do not share one deployment's management token across users.
- OAuth redirect URIs and event callback hosts are different settings. Retain the exact stable ChatGPT OAuth redirect when adding an installation-specific dynamic redirect.
- A new OAuth authorization replaces the previous active grant. Do not reauthorize as a generic troubleshooting step.
- `immediate` code update preserves persisted data but may interrupt requests; verify the active DO code after deployment. Never clear binding/storage to force an update.
- At most one retry after a transient deployment failure, and only after inspecting whether the first attempt succeeded. For authentication, billing, permission, or same-name collision blockers, report the specific unresolved prerequisite. Do not buy a plan or change access automatically.
- Never automatically retry `uncertain`/`outcome_unknown` message sends, replay old events, or create polling tasks as a silent substitute for event subscriptions.
- Current text-only tests observed roughly 34–95 seconds. Do not promise instant replies, free hosting, directory approval, or availability for all ChatGPT accounts.

## Handoff

Return the user's repository (if created), Worker and MCP URLs, source revision, completed verification stages, and any remaining user action. Give the private secret file location only to the local user; never include the token value in chat, screenshots, Git, logs, or reports. No maintenance automation or extra external messaging is implied by this skill.
