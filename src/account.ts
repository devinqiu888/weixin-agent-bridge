import { EventStore } from './event-store';
import {sha256,type OAuthGrant} from './oauth-crypto';
import type { EventSubscribeParams, EventUnsubscribeParams } from './events';
import { DurableObject } from 'cloudflare:workers';
import { WeixinClient, WeixinError, validateWeixinBaseUrl } from './weixin';

type Binding = { token:string; baseUrl:string; owner:string; generation:string; cursor:string };
type Login = { id:string; qrcode?:string; expires:number };
type Row = { id:string; sender:string; text:string; context:string; state:string; reply:string|null; client_id:string|null; created:number };
const CREATE_MESSAGES = 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,sender TEXT,text TEXT,context TEXT,state TEXT,reply TEXT,client_id TEXT,created INTEGER)';
export class WeixinAccount extends DurableObject<Env> {
 constructor(ctx:DurableObjectState, env:Env) {
  super(ctx,env);
  ctx.storage.sql.exec(CREATE_MESSAGES);
 }
 private events() { return new EventStore(this.ctx,(this.env.CALLBACK_HOSTS ?? '').split(',').map(x=>x.trim()).filter(Boolean)); }
 async subscribe(params:EventSubscribeParams,oauthGrant?:string) { return this.events().subscribe(params,oauthGrant); }
 async setOAuthGrant(grant:OAuthGrant|null) {
  return this.ctx.blockConcurrencyWhile(async()=>{
   const old=await this.ctx.storage.get<OAuthGrant|null>('oauthGrant');
   if(grant && old?.id===grant.id)return;
   this.events();
   this.ctx.storage.transactionSync(()=>{
    this.ctx.storage.sql.exec('DELETE FROM subscriptions');
    this.ctx.storage.sql.exec('DELETE FROM outbox');
    this.ctx.storage.sql.exec('DELETE FROM event_revisions');
   });
   await this.ctx.storage.put('oauthGrant',grant);
   const binding=await this.ctx.storage.get<Binding>('binding');
   if(binding){
    await this.ctx.storage.put('binding',{...binding,generation:crypto.randomUUID()});
    await this.ctx.storage.setAlarm(Date.now()+1000);
   }
  });
 }
 async unsubscribe(params:EventUnsubscribeParams) { return this.events().unsubscribe(params); }
 async startLogin() {
  // Reserve before network I/O. A second request must not replace an in-flight QR.
  const id=crypto.randomUUID();
  const reservationError=await this.ctx.blockConcurrencyWhile(async()=>{
   if(await this.ctx.storage.get('binding'))return 'Disconnect before rebinding';
   const existing=await this.ctx.storage.get<Login>('login');
   if(existing && existing.expires>Date.now())return 'Login already pending; check its status or disconnect first';
   await this.ctx.storage.put('login',{id,expires:Date.now()+300000} satisfies Login);
   return null;
  });
  if(reservationError)throw new Error(reservationError);
  try {
   const result=await new WeixinClient().createLogin();
   const committed=await this.ctx.blockConcurrencyWhile(async()=>{
    const current=await this.ctx.storage.get<Login>('login');
    if(current?.id!==id || current.expires<Date.now())return null;
    await this.ctx.storage.put('login',{...current,qrcode:result.qrcode});
    return {qrcode_img_content:result.qrcode_img_content};
   });
   if(!committed)throw new Error('Login cancelled or expired');
   return committed;
  }catch(error){
   await this.ctx.blockConcurrencyWhile(async()=>{
    if((await this.ctx.storage.get<Login>('login'))?.id===id)await this.ctx.storage.delete('login');
   });
   throw error;
  }
 }
 async pollLogin() {
  const login=await this.ctx.storage.get<Login>('login');
  if(!login || login.expires<Date.now())return {status:'expired'};
  if(!login.qrcode)return {status:'preparing'};
  const result=await new WeixinClient().pollLogin(login.qrcode);
  if(result.status==='confirmed' && (!result.bot_token || !result.ilink_user_id))throw new Error('Incomplete login response');
  const baseUrl=result.status==='confirmed'?validateWeixinBaseUrl(result.baseurl ?? 'https://ilinkai.weixin.qq.com'):undefined;
  return this.ctx.blockConcurrencyWhile(async()=>{
   const current=await this.ctx.storage.get<Login>('login');
   if(current?.id!==login.id || current.expires<Date.now())return {status:'cancelled'};
   if(result.status==='confirmed'){
    if(await this.ctx.storage.get('binding'))return {status:'cancelled'};
    const binding:Binding={token:result.bot_token!,owner:result.ilink_user_id!,baseUrl:baseUrl!,generation:crypto.randomUUID(),cursor:''};
    await this.ctx.storage.put('binding',binding);
    await this.ctx.storage.delete('login');
    await this.ctx.storage.setAlarm(Date.now()+1000);
   }
   return {status:result.status};
  });
 }
 async recordCallbackAttempt(hostname:string) {
  // Never accept a URL, path, query, port, or signing material into diagnostics.
  const safe=hostname.length<=253 && hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  await this.ctx.storage.put('lastCallbackAttempt',{hostname:safe?hostname:null,at:new Date().toISOString()});
 }
 async getCallbackDiagnostics() {
  const messageCounts={pending:0,sending:0,sent:0,uncertain:0};
  for(const row of this.ctx.storage.sql.exec<{state:string;n:number}>('SELECT state,COUNT(*) AS n FROM messages GROUP BY state').toArray()){
   if(Object.hasOwn(messageCounts,row.state))messageCounts[row.state as keyof typeof messageCounts]=row.n;
  }
  return {accountCodeRevision:'message-diagnostics-v3',lastCallbackAttempt:await this.ctx.storage.get('lastCallbackAttempt')??null,messageCounts,lastNonEmptyBatch:await this.ctx.storage.get('lastNonEmptyBatch')??null};
 }
 async status(includeDiagnostics=false) {
  const b=await this.ctx.storage.get<Binding>('binding');
  return {...(includeDiagnostics?{lastCallbackAttempt:await this.ctx.storage.get('lastCallbackAttempt')??null}:{}),...await this.events().summary(),connected:!!b,pending:this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM messages WHERE state='pending'").one().n,lastPoll:await this.ctx.storage.get('lastPoll') ?? null,lastError:await this.ctx.storage.get('lastError') ?? null};
 }
 async alarm() {
  const grant=await this.ctx.storage.get<OAuthGrant>('oauthGrant');
  if(grant && (grant.expires<=Date.now() || grant.ownerHash!==await sha256(this.env.BRIDGE_TOKEN ?? '')))await this.setOAuthGrant(null);
  const b=await this.ctx.blockConcurrencyWhile(async()=>{
   const binding=await this.ctx.storage.get<Binding>('binding');
   if(binding)await this.ctx.storage.setAlarm(Date.now()+45000);
   return binding;
  });
  if(!b)return;
  let delay=1000;
  try {
   const updates=await new WeixinClient({token:b.token,baseUrl:b.baseUrl,timeoutMs:25000}).getUpdates(b.cursor);
   await this.ctx.blockConcurrencyWhile(async()=>{
    const active=await this.ctx.storage.get<Binding>('binding');
    if(active?.generation!==b.generation)return;
    // Storage writes and validation are gated together; disconnect cannot interleave
    // between validating this binding and committing a cursor from its network call.
    const events=this.events();
    const batch={at:new Date().toISOString(),total:updates.msgs.length,accepted:0,inserted:0,duplicates:0,skipped:{type:0,owner:0,id:0,context:0,no_text:0}};
    this.ctx.storage.transactionSync(()=>{
     for(const msg of updates.msgs){
      if(msg.message_type!==1){batch.skipped.type++;continue;}
      if(msg.from_user_id!==b.owner){batch.skipped.owner++;continue;}
      if(!msg.message_id){batch.skipped.id++;continue;}
      if(!msg.context_token){batch.skipped.context++;continue;}
      const text=(msg.item_list ?? []).filter(i=>i.type===1).map(i=>i.text_item?.text ?? '').join('\n');
      if(!text.trim()){batch.skipped.no_text++;continue;}
      batch.accepted++;
      const inserted=this.ctx.storage.sql.exec("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,'pending',NULL,NULL,?) RETURNING id",msg.message_id,msg.from_user_id,text.slice(0,16000),msg.context_token,Date.now()).toArray();
      if(inserted.length)batch.inserted++;else batch.duplicates++;
      if(inserted.length)events.enqueue({messageId:msg.message_id,senderId:msg.from_user_id,text:text.slice(0,16000)},Date.now());
     }
     // Never delete an uncertain/sending outcome automatically: doing so would
     // remove the only durable evidence preventing a duplicate reply after replay.
     this.ctx.storage.sql.exec("DELETE FROM messages WHERE created < ? AND state='pending'",Date.now()-86400000);
    });
    if(batch.total>0)await this.ctx.storage.put('lastNonEmptyBatch',batch);
    await this.ctx.storage.put('binding',{...active,cursor:updates.get_updates_buf});
    await this.ctx.storage.put('lastPoll',Date.now());await this.ctx.storage.delete('lastError');
   });
  }catch(error){
   if(!(error instanceof WeixinError && error.code==='timeout')){
    delay=30000;
    await this.ctx.blockConcurrencyWhile(async()=>{
     if((await this.ctx.storage.get<Binding>('binding'))?.generation===b.generation)
      await this.ctx.storage.put('lastError',error instanceof WeixinError ? error.code : 'poll_failed');
    });
   }
  }finally{
   if((await this.ctx.storage.get<Binding>('binding'))?.generation===b.generation)await this.events().flush();
   await this.ctx.blockConcurrencyWhile(async()=>{
    if((await this.ctx.storage.get<Binding>('binding'))?.generation===b.generation)
     await this.ctx.storage.setAlarm(Date.now()+delay);
   });
  }
 }
 async receive(waitSeconds:number) {
  const deadline=Date.now()+Math.max(0,Math.min(20,waitSeconds))*1000;
  do {
   const rows=this.ctx.storage.sql.exec<Row>("SELECT * FROM messages WHERE state='pending' ORDER BY created LIMIT 20").toArray();
   if(rows.length || Date.now()>=deadline)return {messages:rows.map(r=>({messageId:r.id,senderId:r.sender,text:r.text})),delivery:'at-least-once-until-replied'};
   await new Promise(resolve=>setTimeout(resolve,Math.min(500,deadline-Date.now())));
  }while(true);
 }
 async reply(messageId:string,text:string) {
  if(!text.trim() || text.length>4000)throw new Error('Invalid reply');
  const reservation=await this.ctx.blockConcurrencyWhile(async()=>{
   const b=await this.ctx.storage.get<Binding>('binding');if(!b)return {kind:'error' as const,error:'Not connected'};
   const row=this.ctx.storage.sql.exec<Row>('SELECT * FROM messages WHERE id=?',messageId).toArray()[0];
   if(!row || row.sender!==b.owner)return {kind:'error' as const,error:'Message not found'};
   if(row.state==='sent'){
    if(row.reply!==text)return {kind:'error' as const,error:'Already replied with different text'};
    return {kind:'sent' as const};
   }
   if(row.state!=='pending')return {kind:'unknown' as const};
   const clientId=crypto.randomUUID();
   this.ctx.storage.sql.exec("UPDATE messages SET state='sending',reply=?,client_id=? WHERE id=? AND state='pending'",text,clientId,messageId);
   // Persist the non-retryable reservation before any external send. Restarting
   // while sending is treated as unknown, never as permission to resend.
   await this.ctx.storage.sync();
   return {kind:'send' as const,b,row,clientId};
  });
  if(reservation.kind==='error')throw new Error(reservation.error);
  if(reservation.kind==='sent')return {status:'sent',duplicateSuppressed:true};
  if(reservation.kind==='unknown')return {status:'outcome_unknown',retryAllowed:false};
  const {b,row,clientId}=reservation;
  let sent=false;
  try {
   await new WeixinClient({token:b.token,baseUrl:b.baseUrl}).sendText({toUserId:row.sender,text,contextToken:row.context,clientId});
   sent=true;
  }catch{ /* A failed transport does not establish that upstream failed to send. */ }
  return this.ctx.blockConcurrencyWhile(async()=>{
   if((await this.ctx.storage.get<Binding>('binding'))?.generation!==b.generation)
    return {status:'outcome_unknown',retryAllowed:false,disconnected:true};
   this.ctx.storage.sql.exec("UPDATE messages SET state=? WHERE id=? AND client_id=? AND state='sending'",sent?'sent':'uncertain',messageId,clientId);
   await this.ctx.storage.sync();
   return sent?{status:'sent'}:{status:'outcome_unknown',retryAllowed:false};
  });
 }
 async disconnect() {
  return this.ctx.blockConcurrencyWhile(async()=>{
   const grant=await this.ctx.storage.get<OAuthGrant|null>('oauthGrant');
   await this.ctx.storage.deleteAlarm();await this.ctx.storage.deleteAll();
   if(grant!==undefined)await this.ctx.storage.put('oauthGrant',grant);
   this.ctx.storage.sql.exec(CREATE_MESSAGES);
   return {connected:false};
  });
 }
}
