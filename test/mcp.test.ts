import assert from "node:assert/strict";
import test from "node:test";
import { handleMcp, type McpBackend } from "../src/mcp.js";

function backend() {
  const calls: unknown[][] = [];
  const implementation: McpBackend = {
    status: async () => ({ connected: true }),
    receive: async (wait) => { calls.push(["receive", wait]); return { messages: [] }; },
    reply: async (id, text) => { calls.push(["reply", id, text]); return { sent: true }; },
    disconnect: async () => { calls.push(["disconnect"]); return { connected: false }; },
  };
  return { implementation, calls };
}
function req(message: unknown, headers: Record<string, string> = {}) {
  return new Request("https://bridge.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(message),
  });
}
const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

test("initialize negotiates only implemented protocol and advertises tools, not events", async () => {
  const { implementation } = backend();
  for (const [requested, expected] of [["2025-03-26", "2025-03-26"], ["2025-06-18", "2025-06-18"], ["2099-01-01", "2025-06-18"]]) {
    const res = await handleMcp(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "test", version: "1" } } }), implementation);
    const body = JSON.parse(await res.text());
    assert.equal(body.result.protocolVersion, expected);
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(res.headers.get("mcp-session-id"), null);
  }
});

test("transport returns 202 notifications and 405 unsupported SSE GET", async () => {
  const { implementation } = backend();
  const notice = await handleMcp(req({ jsonrpc: "2.0", method: "notifications/initialized" }), implementation);
  assert.equal(notice.status, 202); assert.equal(await notice.text(), "");
  assert.equal((await handleMcp(new Request("https://bridge.example/mcp"), implementation)).status, 405);
});

test("reject invalid media negotiation, protocol version, batch and oversized body", async () => {
  const { implementation, calls } = backend();
  assert.equal((await handleMcp(req(call("wechat_receive"), { Accept: "application/json" }), implementation)).status, 406);
  assert.equal((await handleMcp(req(call("wechat_receive"), { Accept: "application/json, text/event-stream;q=0" }), implementation)).status, 406);
  assert.equal((await handleMcp(req(call("wechat_receive"), { "Content-Type": "text/plain" }), implementation)).status, 415);
  assert.equal((await handleMcp(req(call("wechat_receive"), { "MCP-Protocol-Version": "invalid" }), implementation)).status, 400);
  assert.equal((await handleMcp(req([call("wechat_receive")]), implementation)).status, 400);
  assert.equal((await handleMcp(req(call("wechat_reply", { text: "a".repeat(40_000), messageId: "1" })), implementation)).status, 413);
  assert.deepEqual(calls, []);
});

test("receive bounds and reply recipient cannot be overridden", async () => {
  const { implementation, calls } = backend();
  for (const waitSeconds of [-1, 21, 1.5, "20"]) {
    assert.equal(JSON.parse(await (await handleMcp(req(call("wechat_receive", { waitSeconds })), implementation)).text()).error.code, -32602);
  }
  const wrong = JSON.parse(await (await handleMcp(req(call("wechat_reply", { messageId: "1", text: "hello", toUserId: "other" })), implementation)).text());
  assert.equal(wrong.error.code, -32602);
  assert.deepEqual(calls, []);
  await handleMcp(req(call("wechat_receive", { waitSeconds: 20 })), implementation);
  await handleMcp(req(call("wechat_reply", { messageId: "inbound-1", text: "hello" })), implementation);
  assert.deepEqual(calls, [["receive", 20], ["reply", "inbound-1", "hello"]]);
});

test("tools disclose irreversible sending and read-only receive; backend errors do not leak credentials", async () => {
  const { implementation } = backend();
  const list = JSON.parse(await (await handleMcp(req({ jsonrpc: "2.0", id: 1, method: "tools/list" }), implementation)).text());
  assert.equal(list.result.tools.find((t: { name: string }) => t.name === "wechat_receive").annotations.readOnlyHint, true);
  assert.equal(list.result.tools.find((t: { name: string }) => t.name === "wechat_reply").annotations.readOnlyHint, false);
  assert.equal(list.result.tools.find((t: { name: string }) => t.name === "wechat_receive").annotations.idempotentHint, true);
  assert.equal(list.result.tools.find((t: { name: string }) => t.name === "wechat_reply").annotations.destructiveHint, true);
  implementation.reply = async () => { throw new Error("bot_token=SECRET"); };
  const failure = JSON.parse(await (await handleMcp(req(call("wechat_reply", { messageId: "1", text: "hello" })), implementation)).text());
  assert.equal(failure.result.isError, true);
  assert.equal(JSON.stringify(failure).includes("SECRET"), false);
});

function modernReq(method: string, params: Record<string, unknown> = {}, overrides: Record<string, string> = {}) {
  return req({ jsonrpc: "2.0", id: 8, method, params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
    ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}), ...overrides });
}
test("MCP 2 discovery gates webhook events on configured backend", async () => {
  const { implementation } = backend();
  let value = JSON.parse(await (await handleMcp(modernReq("server/discover"), implementation)).text());
  assert.equal(value.result.resultType, "complete");
  assert.equal(value.result.capabilities.events, undefined);
  implementation.eventsEnabled = true;
  implementation.subscribe = async () => ({ id: "sub_1", refreshBefore: "2026-10-31T00:00:00Z", cursor: null, truncated: false });
  implementation.unsubscribe = async () => ({});
  value = JSON.parse(await (await handleMcp(modernReq("server/discover"), implementation)).text());
  assert.deepEqual(value.result.capabilities.events, {});
  const list = JSON.parse(await (await handleMcp(modernReq("events/list"), implementation)).text());
  assert.deepEqual(list.result.events[0].delivery, ["webhook"]);
  assert.equal((await handleMcp(modernReq("events/poll"), implementation)).status, 404);
});
test("MCP 2 validates mirrored headers before invoking tools", async () => {
  const { implementation, calls } = backend();
  const mismatch = await handleMcp(modernReq("tools/call", { name: "wechat_receive" }, { "Mcp-Name": "wechat_reply" }), implementation);
  assert.equal(mismatch.status, 400);
  assert.equal(JSON.parse(await mismatch.text()).error.code, -32020);
  const ok = await handleMcp(modernReq("tools/call", { name: "wechat_receive", arguments: { waitSeconds: 0 } }), implementation);
  assert.equal(JSON.parse(await ok.text()).result.resultType, "complete");
  assert.deepEqual(calls, [["receive", 0]]);
});
test("MCP 2 subscriptions validate parameters and expose categorized callback errors", async () => {
  const { implementation } = backend();
  implementation.eventsEnabled = true;
  implementation.subscribe = async (params) => {
    assert.equal(params.name, "message.created");
    return { id: "sub_test", refreshBefore: "2026-10-31T00:00:00Z", cursor: null, truncated: false };
  };
  implementation.unsubscribe = async () => ({});
  const params = { name: "message.created", arguments: {}, delivery: { mode: "webhook", url: "https://callbacks.example.com/events", secret: "whsec_" + Buffer.alloc(32).toString("base64") } };
  const good = JSON.parse(await (await handleMcp(modernReq("events/subscribe", params), implementation)).text());
  assert.equal(good.result.id, "sub_test");
  const bad = JSON.parse(await (await handleMcp(modernReq("events/subscribe", { ...params, arguments: { account: "other" } }), implementation)).text());
  assert.equal(bad.error.code, -32602);
});
