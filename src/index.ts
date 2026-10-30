import {handleMcp} from './mcp';
import {WeixinAccount} from './account';
import {setupPage} from './setup';
import {handleOAuth,ownerAuthenticated,oauthChallenge,oauthIssuer} from './oauth';
import {sha256,type OAuthGrant} from './oauth-crypto';
import {validateCallbackUrl} from './events';
export {OAuthState} from './oauth-state';
import QRCode from 'qrcode';
export {WeixinAccount};
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname==='/' && request.method==='GET')return setupPage();
 const oauth=await handleOAuth(request,env);if(oauth)return oauth;
 const origin=request.headers.get('Origin');
 if(origin && origin!==env.APP_ORIGIN)return new Response('Forbidden origin',{status:403});
 const owner=await ownerAuthenticated(request,env.BRIDGE_TOKEN ?? '');
 let grant:OAuthGrant|undefined;
 if(!owner && url.pathname==='/mcp' && env.OAUTH && (env.BRIDGE_TOKEN?.length??0)>=32){
  const bearer=/^Bearer (wa_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')??'')?.[1];
  if(bearer){const checked=await env.OAUTH.getByName('single-owner').validate(bearer,oauthIssuer(env)+'/mcp',await sha256(env.BRIDGE_TOKEN));if(checked.ok)grant=checked.value;}
 }
 if(!owner&&!grant)return url.pathname==='/mcp'?oauthChallenge(env):new Response('Unauthorized',{status:401,headers:{'WWW-Authenticate':'Bearer','Cache-Control':'no-store'}});
 const account=env.ACCOUNTS.getByName('self-hosted-owner');
 try {
  if(url.pathname==='/mcp')return handleMcp(request,{
   status:()=>account.status(),receive:(seconds)=>account.receive(seconds),reply:(id,text)=>account.reply(id,text),disconnect:()=>account.disconnect(),
   eventsEnabled:env.EVENTS_DISCOVERY_ENABLED==='true'||!!env.CALLBACK_HOSTS?.trim(),subscribe:async(p)=>{
    const hostname=new URL(p.delivery.url).hostname;
    // Structured, host-only onboarding signal remains available during DO rollout.
    console.info({event:'callback_candidate',hostname});
    try{await account.recordCallbackAttempt(hostname);}catch{/* Older DO revisions may not expose the diagnostic RPC yet. */}
    validateCallbackUrl(p.delivery.url,{allowedHosts:(env.CALLBACK_HOSTS??'').split(',').map(x=>x.trim()).filter(Boolean)});
    return account.subscribe(p,grant?.id);
   },unsubscribe:(p)=>account.unsubscribe(p)
  });
  if(url.pathname==='/api/status' && request.method==='GET'){
   const [status,diagnostics]=await Promise.allSettled([account.status(),account.getCallbackDiagnostics()]);
   if(status.status==='rejected')throw new Error('Status unavailable');
   return Response.json({...status.value,routerCodeRevision:'callback-diagnostics-v2',diagnosticsAvailable:diagnostics.status==='fulfilled',...(diagnostics.status==='fulfilled'?diagnostics.value:{accountCodeRevision:null,lastCallbackAttempt:null})},{headers:{'Cache-Control':'no-store'}});
  }
  if(request.method!=='POST')return new Response('Method not allowed',{status:405});
  if(url.pathname==='/api/login/start') {
   const r=await account.startLogin();
   // qrcode's browser build uses canvas for PNG; Workers has no DOM/canvas.
   // SVG rendering is pure JavaScript and emits only generated paths, not input HTML.
   const svg=await QRCode.toString(r.qrcode_img_content,{type:'svg',errorCorrectionLevel:'M',margin:4});
   const qrDataUrl='data:image/svg+xml;base64,'+btoa(svg);
   return Response.json({qrDataUrl,qrcode_img_content:r.qrcode_img_content},{headers:{'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/api/login/status')return Response.json(await account.pollLogin(),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/oauth/revoke')return Response.json(await env.OAUTH.getByName('single-owner').revokeAll(),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/disconnect')return Response.json(await account.disconnect());
  return new Response('Not found',{status:404});
 }catch{return Response.json({error:'Operation failed; inspect connection status. No automatic send retry.'},{status:502,headers:{'Cache-Control':'no-store'}});}
}} satisfies ExportedHandler<Env>;
