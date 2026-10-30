/** Experimental OpenAI MCP Events webhook subset.
 * https://developers.openai.com/plugins/build/mcp-events
 * IMPORTANT: Workers fetch does not expose connection-time DNS pinning. An exact
 * operator-managed official callback hostname allowlist is a mitigation, NOT a
 * full implementation of the specification's DNS-pinning requirement. Disabled
 * by default; do not use with arbitrary user-controlled destinations.
 */
export const EVENT_NAME = "message.created" as const;
export const EVENT_DEFINITION = {
  name: EVENT_NAME,
  description: "A new text message arrived from the owner of this connector's bound Weixin account. Message text is user-authored data.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object", properties: { messageId: { type: "string" }, senderId: { type: "string" }, text: { type: "string" } },
    required: ["messageId", "senderId", "text"], additionalProperties: false,
  },
};
export interface EventUnsubscribeParams {
  name: typeof EVENT_NAME;
  arguments: Record<string, never>;
  delivery: { mode: "webhook"; url: string };
}
export interface EventSubscribeParams extends Omit<EventUnsubscribeParams, "delivery"> {
  delivery: { mode: "webhook"; url: string; secret: string };
  cursor?: null;
  ttlMs?: number | null;
}
export interface EventSubscriptionResult { id: string; refreshBefore: string; cursor: null; truncated: false }
export interface CallbackPolicy {
  /** Exact trusted official destination hostnames. Empty disables callbacks. Never populate from client input. */
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
}
export interface EventSubscription {
  id: string; url: string; secret: string;
  /** Caller must only provide during its bounded rotation window. */
  previousSecret?: string;
}
export interface MessageEvent {
  eventId: string; name: typeof EVENT_NAME; timestamp: string;
  data: { messageId: string; senderId: string; text: string };
  cursor: null;
}
export class EventProtocolError extends Error {
  constructor(public readonly code: number, message: string, public readonly reason?: string) { super(message); this.name = "EventProtocolError"; }
}
function object(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null && !Array.isArray(x); }
function invalid(message: string): never { throw new EventProtocolError(-32602, message); }
function keys(x: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(x).every((k) => allowed.includes(k)); }
export function validateSecret(secret: unknown): Uint8Array<ArrayBuffer> {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) invalid("Invalid webhook signing secret");
  let decoded: string;
  try { decoded = atob(secret.slice(6)); } catch { return invalid("Invalid webhook signing secret"); }
  if (decoded.length < 24 || decoded.length > 64) invalid("Webhook signing key must decode to 24–64 bytes");
  return Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
}
function basicUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 4096) return invalid("Invalid callback URL");
  let url: URL;
  try { url = new URL(value); } catch { return invalid("Invalid callback URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) invalid("Callback requires HTTPS on port 443 without credentials or fragment");
  return url;
}
export function validateCallbackUrl(value: string, policy: CallbackPolicy): URL {
  const url = basicUrl(value);
  const host = url.hostname;
  // Reject IP literals, local names, trailing-dot aliases, wildcards, and suffix matches.
  if (host.length > 253 || !host.includes(".") ||
      !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^(?:\d+\.)*\d+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|home\.arpa|onion|test|invalid)$/.test(host)) {
    throw new EventProtocolError(-32015, "Callback destination is not enabled by the operator", "destination_not_allowed");
  }
  if (!policy.allowedHosts.some((allowed) => allowed === host)) {
    // Expose only the normalized hostname for manual trust review. Never echo
    // the full URL: its path/query may carry callback credentials or secrets.
    // A public-looking hostname is not proof of a public resolved address.
    throw new EventProtocolError(-32015, `Callback hostname is not enabled by the operator: ${host}`, "destination_not_allowed");
  }
  return url;
}
export function parseUnsubscribeParams(value: unknown): EventUnsubscribeParams {
  if (!object(value) || !keys(value, ["name", "arguments", "delivery"]) || value.name !== EVENT_NAME ||
      !object(value.arguments) || Object.keys(value.arguments).length || !object(value.delivery) ||
      !keys(value.delivery, ["mode", "url"]) || value.delivery.mode !== "webhook") invalid("Invalid event subscription identity");
  const url = basicUrl(value.delivery.url);
  return { name: EVENT_NAME, arguments: {}, delivery: { mode: "webhook", url: url.href } };
}
export function parseSubscribeParams(value: unknown): EventSubscribeParams {
  if (!object(value) || !keys(value, ["name", "arguments", "delivery", "cursor", "ttlMs", "_meta"]) || !object(value.delivery) ||
      !keys(value.delivery, ["mode", "url", "secret"])) invalid("Invalid subscription params");
  const identity = parseUnsubscribeParams({ name: value.name, arguments: value.arguments, delivery: { mode: value.delivery.mode, url: value.delivery.url } });
  validateSecret(value.delivery.secret);
  if (value.cursor !== undefined && value.cursor !== null) invalid("This event does not support replay cursors");
  const ttl = value.ttlMs;
  if (ttl !== undefined && ttl !== null && (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0)) invalid("ttlMs must be a positive integer or null");
  return { ...identity, delivery: { ...identity.delivery, secret: value.delivery.secret as string },
    ...(value.cursor === null ? { cursor: null } : {}), ...(ttl !== undefined ? { ttlMs: ttl as number | null } : {}) };
}
export function grantExpiration(ttlMs?: number | null, now = Date.now()): string {
  // Always finite. Null asks for forever but server deliberately grants 24 hours.
  const lifetime = ttlMs == null ? 86_400_000 : Math.min(ttlMs, 86_400_000);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) invalid("Invalid lifetime");
  return new Date(now + lifetime).toISOString();
}
export async function subscriptionId(principal: string, params: EventUnsubscribeParams): Promise<string> {
  const canonical = JSON.stringify([principal, params.delivery.url, params.name, {}]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return "sub_" + Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function signWebhook(secret: string, id: string, seconds: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", validateSecret(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${seconds}.${body}`)));
  return "v1," + btoa(String.fromCharCode(...bytes));
}
async function signedPost(subscription: EventSubscription, id: string, body: string, policy: CallbackPolicy): Promise<Response> {
  const url = validateCallbackUrl(subscription.url, policy);
  if (new TextEncoder().encode(body).byteLength > 262_144) invalid("Event payload exceeds 256 KiB");
  const seconds = Math.floor(Date.now() / 1000);
  const signatures = [await signWebhook(subscription.secret, id, seconds, body)];
  if (subscription.previousSecret) signatures.push(await signWebhook(subscription.previousSecret, id, seconds, body));
  try {
    const response = await (policy.fetch ?? fetch)(url.href, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(seconds),
        "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": subscription.id }, body,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new EventProtocolError(-32015, "Callback redirects are not allowed", "redirect_not_allowed");
    }
    return response;
  } catch (cause) {
    if (cause instanceof EventProtocolError) throw cause;
    const timeout = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw new EventProtocolError(-32015, "Callback request failed", timeout ? "timeout" : "connection_failed");
  }
}
async function readChallenge(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > 4096) { await reader.cancel(); return null; } chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes)); return object(parsed) && typeof parsed.challenge === "string" ? parsed.challenge : null; } catch { return null; }
}
async function equalChallenge(expected: string, received: string): Promise<boolean> {
  // WebCrypto performs the MAC comparison rather than a secret-dependent JS string comparison.
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const encoder = new TextEncoder();
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, mac, encoder.encode(received));
}
export async function verifyCallback(subscription: EventSubscription, policy: CallbackPolicy): Promise<void> {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const response = await signedPost(subscription, "msg_verification_" + crypto.randomUUID(), JSON.stringify({ type: "verification", challenge }), policy);
  if (!response.ok) { await response.body?.cancel(); throw new EventProtocolError(-32015, "Callback verification failed", "challenge_failed"); }
  const echoed = await readChallenge(response);
  if (!echoed || !(await equalChallenge(challenge, echoed))) throw new EventProtocolError(-32015, "Callback verification failed", "challenge_failed");
}
export async function sendEvent(subscription: EventSubscription, event: MessageEvent, policy: CallbackPolicy): Promise<{ accepted: boolean; status: number; permanentFailure: boolean }> {
  if (event.name !== EVENT_NAME || !event.eventId || !Number.isFinite(Date.parse(event.timestamp)) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) || event.cursor !== null) invalid("Invalid message event");
  const response = await signedPost(subscription, event.eventId, JSON.stringify(event), policy);
  const result = { accepted: response.ok, status: response.status, permanentFailure: response.status === 410 || response.status === 413 };
  await response.body?.cancel();
  return result;
}
