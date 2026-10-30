import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinClient, WeixinError, parseWeixinJson, validateWeixinBaseUrl, type FetchLike } from '../src/weixin.js';
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('rejects untrusted, credential-bearing and path-bearing upstreams', () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://evil.com', 'https://ilinkai.weixin.qq.com.evil.com', 'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/other', 'https://ilinkai.weixin.qq.com:8443']) {
    assert.throws(() => validateWeixinBaseUrl(value), WeixinError);
  }
  assert.equal(validateWeixinBaseUrl('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
});
test('login is unauthenticated and carries Tencent bot protocol fields', async () => {
  const fetch: FetchLike = async (url, init) => {
    assert.equal(String(url), 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.equal(new Headers(init?.headers).get('ilink-app-id'), 'bot');
    assert.deepEqual(JSON.parse(String(init?.body)), { local_token_list: [] });
    assert.equal(init?.redirect, 'manual');
    return reply({ qrcode: 'qr', qrcode_img_content: 'https://example.test/scan' });
  };
  assert.deepEqual(await new WeixinClient({ fetch, token: 'never-send-login' }).createLogin(), { qrcode: 'qr', qrcode_img_content: 'https://example.test/scan' });
});
test('rejects login credential redirect to arbitrary host', async () => {
  const fetch: FetchLike = async () => reply({ status: 'confirmed', bot_token: 'SECRET', ilink_bot_id: 'bot', ilink_user_id: 'user', baseurl: 'https://evil.com' });
  await assert.rejects(new WeixinClient({ fetch }).pollLogin('q'), { code: 'invalid_base_url' });
});
test('unsupported verification state is explicit, not mistaken for successful login', async () => {
  const fetch: FetchLike = async () => reply({ status: 'need_verifycode' });
  assert.equal((await new WeixinClient({ fetch }).pollLogin('q')).status, 'need_verifycode');
});
test('preserves unquoted uint64 IDs without altering strings', () => {
  assert.deepEqual(parseWeixinJson('{"message_id":18446744073709551615,"text":"message_id:123","nested":{"msg_id":42}}'), {
    message_id: '18446744073709551615', text: 'message_id:123', nested: { msg_id: '42' },
  });
});
test('getUpdates sends cursor and auth; accepts empty successful response without dropping cursor', async () => {
  const fetch: FetchLike = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer SECRET');
    assert.equal(headers.get('AuthorizationType'), 'ilink_bot_token');
    assert.match(atob(headers.get('X-WECHAT-UIN')!), /^\d+$/);
    assert.equal(JSON.parse(String(init?.body)).get_updates_buf, 'cursor');
    return reply({ ret: 0 });
  };
  assert.deepEqual(await new WeixinClient({ fetch, token: 'SECRET' }).getUpdates('cursor'), { msgs: [], get_updates_buf: 'cursor' });
});
test('getUpdates parses text and preserves large message ID', async () => {
  const fetch: FetchLike = async () => new Response('{"msgs":[{"message_id":18446744073709551615,"from_user_id":"u","item_list":[{"type":1,"text_item":{"text":"hello"}}]}],"get_updates_buf":"next"}');
  const result = await new WeixinClient({ fetch, token: 'SECRET' }).getUpdates('');
  assert.equal(result.msgs[0]?.message_id, '18446744073709551615');
  assert.equal(result.msgs[0]?.item_list?.[0]?.text_item?.text, 'hello');
  assert.equal(result.get_updates_buf, 'next');
});
test('sendText binds reply to recipient/context and stable client ID', async () => {
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.msg, { from_user_id: '', to_user_id: 'owner', client_id: 'stable', message_type: 2, message_state: 2, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hello' } }] });
    return reply({ ret: 0, message_id: '123' });
  };
  assert.deepEqual(await new WeixinClient({ fetch, token: 'SECRET' }).sendText({ toUserId: 'owner', text: 'hello', contextToken: 'ctx', clientId: 'stable' }), { message_id: '123' });
});
test('API failures and malformed responses fail closed without leaking body', async () => {
  for (const body of [{ ret: -14, errmsg: 'SECRET' }, { msgs: 'bad' }, { msgs: [{ item_list: [{ type: '1' }] }] }]) {
    await assert.rejects(new WeixinClient({ token: 'SECRET', fetch: async () => reply(body) }).getUpdates(''), (error: unknown) => error instanceof WeixinError && !error.message.includes('SECRET'));
  }
});
test('response streaming enforces size limit', async () => {
  await assert.rejects(new WeixinClient({ token: 's', fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) }).getUpdates(''), { code: 'response_too_large' });
});
test('timeout aborts outstanding fetch and is not silently reported as success', async () => {
  const fetch: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(new WeixinClient({ token: 's', fetch, timeoutMs: 5 }).getUpdates(''), { code: 'timeout' });
});
test('invalid credentials cause no network request', async () => {
  let called = false;
  const fetch: FetchLike = async () => { called = true; return reply({}); };
  await assert.rejects(new WeixinClient({ fetch }).getUpdates(''), { code: 'not_connected' });
  assert.equal(called, false);
});
