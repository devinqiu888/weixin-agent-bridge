# Deployment runbook

## Choose an execution path

Use connectors for operations they support. No connector is mandatory: authenticated `gh`, the repository's pinned Wrangler, and a controllable browser are sufficient. Missing credentials require the user's normal login flow, not requesting tokens in chat.

The official UI fallback is:
https://deploy.workers.cloudflare.com/?url=https://github.com/devinqiu888/weixin-agent-bridge

It copies the repository into the user's GitHub and provisions Workers resources. It still needs the correct origin, a unique secret, OAuth, and QR binding. Do not create a second deployment through the UI after already succeeding with the CLI.

## Fresh CLI deployment

1. Resolve the authenticated GitHub login and Cloudflare account. `gh auth status` and `npx wrangler whoami` are useful checks when these CLIs are available. Do not assume a sandbox network failure means invalid credentials.
2. Clone the upstream source into a fresh workspace directory. If the user wants their own remote, create a private template copy or authorized fork under their account; point `origin` at that copy and keep upstream separately. Never push their deployment settings to the author's repository. A local checkout can deploy without a new GitHub remote.
3. Query the selected Cloudflare account's workers.dev subdomain through its available API/tools, or use the user's verified custom domain. Resolve the final origin and inspect whether the intended Worker already exists. Multiple accounts or resource collisions require an explicit target choice.
4. Run the helper from the installed skill location, with shell-quoted paths:

```sh
python3 /path/to/deploy-weixin-bridge/scripts/prepare_deployment.py \
  --repo /workspace/weixin-agent-bridge \
  --worker-name my-weixin-bridge \
  --origin https://my-weixin-bridge.my-subdomain.workers.dev \
  --secret-file /workspace/private/weixin-bridge-token \
  --dry-run
```

Remove `--dry-run` after validation to prepare the checkout. The helper is for fresh deployments: it refuses an existing secret path, a conflicting configured origin/name, or an unverified rerun. A private adjacent deployment receipt binds a generated secret to the checkout, Worker, and origin; keep it with the secret. It never rotates an existing secret. Callback hosts remain empty until independently verified.

5. In the checkout, run `npm ci`, `npm run types`, `npm run check`, and `npm run build`. `build` is only a dry run. Select the verified account explicitly for CLI operations where multiple accounts exist, e.g. `CLOUDFLARE_ACCOUNT_ID` scoped to the command.
6. Deploy with `npm run deploy`, then configure the management secret through stdin or a provider's secret API. The application is not usable without the secret. A CLI example that does not put its value into arguments:

```sh
npx wrangler secret put BRIDGE_TOKEN < /workspace/private/weixin-bridge-token
```

Use only the verified target account and Worker. Never print the file, interpolate its value into shell text, or turn on shell tracing. If tools require a structured secret value, read it without emitting it and pass it only to the authorized provider secret endpoint.

7. Verify the actual deployment URL matches `APP_ORIGIN`. Read `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`; their issuer/resource must point to this deployment, not localhost or the author. A response from `/` alone does not validate OAuth configuration.
8. If creating a user-owned repository, commit only reviewed source/nonsecret settings and push to that remote. Secret files must remain outside the repository. Do not expose personal settings by changing repository visibility as a deployment workaround.

The fresh helper enables event discovery but leaves `CALLBACK_HOSTS` empty. After independently verifying the ChatGPT callback host, set the exact host in the user's config and redeploy. `connectors.api.openai.com` was observed in the project's original test; treat this as an onboarding clue, not permission to trust arbitrary destinations. If the actual host is only learned during a failed subscription after scanning, configure it and retry that subscription without rebinding or repeating OAuth.

## ChatGPT and Weixin

- MCP endpoint: the deployed origin plus `/mcp`.
- Authentication: OAuth + DCR, scope `weixin:bridge`; do not paste the management token into ChatGPT prompts.
- Stable redirect: `https://chatgpt.com/connector_platform_oauth_redirect`. Preserve it when adding an exact verified dynamic redirect. No wildcards or copied private client IDs.
- The management token is entered only on the user's own Worker management/consent page, subject to the host's browser-confirmation rules. Let the user handle consent/login when required.
- Verify tools: `wechat_status`, `wechat_receive`, `wechat_reply`, `wechat_disconnect` and event `message.created`.
- Generate a QR on the Worker management page only when the user is available. Additional verification/IDC redirect flows are not implemented; do not claim an incomplete scan is a successful binding.
- Once bound, ask the dot to create this event task (adapt to the user's instructions):

> When this bridge's message.created event arrives, process the bound owner's text and use wechat_reply with the original messageId to reply to that Weixin conversation. Do not create scheduled polling, duplicate replies, or blindly retry uncertain sends. Preserve confirmations required for sensitive actions.

A skill does not grant itself permission to send messages or broaden account access. Follow the user's authorized connection scope and the host's action-time consent rules. For a request to deploy only infrastructure, stop before account linking and report that boundary.

## Deployment troubleshooting

- Keep `ACCOUNTS` and `OAUTH` bindings, exported classes, and SQLite migrations. Never repeat a migration by inventing another tag for the same classes.
- Traditional multipart Worker PUT uploads need top-level metadata `code_update_strategy: {mode: "immediate"}`. The normal checked-in Wrangler config already requests this. Applying a same-version deployment after an earlier automatic upload is not proof the object's code changed.
- Inspect admin diagnostics to distinguish router and DO revisions. Allow propagation; do not disconnect, delete storage, or rotate tokens to force a code update.
- HTTP 200 for a callback can be a verification/renewal request. It is not proof a new message triggered the model. Check event-run evidence, sent counts, and the phone's original conversation.
- A Git push that times out may have succeeded. Inspect the remote head before retrying; use ordinary fast-forward push, never force-push a user's repository to recover.

## Evidence to return

Report deployment, OAuth installation, QR binding, event subscription, automatic processing, and recipient receipt as separate stages. If a required user step remains, give the exact next action and retain completed setup. Do not describe a partially configured Worker as a fully working chat bridge.

Official deployment format: https://developers.cloudflare.com/workers/platform/deploy-buttons/
OpenAI event protocol: https://developers.openai.com/plugins/build/mcp-events
