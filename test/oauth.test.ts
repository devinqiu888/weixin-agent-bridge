import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {sha256} from '../src/oauth-crypto';
const ORIGIN='https://bridge.example.test',OWNER='owner-fixture-secret-with-at-least-32-characters',REDIRECT='https://chatgpt.com/connector/oauth/fixture';
const bundle=build({entryPoints:['test/fixtures/oauth-worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']}).then(r=>r.outputFiles[0]!.text);
async function harness(){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await bundle,compatibilityDate:'2026-10-30',bindings:{APP_ORIGIN:ORIGIN,BRIDGE_TOKEN:OWNER,OAUTH_REDIRECT_URIS:REDIRECT,EVENTS_DISCOVERY_ENABLED:'true'},durableObjects:{ACCOUNTS:{className:'WeixinAccount',useSQLite:true},OAUTH:{className:'TestOAuth',useSQLite:true}},outboundService:async()=>{throw new Error('OAuth must not fetch external URLs');}}));
 const get=(path:string)=>mf.dispatchFetch(ORIGIN+path,{redirect:'manual'});
 const post=(path:string,data:Record<string,string>,headers:Record<string,string>={})=>mf.dispatchFetch(ORIGIN+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(data).toString()});
 const register=async(redirect=REDIRECT)=>{const r=await mf.dispatchFetch(ORIGIN+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],client_name:'ChatGPT',token_endpoint_auth_method:'none'})});return {response:r,data:await r.json() as Record<string,unknown>};};
 const begin=async(client:string,overrides:Record<string,string>={})=>{
  const verifier='x'.repeat(43),p=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:REDIRECT,resource:ORIGIN+'/mcp',scope:'weixin:bridge',code_challenge:await sha256(verifier),code_challenge_method:'S256',state:'fixture-state',...overrides});
  const r=await get('/oauth/authorize?'+p);const html=await r.text();
  return {response:r,html,id:html.match(/name="request_id" value="([^"]+)"/)?.[1]??'',cookie:r.headers.get('set-cookie')?.split(';')[0]??'',verifier};
 };
 const consent=(b:Awaited<ReturnType<typeof begin>>,overrides:Record<string,string>={},headers:Record<string,string>={})=>post('/oauth/authorize',{request_id:b.id,decision:'allow',owner_token:OWNER,...overrides},{Origin:ORIGIN,Cookie:b.cookie,...headers});
 const exchange=(client:string,code:string,verifier:string,overrides:Record<string,string>={})=>post('/oauth/token',{grant_type:'authorization_code',client_id:client,code,code_verifier:verifier,redirect_uri:REDIRECT,resource:ORIGIN+'/mcp',...overrides});
 const authorize=async(client:string)=>{const b=await begin(client),r=await consent(b);assert.equal(r.status,303);const location=new URL(r.headers.get('location')!);assert.equal(location.searchParams.get('iss'),ORIGIN);assert.equal(location.searchParams.get('state'),'fixture-state');return {b,code:location.searchParams.get('code')!};};
 const mint=async(client:string)=>{const {b,code}=await authorize(client);const r=await exchange(client,code,b.verifier);assert.equal(r.status,200);return await r.json() as {access_token:string;refresh_token:string};};
 const mcp=(token:string)=>mf.dispatchFetch(ORIGIN+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 return {mf,get,post,register,begin,consent,exchange,authorize,mint,mcp};
}
test('OAuth metadata, exact redirect DCR, S256 consent and management bearer separation',{timeout:20000},async()=>{
 const h=await harness();try{
  const metadata=await (await h.get('/.well-known/oauth-authorization-server')).json() as Record<string,unknown>;
  assert.equal(metadata.issuer,ORIGIN);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  const protectedMetadata=await (await h.get('/.well-known/oauth-protected-resource/mcp')).json() as Record<string,unknown>;assert.equal(protectedMetadata.resource,ORIGIN+'/mcp');
  assert.match((await h.mcp('bad')).headers.get('www-authenticate')??'',/resource_metadata=/);
  assert.equal((await h.register('https://evil.test/steal')).response.status,400);
  const client=String((await h.register()).data.client_id);assert.equal(String((await h.register()).data.client_id),client);
  assert.equal((await h.begin(client,{code_challenge_method:'plain'})).response.status,400);
  const b=await h.begin(client);assert.equal(b.response.status,200);assert.equal(b.response.headers.get('referrer-policy'),'same-origin');assert.match(b.response.headers.get('set-cookie')??'',/HttpOnly; SameSite=Lax.*Secure/);assert.doesNotMatch(b.html,new RegExp(OWNER));
  assert.equal((await h.consent(b,{owner_token:'incorrect'})).status,403);
  assert.equal((await h.consent(b,{}, {Origin:'https://evil.test'})).status,403);
  assert.equal((await h.consent(b,{}, {Cookie:''})).status,403);
  const r=await h.consent(b);assert.equal(r.status,303);const code=new URL(r.headers.get('location')!).searchParams.get('code')!;
  assert.equal((await h.consent(b)).status,400);
  assert.equal((await h.exchange(client,code,'wrong'.repeat(10))).status,400);
  assert.equal((await h.exchange(client,code,b.verifier,{resource:ORIGIN+'/wrong'})).status,400);
  const tokens=await (await h.exchange(client,code,b.verifier)).json() as {access_token:string;refresh_token:string};
  assert.equal((await h.mcp(tokens.access_token)).status,200);
  assert.equal((await h.mf.dispatchFetch(ORIGIN+'/api/status',{headers:{Authorization:'Bearer '+tokens.access_token}})).status,401);
  assert.equal((await h.mcp(tokens.refresh_token)).status,401);
  const records=await (await h.get('/test/inspect')).text();assert.ok(!records.includes(tokens.access_token));assert.ok(!records.includes(tokens.refresh_token));assert.ok(!records.includes(OWNER));
  assert.equal((await h.exchange(client,code,b.verifier)).status,400,'authorization code is single-use');
  assert.equal((await h.mcp(tokens.access_token)).status,401,'code replay revokes the grant');
 }finally{await h.mf.dispose();}
});
test('Refresh rotation, replay-family revocation, single active grant and owner revoke',{timeout:20000},async()=>{
 const h=await harness();try{
  const client=String((await h.register()).data.client_id),old=await h.mint(client),current=await h.mint(client);
  assert.equal((await h.mcp(old.access_token)).status,401);assert.equal((await h.mcp(current.access_token)).status,200);
  const refresh=()=>h.post('/oauth/token',{grant_type:'refresh_token',client_id:client,resource:ORIGIN+'/mcp',refresh_token:current.refresh_token});
  const renewed=await (await refresh()).json() as {access_token:string};assert.equal((await h.mcp(renewed.access_token)).status,200);
  assert.equal((await refresh()).status,400);assert.equal((await h.mcp(renewed.access_token)).status,401);
  const next=await h.mint(client);assert.equal((await h.post('/oauth/revoke',{token:next.refresh_token,client_id:client})).status,200);assert.equal((await h.mcp(next.access_token)).status,401);
  const last=await h.mint(client);assert.equal((await h.post('/api/oauth/revoke',{}, {Authorization:'Bearer '+last.access_token})).status,401);
  assert.equal((await h.post('/api/oauth/revoke',{}, {Authorization:'Bearer '+OWNER})).status,200);assert.equal((await h.mcp(last.access_token)).status,401);
 }finally{await h.mf.dispose();}
});
test('Expired code/access/grant fail closed and denial redirects with issuer without token',{timeout:20000},async()=>{
 const h=await harness();try{
  const client=String((await h.register()).data.client_id),b=await h.begin(client);
  const denied=await h.consent(b,{decision:'deny',owner_token:''});assert.equal(denied.status,303);
  const location=new URL(denied.headers.get('location')!);assert.equal(location.searchParams.get('error'),'access_denied');assert.equal(location.searchParams.get('iss'),ORIGIN);assert.equal(location.searchParams.has('code'),false);
  const auth=await h.authorize(client);await h.get('/test/expire/code');assert.equal((await h.exchange(client,auth.code,auth.b.verifier)).status,400);
  const tokens=await h.mint(client);await h.get('/test/expire/access');assert.equal((await h.mcp(tokens.access_token)).status,401);
  const next=await h.mint(client);await h.get('/test/expire/grant');assert.equal((await h.mcp(next.access_token)).status,401);assert.equal((await h.post('/oauth/token',{grant_type:'refresh_token',client_id:client,resource:ORIGIN+'/mcp',refresh_token:next.refresh_token})).status,400);
  assert.equal((await h.post('/oauth/token',{grant_type:'client_credentials',client_id:client,resource:ORIGIN+'/mcp'})).status,400);
 }finally{await h.mf.dispose();}
});
