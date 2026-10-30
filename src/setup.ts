/** Self-hosted, single-account setup page. Secrets stay in the current page's memory. */
export function setupPage(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信 MCP 连接器 · 绑定管理</title>
<style nonce="${nonce}">
[hidden]{display:none!important}
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}body{max-width:760px;margin:48px auto;padding:0 24px;line-height:1.65}h1{font-size:28px;margin-bottom:8px}p{margin:12px 0}.muted{opacity:.72}.badge{display:inline-block;border:1px solid #8886;border-radius:20px;padding:2px 12px;font-size:13px}section{border:1px solid #8885;border-radius:14px;padding:22px;margin-top:24px}label{display:block;font-weight:600;margin-bottom:8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #8888;border-radius:8px;font:inherit}button{font:inherit;padding:9px 15px;margin:14px 8px 0 0;border:1px solid #8888;border-radius:8px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}img{display:block;max-width:280px;width:100%;height:auto;margin:20px auto;background:white;border-radius:8px}code{overflow-wrap:anywhere}#notice{min-height:28px}footer{margin:28px 0;font-size:13px;opacity:.72}
</style></head><body>
<span class="badge">Experimental · 单账号自行部署</span>
<h1>微信 MCP 连接器</h1>
<p>绑定微信 ClawBot，为 OpenAI 插件提供消息读取与回复工具。当前为实验原型；是否能自动触发任务，取决于客户端能力、权限和实际验证。</p>
<p class="muted">此页不会将 BRIDGE_TOKEN 写入本地存储或 Cookie。令牌仅用于本页向你的 Worker 发起请求，关闭或刷新页面后需要重新输入。请只在你信任的部署地址操作。</p>
<section><label for="token">管理令牌 BRIDGE_TOKEN</label><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="输入部署时设置的令牌">
<div><button id="connect" type="button">生成绑定二维码</button><button id="poll" type="button">检查扫码结果</button><button id="status" type="button">刷新连接状态</button><button id="disconnect" type="button">断开微信绑定</button></div>
<p id="notice" role="status" aria-live="polite"></p><img id="qr" hidden alt="使用微信扫描此二维码绑定 ClawBot"><pre id="result" aria-live="polite"></pre></section>
<section><strong>绑定后</strong><p>将本部署的 MCP 地址添加至支持的客户端，并按实际需要授权读取、回复工具。扫码绑定不会自动创建客户端后台任务，也不代表 OpenAI 插件已审核或端到端聊天已验证。</p><p>MCP 地址：<code id="endpoint"></code></p></section>
<footer>二维码由本部署生成，无第三方二维码服务或外部脚本。请不要将令牌、微信凭据或包含敏感内容的调试记录提交到 GitHub。</footer>
<script nonce="${nonce}">
'use strict';
const tokenInput=document.getElementById('token');
const notice=document.getElementById('notice');
const result=document.getElementById('result');
const qr=document.getElementById('qr');
const buttons=Array.from(document.querySelectorAll('button'));
document.getElementById('endpoint').textContent=location.origin+'/mcp';
function hideQr(){qr.hidden=true;qr.removeAttribute('src');}
function safeStatus(data){
  // Display only explicit non-secret status fields; never render whole API responses.
  const safe={};
  for(const key of ['status','connected','listening','pending','pendingCount','message','error']){
    const value=data[key];
    if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')safe[key]=value;
  }
  result.textContent=Object.keys(safe).length?JSON.stringify(safe,null,2):'请求已完成。';
}
async function request(path,method){
  const token=tokenInput.value.trim();
  if(!token){notice.textContent='请先输入管理令牌。';return null;}
  buttons.forEach(button=>button.disabled=true);
  notice.textContent='请求处理中…';result.textContent='';
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const response=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{}),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
    if(!response.ok){
      notice.textContent=response.status===401?'令牌无效或未配置。':response.status===403?'请求被拒绝，请检查部署的访问设置。':'请求未成功（HTTP '+response.status+'）。如操作结果不确定，请先刷新状态。';
      return null;
    }
    const data=await response.json();
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('invalid_response');
    notice.textContent='请求已完成。';safeStatus(data);return data;
  }catch(error){
    notice.textContent=error&&error.name==='AbortError'?'等待超时；这不代表操作失败，请刷新状态后再决定是否重试。':'连接失败或响应格式异常，请检查 Worker 状态。';return null;
  }finally{clearTimeout(timer);buttons.forEach(button=>button.disabled=false);}
}
document.getElementById('connect').addEventListener('click',async()=>{
  hideQr();const data=await request('/api/login/start','POST');if(!data)return;
  const qrPrefix='data:image/svg+xml;base64,';
  if(typeof data.qrDataUrl==='string'&&data.qrDataUrl.length<=1000000&&data.qrDataUrl.startsWith(qrPrefix)&&/^[A-Za-z0-9+/]+={0,2}$/.test(data.qrDataUrl.slice(qrPrefix.length))){
    qr.src=data.qrDataUrl;qr.hidden=false;notice.textContent='请使用微信扫码，然后点击“检查扫码结果”。';
  }else{notice.textContent='服务未返回有效的本地 SVG 二维码，请检查部署版本。';}
});
document.getElementById('poll').addEventListener('click',async()=>{
  const data=await request('/api/login/status','POST');if(data&&(data.connected===true||data.status==='confirmed')){hideQr();notice.textContent='微信已绑定。请在客户端继续配置连接器。';}
});
document.getElementById('status').addEventListener('click',()=>request('/api/status','GET'));
document.getElementById('disconnect').addEventListener('click',async()=>{
  if(!window.confirm('断开此部署的微信绑定？此操作不会撤销已经发送的消息。'))return;
  const data=await request('/api/disconnect','POST');if(data){hideQr();tokenInput.value='';notice.textContent='断开请求已完成，管理令牌已从输入框清除。';}
});
</script></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  } });
}
