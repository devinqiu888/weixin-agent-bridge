import { EVENT_DEFINITION, EventProtocolError, parseSubscribeParams, parseUnsubscribeParams, type EventSubscribeParams, type EventUnsubscribeParams, type EventSubscriptionResult } from "./events.js";

/**
 * Stateless, JSON-response subset of MCP Streamable HTTP.
 * Specs: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 * No SSE or server-initiated transport requests. Optional MCP 2 Events use
 * signed webhook subscriptions; the host controls whether an event starts work.
 * The caller MUST authenticate and validate Origin before invoking this handler.
 */
export interface McpBackend {
  /** Return only public connection status; never credentials. */
  status(): Promise<unknown>;
  /** Read queued messages without consuming them. The backend enforces the wait deadline. */
  receive(waitSeconds: number): Promise<unknown>;
  reply(messageId: string, text: string): Promise<unknown>;
  disconnect(): Promise<unknown>;
  eventsEnabled?: boolean;
  subscribe?(params: EventSubscribeParams): Promise<EventSubscriptionResult>;
  unsubscribe?(params: EventUnsubscribeParams): Promise<Record<string, never>>;
}

const VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const MODERN_VERSION = "2026-07-28";
const MAX_BODY_BYTES = 32_768;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  {
    name: "wechat_status",
    description: "Read the connection status of the Weixin account bound to this connector. Does not return login credentials.",
    inputSchema: EMPTY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "wechat_receive",
    description: "Read pending messages from the bound Weixin account without consuming them, optionally waiting up to 20 seconds. Messages remain pending until replied to. An empty result means no message arrived within this call. Does not schedule future calls or wake an agent.",
    inputSchema: {
      type: "object", properties: { waitSeconds: { type: "integer", minimum: 0, maximum: 20, default: 0 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "wechat_reply",
    description: "Send text to the sender of one received Weixin message. This is an external message send, subject to the host's authorization and approval controls. The recipient is determined by messageId, not by arbitrary user input.",
    inputSchema: {
      type: "object", properties: {
        messageId: { type: "string", minLength: 1, maxLength: 256 },
        text: { type: "string", minLength: 1, maxLength: 4000 },
      }, required: ["messageId", "text"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "wechat_disconnect",
    description: "Disconnect the bound Weixin account from this bridge and stop its message polling. Clears the bridge's saved account credentials and pending messages; does not claim to revoke the account session at Weixin.",
    inputSchema: EMPTY_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

type JsonObject = Record<string, unknown>;
type RpcId = string | number;
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function error(id: RpcId | null, code: number, message: string, status = 200): Response {
  return response({ jsonrpc: "2.0", id, error: { code, message } }, status);
}
function result(id: RpcId, value: unknown): Response {
  return response({ jsonrpc: "2.0", id, result: value });
}
function onlyKeys(value: JsonObject, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function accepts(header: string, media: string): boolean {
  return header.split(",").some((part) => {
    const [type, ...parameters] = part.trim().toLowerCase().split(";");
    return type?.trim() === media && !parameters.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));
  });
}
async function boundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) throw new RangeError("body_too_large");
  if (!request.body) throw new SyntaxError("empty_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("body_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export async function handleMcp(request: Request, backend: McpBackend): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return error(null, -32600, "Content-Type must be application/json", 415);
  }
  const accept = request.headers.get("accept") ?? "";
  if (!accepts(accept, "application/json") || !accepts(accept, "text/event-stream")) {
    return error(null, -32600, "Accept must include application/json and text/event-stream", 406);
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && headerVersion !== MODERN_VERSION && !VERSIONS.some((version) => version === headerVersion)) {
    return response({ jsonrpc: "2.0", error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN_VERSION, ...VERSIONS], requested: headerVersion } } }, 400);
  }
  let message: unknown;
  try { message = await boundedJson(request); }
  catch (cause) {
    if (cause instanceof RangeError) return error(null, -32600, "Request body exceeds 32768 bytes", 413);
    return error(null, -32700, "Invalid JSON body", 400);
  }
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
      (message.params !== undefined && !object(message.params))) {
    return error(null, -32600, "Invalid JSON-RPC request", 400);
  }
  if (!("id" in message)) {
    if (!message.method.startsWith("notifications/")) return error(null, -32600, "Request ID is required", 400);
    // This stateless server has no server-to-client requests or persistent sessions.
    // Cancellation notifications are advisory; bounded receive work expires naturally.
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  const id = message.id;
  if (!(typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)))) {
    return error(null, -32600, "Invalid request ID", 400);
  }
  const params = message.params ?? {};
  if (!object(params)) return error(id, -32602, "Invalid params");
  const meta = object(params._meta) ? params._meta : {};
  const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
  const modern = headerVersion === MODERN_VERSION || bodyVersion !== undefined || message.method === "server/discover";
  if (modern) {
    if (!headerVersion || headerVersion !== bodyVersion || request.headers.get("mcp-method") !== message.method) {
      return error(id, -32020, "Missing or mismatched MCP metadata headers", 400);
    }
    if (bodyVersion !== MODERN_VERSION) {
      return response({ jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN_VERSION, ...VERSIONS], requested: bodyVersion } } }, 400);
    }
    const info = meta["io.modelcontextprotocol/clientInfo"];
    if (!object(info) || typeof info.name !== "string" || typeof info.version !== "string" || !object(meta["io.modelcontextprotocol/clientCapabilities"])) {
      return error(id, -32602, "Missing per-request client metadata", 400);
    }
    if (message.method === "tools/call") {
      let mirrored = request.headers.get("mcp-name");
      if (mirrored?.startsWith("=?base64?") && mirrored.endsWith("?=")) {
        try { mirrored = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(mirrored.slice(9, -2)), (c) => c.charCodeAt(0))); }
        catch { return error(id, -32020, "Malformed Mcp-Name header", 400); }
      }
      if (!mirrored || mirrored !== params.name) return error(id, -32020, "Missing or mismatched Mcp-Name header", 400);
    }
  }
  const replyResult = (value: JsonObject) => result(id, modern ? { ...value, resultType: "complete" } : value);
  const eventsAvailable = backend.eventsEnabled === true && !!backend.subscribe && !!backend.unsubscribe;
  switch (message.method) {
    case "server/discover":
      return replyResult({ supportedVersions: [MODERN_VERSION, ...VERSIONS], capabilities: { tools: {}, ...(eventsAvailable ? { events: {} } : {}) },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "weixin-agent-bridge", version: "0.1.0" } } });
    case "events/list":
      if (!modern || !eventsAvailable) return error(id, -32601, "Events are not enabled", modern ? 404 : 200);
      if (params.cursor !== undefined) return error(id, -32602, "No event pagination cursor is supported");
      return replyResult({ events: [EVENT_DEFINITION] });
    case "events/subscribe":
    case "events/unsubscribe": {
      if (!modern || !eventsAvailable) return error(id, -32601, "Events are not enabled", modern ? 404 : 200);
      try {
        if (message.method === "events/subscribe" && backend.subscribe) {
          return replyResult({ ...await backend.subscribe(parseSubscribeParams(params)) });
        }
        const { _meta: ignoredMeta, ...identity } = params;
        if (backend.unsubscribe) return replyResult(await backend.unsubscribe(parseUnsubscribeParams(identity)));
        return error(id, -32601, "Events are not enabled", 404);
      } catch (cause) {
        if (cause instanceof EventProtocolError) return response({ jsonrpc: "2.0", id, error: { code: cause.code, message: cause.message, ...(cause.reason ? { data: { reason: cause.reason } } : {}) } });
        return error(id, -32603, "Event operation failed");
      }
    }
    case "initialize": {
      if (modern) return error(id, -32601, "Use server/discover for MCP 2026-07-28", 404);
      if (typeof params.protocolVersion !== "string" || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        return error(id, -32602, "initialize requires protocolVersion, capabilities and clientInfo");
      }
      return result(id, {
        protocolVersion: VERSIONS.find((version) => version === params.protocolVersion) ?? VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "weixin-muse-bridge", version: "0.1.0" },
      });
    }
    case "ping": return replyResult({});
    case "tools/list":
      if (params.cursor !== undefined) return error(id, -32602, "No pagination cursor is supported");
      return replyResult({ tools: TOOLS });
    case "tools/call": {
      const args = params.arguments ?? {};
      if (typeof params.name !== "string" || !object(args)) return error(id, -32602, "Invalid tool call");
      let operation: () => Promise<unknown>;
      switch (params.name) {
        case "wechat_status":
          if (!onlyKeys(args, [])) return error(id, -32602, "wechat_status takes no arguments");
          operation = () => backend.status(); break;
        case "wechat_receive": {
          const wait = args.waitSeconds ?? 0;
          if (!onlyKeys(args, ["waitSeconds"]) || typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > 20) {
            return error(id, -32602, "waitSeconds must be an integer from 0 to 20");
          }
          operation = () => backend.receive(wait); break;
        }
        case "wechat_reply": {
          const { messageId, text } = args;
          if (!onlyKeys(args, ["messageId", "text"]) || typeof messageId !== "string" ||
              messageId.trim().length === 0 || messageId.length > 256 || typeof text !== "string" ||
              text.trim().length === 0 || text.length > 4000) {
            return error(id, -32602, "Provide messageId (1–256 characters) and text (1–4000 characters)");
          }
          operation = () => backend.reply(messageId, text); break;
        }
        case "wechat_disconnect":
          if (!onlyKeys(args, [])) return error(id, -32602, "wechat_disconnect takes no arguments");
          operation = () => backend.disconnect(); break;
        default: return error(id, -32602, "Unknown tool");
      }
      try {
        const value = await operation();
        return replyResult({ content: [{ type: "text", text: JSON.stringify(value ?? null) }], isError: false });
      } catch {
        // Backend exceptions can contain upstream tokens or sensitive response bodies.
        return replyResult({ content: [{ type: "text", text: "Tool operation failed. Check bridge connection status. If a reply outcome is uncertain, do not blindly resend." }], isError: true });
      }
    }
    default: return error(id, -32601, "Method not found", modern ? 404 : 200);
  }
}
