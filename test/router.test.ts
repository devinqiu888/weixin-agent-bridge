import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const TOKEN='fixture-token-with-at-least-32-characters';
const ORIGIN='https://bridge.example.test';
const QR_CONTENT='https://weixin.qq.com/fixture?scan=abc&label=<script>never-html</script>';
// Bundle the actual production router with browser resolution, as Wrangler does.
// This specifically exercises qrcode's browser build inside workerd (no canvas).
const bundle=build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']}).then(result=>result.outputFiles[0]!.text);
async function harness(){
 let calls=0;
 const mf=new Miniflare(convertV4MiniflareOptions({
  modules:true,script:await bundle,compatibilityDate:'2026-10-30',
  bindings:{BRIDGE_TOKEN:TOKEN,APP_ORIGIN:ORIGIN,EVENTS_DISCOVERY_ENABLED:'true'},
  durableObjects:{ACCOUNTS:{className:'WeixinAccount',useSQLite:true}},
  outboundService:async request=>{
   calls++;
   const url=new URL(request.url);
   assert.equal(url.origin,'https://ilinkai.weixin.qq.com');
   assert.equal(url.pathname,'/ilink/bot/get_bot_qrcode');
   return Response.json({qrcode:'fixture-qr',qrcode_img_content:QR_CONTENT});
  },
 }));
 const call=(path:string,headers:Record<string,string>={Authorization:'Bearer '+TOKEN,Origin:ORIGIN})=>mf.dispatchFetch(ORIGIN+path,{method:'POST',headers,body:'{}'});
 return {mf,call,calls:()=>calls};
}
test('production router generates a local SVG QR in workerd without canvas or external renderer',{timeout:10000},async()=>{
 const {mf,call,calls}=await harness();
 try{
  const response=await call('/api/login/start');assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const data=await response.json() as {qrDataUrl:string;qrcode_img_content:string};
  assert.equal(data.qrcode_img_content,QR_CONTENT);
  assert.match(data.qrDataUrl,/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/);
  const svg=Buffer.from(data.qrDataUrl.split(',')[1]!,'base64').toString('utf8');
  assert.match(svg,/^<svg\b/);assert.match(svg,/<path\b/);assert.doesNotMatch(svg,/<script|<image|<foreignObject|fixture-qr|never-html/);
  assert.equal(calls(),1,'QR rendering must not perform extra network requests');
 }finally{await mf.dispose();}
});
test('production setup page accepts only generated SVG data images and has valid inline script',{timeout:10000},async()=>{
 const {mf,calls}=await harness();
 try{
  const response=await mf.dispatchFetch(ORIGIN+'/');assert.equal(response.status,200);
  const html=await response.text();
  assert.match(response.headers.get('content-security-policy')??'',/img-src data:/);
  assert.match(html,/const qrPrefix='data:image\/svg\+xml;base64,'/);
  assert.match(html,/qr\.src=data\.qrDataUrl/);assert.doesNotMatch(html,/innerHTML|https:\/\/.*\.js/);
  const inline=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline);new Script(inline);assert.equal(calls(),0);
 }finally{await mf.dispose();}
});
test('QR route rejects missing authentication and foreign origins before network I/O',{timeout:10000},async()=>{
 const {mf,call,calls}=await harness();
 try{
  assert.equal((await call('/api/login/start',{})).status,401);
  assert.equal((await call('/api/login/start',{Authorization:'Bearer '+TOKEN,Origin:'https://evil.example'})).status,403);
  assert.equal(calls(),0);
 }finally{await mf.dispose();}
});

test('callback onboarding records only hostname and time in authenticated admin status', {timeout:10000}, async()=>{
 const {mf,calls}=await harness();
 try{
  const status=()=>mf.dispatchFetch(ORIGIN+'/api/status',{headers:{Authorization:'Bearer '+TOKEN}});
  const initial=await (await status()).json() as Record<string,unknown>;assert.equal(initial.lastCallbackAttempt,null);assert.equal(initial.routerCodeRevision,'callback-diagnostics-v2');assert.equal(initial.accountCodeRevision,'message-diagnostics-v3');assert.equal(initial.diagnosticsAvailable,true);
  const signingSecret='whsec_'+Buffer.alloc(32,7).toString('base64');
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const r=await mf.dispatchFetch(ORIGIN+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream','Mcp-Protocol-Version':'2026-07-28','Mcp-Method':'events/subscribe'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{_meta:meta,name:'message.created',arguments:{},delivery:{mode:'webhook',url:'https://callback.example.com/private-path?token=private-query',secret:signingSecret}}})});
  const response=await r.text();assert.match(response,/destination_not_allowed/);
  const text=await (await status()).text();const data=JSON.parse(text);
  assert.equal(data.lastCallbackAttempt.hostname,'callback.example.com');assert.ok(Number.isFinite(Date.parse(data.lastCallbackAttempt.at)));
  for(const value of [text,response]){assert.ok(!value.includes('private-path'));assert.ok(!value.includes('private-query'));assert.ok(!value.includes(signingSecret));}
  assert.equal(calls(),0,'Rejected callback must never be fetched');
  assert.equal((await mf.dispatchFetch(ORIGIN+'/api/status')).status,401);
 }finally{await mf.dispose();}
});
