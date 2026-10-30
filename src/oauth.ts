import {equalSecret,randomToken,sha256,OAUTH_SCOPE} from './oauth-crypto';
import type {OAuthResult} from './oauth-state';
export {OAuthState} from './oauth-state';
const DEFAULT_REDIRECT='https://chatgpt.com/connector_platform_oauth_redirect';
const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
const error=(name:string,status=400)=>json({error:name},status);
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function oauthIssuer(env:Env):string {
 const url=new URL(env.APP_ORIGIN);
 if(url.pathname!=='/'||url.search||url.hash||url.username||url.password|| (url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('APP_ORIGIN must be an HTTPS origin');
 return url.origin;
}
export function oauthChallenge(env:Env):Response {
 const issuer=oauthIssuer(env);
 return new Response('Unauthorized',{status:401,headers:{...headers,'WWW-Authenticate':`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`}});
}
export async function ownerAuthenticated(request:Request,secret:string):Promise<boolean> {
 return secret.length>=32 && equalSecret(request.headers.get('Authorization')??'','Bearer '+secret);
}
function allowedRedirects(env:Env):string[]{
 const entries=(env.OAUTH_REDIRECT_URIS??DEFAULT_REDIRECT).split(',').map(x=>x.trim()).filter(Boolean);
 return entries.filter(value=>{try{const u=new URL(value);return u.origin==='https://chatgpt.com'&&!u.search&&!u.hash&&(u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));}catch{return false;}});
}
async function body(request:Request):Promise<string>{
 if(Number(request.headers.get('Content-Length')??0)>16384)throw new Error('Body limit');
 const reader=request.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new Error('Body limit');}chunks.push(value);}
 const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return new TextDecoder('utf-8',{fatal:true}).decode(out);
}
function params(text:string):URLSearchParams {
 const result=new URLSearchParams(text);for(const key of result.keys())if(result.getAll(key).length!==1)throw new Error('Duplicate parameter');return result;
}
function result<T>(value:OAuthResult<T>,status=200):Response{return value.ok?json(value.value,status):error(value.error,value.status);}
function consentPage(id:string,clientName:string,resource:string,secure:boolean,csrf:string):Response {
 const cookie=`${secure?'__Host-':''}bridge-oauth=${csrf}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure?'; Secure':''}`;
 return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>授权微信桥接</title><body><main><h1>授权 ChatGPT 连接微信桥接</h1><p>应用名称（由客户端提供）：${escape(clientName)}</p><p>服务：${escape(resource)}</p><p>允许此连接读取收到的微信文字、发送回复、订阅新消息事件，以及断开微信绑定。只允许一个有效连接；授权后将撤销之前的连接及其事件订阅。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escape(id)}"><label>管理员 BRIDGE_TOKEN <input type="password" name="owner_token" required autocomplete="off" minlength="32" maxlength="512"></label><p>令牌只提交给此服务，用于确认管理员同意，不会发送给 ChatGPT。</p><button name="decision" value="allow" type="submit">确认授权</button><button name="decision" value="deny" type="submit" formnovalidate>拒绝</button></form></main></body></html>`,{headers:{...headers,'Referrer-Policy':'same-origin','Content-Type':'text/html; charset=utf-8','Set-Cookie':cookie,'Content-Security-Policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff'}});
}
/** Public OAuth endpoints run before the router's management-API bearer check. */
export async function handleOAuth(request:Request,env:Env):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname;
 if(!path.startsWith('/oauth/')&&!path.startsWith('/.well-known/'))return null;
 try{
  const issuer=oauthIssuer(env),resource=issuer+'/mcp';
  if(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp'){
   if(request.method!=='GET')return error('invalid_request',405);
   return json({resource,authorization_servers:[issuer],scopes_supported:[OAUTH_SCOPE],bearer_methods_supported:['header']});
  }
  if(path==='/.well-known/oauth-authorization-server'){
   if(request.method!=='GET')return error('invalid_request',405);
   return json({issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',registration_endpoint:issuer+'/oauth/register',revocation_endpoint:issuer+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:[OAUTH_SCOPE],authorization_response_iss_parameter_supported:true});
  }
  if((env.BRIDGE_TOKEN?.length??0)<32||!env.OAUTH)return error('temporarily_unavailable',503);
  const store=env.OAUTH.getByName('single-owner');
  if(path==='/oauth/register'&&request.method==='POST'){
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))return error('invalid_client_metadata');
   const data:unknown=JSON.parse(await body(request));
   if(!data||typeof data!=='object'||Array.isArray(data))return error('invalid_client_metadata');
   const input=data as Record<string,unknown>,redirects=input.redirect_uris,allow=allowedRedirects(env);
   if(!Array.isArray(redirects)||redirects.length<1||redirects.length>4||redirects.some(u=>typeof u!=='string'||!allow.includes(u))||new Set(redirects).size!==redirects.length)return error('invalid_redirect_uri');
   if(input.token_endpoint_auth_method!==undefined&&input.token_endpoint_auth_method!=='none')return error('invalid_client_metadata');
   if(input.grant_types!==undefined&&(!Array.isArray(input.grant_types)||!input.grant_types.includes('authorization_code')||input.grant_types.some(x=>x!=='authorization_code'&&x!=='refresh_token')))return error('invalid_client_metadata');
   if(input.response_types!==undefined&&(!Array.isArray(input.response_types)||input.response_types.length!==1||input.response_types[0]!=='code'))return error('invalid_client_metadata');
   if(input.client_name!==undefined&&(typeof input.client_name!=='string'||input.client_name.length>80))return error('invalid_client_metadata');
   return result(await store.register(redirects as string[],typeof input.client_name==='string'?input.client_name:'ChatGPT'),201);
  }
  if(path==='/oauth/authorize'&&request.method==='GET'){
   const p=params(url.search.slice(1));
   const clientId=p.get('client_id')??'',redirectUri=p.get('redirect_uri')??'',challenge=p.get('code_challenge')??'',state=p.get('state')??'',scope=p.get('scope')??OAUTH_SCOPE;
   if(p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!/^[-_A-Za-z0-9]{43}$/.test(challenge)||state.length>1024||scope!==OAUTH_SCOPE||p.get('resource')!==resource||!allowedRedirects(env).includes(redirectUri))return error('invalid_request');
   const csrf=randomToken(),started=await store.begin({clientId,redirectUri,challenge,state,resource,scope},await sha256(csrf));
   if(!started.ok)return result(started);
   return consentPage(started.value.id,started.value.client.client_name,resource,url.protocol==='https:',csrf);
  }
  if(request.method!=='POST')return error('invalid_request',405);
  if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))return error('invalid_request');
  const p=params(await body(request));
  if(path==='/oauth/authorize'){
   if(request.headers.get('Origin')!==issuer)return error('invalid_request',403);
   const cookieName=url.protocol==='https:'?'__Host-bridge-oauth':'bridge-oauth';
   const cookies=(request.headers.get('Cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
   if(cookies.length!==1)return error('invalid_request',403);
   const csrf=cookies[0]!.slice(cookieName.length+1);
   if(!/^[-_A-Za-z0-9]{43}$/.test(csrf)||!['allow','deny'].includes(p.get('decision')??''))return error('invalid_request',403);
   const approved=p.get('decision')==='allow';
   if(approved&&!await equalSecret(p.get('owner_token')??'',env.BRIDGE_TOKEN))return error('access_denied',403);
   const completed=await store.complete(p.get('request_id')??'',await sha256(csrf),await sha256(env.BRIDGE_TOKEN),approved);
   if(!completed.ok)return result(completed);
   const redirect=new URL(completed.value.redirectUri);
   redirect.searchParams.set('iss',issuer);if(completed.value.state)redirect.searchParams.set('state',completed.value.state);
   redirect.searchParams.set(completed.value.code?'code':'error',completed.value.code??'access_denied');
   return new Response(null,{status:303,headers:{...headers,Location:redirect.toString(),'Set-Cookie':`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol==='https:'?'; Secure':''}`}});
  }
  if(path==='/oauth/token'){
   if(request.headers.has('Authorization')||p.has('client_secret'))return error('invalid_client');
   if(p.get('resource')!==resource)return error('invalid_target');
   return result(await store.exchange({grantType:p.get('grant_type')??'',clientId:p.get('client_id')??'',resource,redirectUri:p.get('redirect_uri')??'',code:p.get('code')??'',verifier:p.get('code_verifier')??'',refresh:p.get('refresh_token')??'',ownerHash:await sha256(env.BRIDGE_TOKEN)}));
  }
  if(path==='/oauth/revoke')return result(await store.revoke(p.get('token')??'',p.get('client_id')??''));
  return error('invalid_request',404);
 }catch{return error('invalid_request');}
}
