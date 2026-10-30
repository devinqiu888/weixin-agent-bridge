import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { validateSecret, validateCallbackUrl, parseSubscribeParams, subscriptionId, signWebhook, verifyCallback, sendEvent, grantExpiration, EventProtocolError, type CallbackPolicy, type MessageEvent } from "../src/events.js";

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const identity = { name: "message.created" as const, arguments: {}, delivery: { mode: "webhook" as const, url: "https://callbacks.example.com/events" } };
const subscription = { id: "sub_test", url: identity.delivery.url, secret };
const event: MessageEvent = { eventId: "evt_1", name: "message.created", timestamp: "2026-10-30T00:00:00Z", data: { messageId: "1", senderId: "owner", text: "hello" }, cursor: null };

test("callbacks disabled by default and require exact HTTPS official host configuration", () => {
  assert.throws(() => validateCallbackUrl(subscription.url, { allowedHosts: [] }), EventProtocolError);
  for (const url of ["http://callbacks.example.com/events", "https://callbacks.example.com.evil.com/events", "https://127.0.0.1/events", "https://[::1]/events", "https://callbacks.example.com:444/events", "https://user@callbacks.example.com/events", "https://callbacks.example.com./events"]) {
    assert.throws(() => validateCallbackUrl(url, { allowedHosts: ["callbacks.example.com"] }), EventProtocolError);
  }
  assert.equal(validateCallbackUrl(subscription.url, { allowedHosts: ["callbacks.example.com"] }).href, subscription.url);
});

test("untrusted callback exposes only hostname and never starts verification or delivery", async () => {
  let requests = 0;
  const privatePath = "private-callback-token";
  const querySecret = "private-query-token";
  const blocked = { ...subscription, url: `https://new-callback.example.com/${privatePath}?token=${querySecret}` };
  const policy: CallbackPolicy = { allowedHosts: [], fetch: async () => {
    requests++; throw new Error("Network must not be called");
  } };
  const rejectsSafely = (err: unknown): boolean => {
    assert.ok(err instanceof EventProtocolError);
    assert.equal(err.code, -32015);
    assert.equal(err.reason, "destination_not_allowed");
    assert.equal(err.message, "Callback hostname is not enabled by the operator: new-callback.example.com");
    for (const sensitive of [privatePath, querySecret, secret, blocked.url]) {
      assert.ok(!String(err).includes(sensitive));
      assert.ok(!JSON.stringify(err).includes(sensitive));
    }
    return true;
  };
  await assert.rejects(verifyCallback(blocked, policy), rejectsSafely);
  await assert.rejects(sendEvent(blocked, event, policy), rejectsSafely);
  assert.equal(requests, 0);
});

test("IP, local and malformed callback failures remain generic", () => {
  for (const target of ["127.0.0.1", "[::1]", "printer.local", "box.internal", "box.home.arpa", "box.lan", "localhost", "bad..example.com", "-bad.example.com", "bad_.example.com", "callbacks.example.com."]) {
    assert.throws(() => validateCallbackUrl(`https://${target}/private?secret=hidden`, { allowedHosts: [] }), (err: unknown) => {
      assert.ok(err instanceof EventProtocolError);
      assert.equal(err.message, "Callback destination is not enabled by the operator");
      return true;
    });
  }
  assert.throws(() => validateCallbackUrl("not a URL/private?secret=hidden", { allowedHosts: [] }), (err: unknown) =>
    err instanceof EventProtocolError && err.message === "Invalid callback URL");
});

test("validates signing secrets, event scope and non-replay semantics", () => {
  assert.equal(validateSecret(secret).length, 32);
  for (const bad of ["", "whsec_?", "whsec_" + Buffer.alloc(23).toString("base64"), "whsec_" + Buffer.alloc(65).toString("base64")]) assert.throws(() => validateSecret(bad));
  const params = { ...identity, delivery: { ...identity.delivery, secret }, cursor: null };
  assert.equal(parseSubscribeParams(params).delivery.secret, secret);
  assert.throws(() => parseSubscribeParams({ ...params, arguments: { account: "other" } }));
  assert.throws(() => parseSubscribeParams({ ...params, cursor: "resume" }));
  assert.throws(() => parseSubscribeParams({ ...params, ttlMs: -1 }));
});

test("subscription IDs are owner-scoped and lifetime is finite and capped", async () => {
  assert.equal(await subscriptionId("owner", identity), await subscriptionId("owner", identity));
  assert.notEqual(await subscriptionId("owner", identity), await subscriptionId("other", identity));
  assert.equal(grantExpiration(1000, 0), "1970-01-01T00:00:01.000Z");
  assert.equal(grantExpiration(null, 0), "1970-01-02T00:00:00.000Z");
  assert.equal(grantExpiration(999_999_999, 0), "1970-01-02T00:00:00.000Z");
});

test("Standard Webhooks signature matches independent node HMAC", async () => {
  const body = JSON.stringify(event);
  const expected = "v1," + createHmac("sha256", Buffer.alloc(32, 7)).update(`evt_1.100.${body}`).digest("base64");
  assert.equal(await signWebhook(secret, "evt_1", 100, body), expected);
});

test("verification requires fresh challenge echo and redirects are blocked", async () => {
  let count = 0;
  const policy: CallbackPolicy = { allowedHosts: ["callbacks.example.com"], fetch: async (_url, init) => {
    count++;
    assert.equal(init?.redirect, "manual");
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.type, "verification");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-MCP-Subscription-Id"), "sub_test");
    assert.match(headers.get("webhook-signature")!, /^v1,/);
    return Response.json({ challenge: sent.challenge });
  } };
  await verifyCallback(subscription, policy); assert.equal(count, 1);
  await assert.rejects(verifyCallback(subscription, { ...policy, fetch: async () => Response.json({ challenge: "wrong" }) }), (err: unknown) => err instanceof EventProtocolError && err.reason === "challenge_failed");
  await assert.rejects(verifyCallback(subscription, { ...policy, allowedHosts: [] }));
  assert.equal(count, 1);
});

test("event delivery preserves event ID and signs exact bytes with rotation keys", async () => {
  let delivered: string | undefined;
  const outcome = await sendEvent({ ...subscription, previousSecret: "whsec_" + Buffer.alloc(32, 8).toString("base64") }, event, {
    allowedHosts: ["callbacks.example.com"], fetch: async (_url, init) => {
      delivered = String(init?.body);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("webhook-id"), event.eventId);
      assert.equal(headers.get("webhook-signature")!.split(" ").length, 2);
      const expected = await signWebhook(secret, event.eventId, Number(headers.get("webhook-timestamp")), delivered);
      assert.equal(headers.get("webhook-signature")!.split(" ")[0], expected);
      return new Response(null, { status: 410 });
    },
  });
  assert.equal(delivered, JSON.stringify(event));
  assert.deepEqual(outcome, { accepted: false, status: 410, permanentFailure: true });
});


test("callback redirects are rejected without a second request", async () => {
  let requests = 0;
  await assert.rejects(verifyCallback(subscription, { allowedHosts: ["callbacks.example.com"], fetch: async () => {
    requests++; return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } });
  } }), (err: unknown) => err instanceof EventProtocolError && err.reason === "redirect_not_allowed");
  assert.equal(requests, 1);
});
