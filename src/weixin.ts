/**
 * iLink text-only adapter, derived from Tencent openclaw-weixin 2.4.10 protocol
 * and lossless identifier scanner (src/api/api.ts, auth/login-qr.ts, messaging/send.ts).
 * Copyright (C) 2026 Tencent. MIT. See THIRD_PARTY_NOTICES.md.
 * No OpenClaw runtime or Node built-ins required. Network tests use injected fetch.
 */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHANNEL_VERSION = '2.4.10';
const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: 'WeixinMuseBridge/0.1.0' };
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface WeixinMessage {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  session_id?: string;
  create_time_ms?: number;
  item_list?: Array<{ type: number; text_item?: { text?: string } }>;
}
export interface LoginQRCode { qrcode: string; qrcode_img_content: string }
export type LoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
export interface LoginResult {
  status: LoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}
export interface UpdatesResult { msgs: WeixinMessage[]; get_updates_buf: string; longpolling_timeout_ms?: number }
export interface SendTextInput { toUserId: string; text: string; contextToken: string; clientId: string }
export class WeixinError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    // Upstream response text may contain tokens, so never include it in exceptions.
    super(`Weixin request failed: ${code}`); this.name = 'WeixinError';
  }
}
export function validateWeixinBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new WeixinError('invalid_base_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'))) {
    throw new WeixinError('invalid_base_url');
  }
  return url.origin;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WeixinError('invalid_response');
  return value as Record<string, unknown>;
}
function stringField(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value)) throw new WeixinError('invalid_response');
  return value;
}
function requireText(value: string, name: string, limit: number): void {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > limit) throw new WeixinError(`invalid_${name}`);
}
/** Preserve uint64 message identifiers, including unquoted JSON numbers. */
export function parseWeixinJson(raw: string): unknown {
  let output = '', i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') { output += raw[i++]; continue; }
    const start = i++;
    let escaped = false;
    while (i < raw.length) {
      const char = raw[i++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const token = raw.slice(start, i); output += token;
    let cursor = i;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (raw[cursor] !== ':' || !['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token) as string)) continue;
    output += raw.slice(i, ++cursor);
    while (/\s/.test(raw[cursor] ?? '')) output += raw[cursor++];
    const numberStart = cursor;
    if (raw[cursor] === '-') cursor++;
    while (/\d/.test(raw[cursor] ?? '')) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && raw[numberStart] === '-')) {
      output += '"' + raw.slice(numberStart, cursor) + '"'; i = cursor;
    } else i = cursor;
  }
  return JSON.parse(output) as unknown;
}
async function limitedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new WeixinError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new WeixinError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return record(parseWeixinJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof WeixinError) throw error; throw new WeixinError('invalid_json'); }
}
export class WeixinClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  constructor(options: { baseUrl?: string; token?: string; fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.baseUrl = validateWeixinBaseUrl(options.baseUrl ?? DEFAULT_WEIXIN_BASE_URL);
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 35_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new WeixinError('invalid_timeout');
  }
  private async request(endpoint: string, body?: unknown, authenticated = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (authenticated && !this.token?.trim()) throw new WeixinError('not_connected');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': btoa(String(random)), 'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
    };
    if (authenticated) headers.Authorization = `Bearer ${this.token!.trim()}`;
    try {
      const response = await this.fetcher(`${this.baseUrl}/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'manual',
      });
      if (!response.ok) { await response.body?.cancel(); throw new WeixinError('http_error', response.status); }
      const data = await limitedJson(response);
      for (const key of ['ret', 'errcode']) {
        if (data[key] !== undefined && typeof data[key] !== 'number') throw new WeixinError('invalid_response');
        if (typeof data[key] === 'number' && data[key] !== 0) throw new WeixinError(`api_${data[key]}`);
      }
      return data;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      throw new WeixinError(controller.signal.aborted ? (signal?.aborted ? 'aborted' : 'timeout') : 'network_error');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async createLogin(): Promise<LoginQRCode> {
    const data = await this.request('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] });
    return { qrcode: stringField(data.qrcode, true)!, qrcode_img_content: stringField(data.qrcode_img_content, true)! };
  }
  async pollLogin(qrcode: string): Promise<LoginResult> {
    requireText(qrcode, 'qrcode', 8192);
    const data = await this.request(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
    const statuses: LoginStatus[] = ['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'];
    if (!statuses.includes(data.status as LoginStatus)) throw new WeixinError('invalid_login_status');
    const result: LoginResult = { status: data.status as LoginStatus };
    for (const key of ['bot_token', 'ilink_bot_id', 'ilink_user_id', 'baseurl', 'redirect_host'] as const) {
      const value = stringField(data[key]); if (value !== undefined) result[key] = value;
    }
    if (result.baseurl) result.baseurl = validateWeixinBaseUrl(result.baseurl);
    if (result.redirect_host) validateWeixinBaseUrl(`https://${result.redirect_host}`);
    if (result.status === 'confirmed' && (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id)) throw new WeixinError('incomplete_login');
    return result;
  }
  async getUpdates(cursor: string, signal?: AbortSignal): Promise<UpdatesResult> {
    if (typeof cursor !== 'string' || cursor.length > 65536) throw new WeixinError('invalid_cursor');
    const data = await this.request('ilink/bot/getupdates', { get_updates_buf: cursor, base_info: BASE_INFO }, true, signal);
    if (data.msgs !== undefined && !Array.isArray(data.msgs)) throw new WeixinError('invalid_response');
    const msgs: WeixinMessage[] = (data.msgs as unknown[] | undefined ?? []).map((raw) => {
      const msg = record(raw); const result: WeixinMessage = {};
      for (const key of ['message_id', 'from_user_id', 'to_user_id', 'context_token', 'session_id'] as const) {
        const value = stringField(msg[key]); if (value !== undefined) result[key] = value;
      }
      for (const key of ['message_type', 'message_state', 'create_time_ms'] as const) {
        if (msg[key] !== undefined) {
          if (typeof msg[key] !== 'number' || !Number.isFinite(msg[key])) throw new WeixinError('invalid_response');
          result[key] = msg[key];
        }
      }
      if (msg.item_list !== undefined) {
        if (!Array.isArray(msg.item_list)) throw new WeixinError('invalid_response');
        result.item_list = msg.item_list.map((rawItem: unknown) => {
          const item = record(rawItem);
          if (typeof item.type !== 'number') throw new WeixinError('invalid_response');
          const text = item.text_item === undefined ? undefined : stringField(record(item.text_item).text);
          return { type: item.type, ...(text === undefined ? {} : { text_item: { text } }) };
        });
      }
      return result;
    });
    const timeout = data.longpolling_timeout_ms;
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) throw new WeixinError('invalid_response');
    return { msgs, get_updates_buf: stringField(data.get_updates_buf) ?? cursor,
      ...(typeof timeout === 'number' ? { longpolling_timeout_ms: Math.min(timeout, 60_000) } : {}) };
  }
  async sendText(input: SendTextInput): Promise<{ message_id?: string }> {
    requireText(input.toUserId, 'recipient', 1024); requireText(input.text, 'text', 16000);
    requireText(input.contextToken, 'context', 8192); requireText(input.clientId, 'client_id', 256);
    const data = await this.request('ilink/bot/sendmessage', { base_info: BASE_INFO, msg: {
      from_user_id: '', to_user_id: input.toUserId, client_id: input.clientId,
      message_type: 2, message_state: 2, context_token: input.contextToken,
      item_list: [{ type: 1, text_item: { text: input.text } }],
    } }, true);
    const id = stringField(data.message_id); return id === undefined ? {} : { message_id: id };
  }
}
