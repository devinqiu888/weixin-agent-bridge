import {DurableObject} from 'cloudflare:workers';
import {randomToken,sha256,OAUTH_SCOPE,type OAuthGrant} from './oauth-crypto';
export type OAuthResult<T> = {ok:true;value:T}|{ok:false;error:string;status:number};
type Client = {client_id:string;client_name:string;redirect_uris:string[];token_endpoint_auth_method:'none';grant_types:string[];response_types:string[]};
export type Authorization = {clientId:string;redirectUri:string;challenge:string;state:string;resource:string;scope:string};
type Pending = Authorization & {csrfHash:string};
type Code = Authorization & {ownerHash:string;grantId:string;used?:boolean};
type Token = {clientId:string;grantId:string;resource:string;scope:string;used?:boolean};
type Grant = OAuthGrant & {ready:boolean};
const fail=(error:string,status=400)=>({ok:false as const,error,status});
const good=<T>(value:T)=>({ok:true as const,value});
/** Opaque OAuth credentials are stored by digest. All grant changes serialize here. */
export class OAuthState extends DurableObject<Env> {
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_records (key TEXT PRIMARY KEY,kind TEXT,value TEXT,expires INTEGER)');}
 private get<T>(key:string):T|undefined {
  const row=this.ctx.storage.sql.exec<{value:string;expires:number}>('SELECT value,expires FROM oauth_records WHERE key=?',key).toArray()[0];
  return row && row.expires>Date.now()?JSON.parse(row.value) as T:undefined;
 }
 private put(key:string,kind:string,value:unknown,expires:number){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO oauth_records VALUES(?,?,?,?)',key,kind,JSON.stringify(value),expires);}
 private delete(key:string){this.ctx.storage.sql.exec('DELETE FROM oauth_records WHERE key=?',key);}
 private async gate<T>(fn:()=>Promise<OAuthResult<T>>):Promise<OAuthResult<T>> {
  // Expected errors cross this gate as values: throwing resets a Durable Object.
  return this.ctx.blockConcurrencyWhile(async()=>{try{
   this.ctx.storage.sql.exec('DELETE FROM oauth_records WHERE expires<=?',Date.now());
   return await fn();
  }catch{return fail('temporarily_unavailable',503);}});
 }
 private async syncGrant(grant:Grant|null) {
  // Persist a retry before cross-object RPC. A failed RPC must not leave an active
  // subscription after revocation. Access is disabled until reconciliation succeeds.
  await this.ctx.storage.put('desiredGrant',grant);
  await this.ctx.storage.setAlarm(Date.now()+5000);
  await this.env.ACCOUNTS.getByName('self-hosted-owner').setOAuthGrant(grant?{id:grant.id,ownerHash:grant.ownerHash,expires:grant.expires}:null);
  if(grant){grant.ready=true;this.put('active','grant',grant,grant.expires);}
  await this.ctx.storage.delete('desiredGrant');await this.ctx.storage.deleteAlarm();
 }
 async alarm(){
  await this.gate(async()=>{
   const pending=await this.ctx.storage.get<Grant|null>('desiredGrant');
   if(pending!==undefined)await this.syncGrant(pending);
   return good({});
  });
 }
 async register(redirects:string[],name:string):Promise<OAuthResult<Client>> {
  const id='c_'+await sha256(JSON.stringify([...redirects].sort()));
  return this.gate(async()=>{
   const old=this.get<Client>(id);if(old)return good(old);
   const n=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM oauth_records WHERE kind='client'").one().n;
   if(n>=32)return fail('registration_limit_reached',429);
   const client:Client={client_id:id,client_name:name,redirect_uris:redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};
   this.put(id,'client',client,Number.MAX_SAFE_INTEGER);return good(client);
  });
 }
 async begin(input:Authorization,csrfHash:string):Promise<OAuthResult<{id:string;client:Client}>> {
  return this.gate(async()=>{
   const client=this.get<Client>(input.clientId);
   if(!client||!client.redirect_uris.includes(input.redirectUri))return fail('invalid_client');
   const n=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM oauth_records WHERE kind='pending'").one().n;
   if(n>=128)return fail('too_many_requests',429);
   const id=randomToken();this.put('p_'+id,'pending',{...input,csrfHash} satisfies Pending,Date.now()+600000);
   return good({id,client});
  });
 }
 async complete(id:string,csrfHash:string,ownerHash:string,approved:boolean):Promise<OAuthResult<{redirectUri:string;state:string;code?:string}>> {
  return this.gate(async()=>{
   const key='p_'+id,pending=this.get<Pending>(key);
   if(!pending||pending.csrfHash!==csrfHash)return fail('invalid_request');
   this.delete(key);
   if(!approved)return good({redirectUri:pending.redirectUri,state:pending.state});
   // A new owner-approved connection replaces the previous grant.
   this.delete('active');
   const grant:Grant={id:randomToken(),ownerHash,expires:Date.now()+30*86400000,ready:false};
   this.put('active','grant',grant,grant.expires);await this.syncGrant(grant);
   const code=randomToken();this.put('code_'+await sha256(code),'code',{...pending,ownerHash,grantId:grant.id} satisfies Code,Date.now()+300000);
   return good({redirectUri:pending.redirectUri,state:pending.state,code});
  });
 }
 private async tokens(data:Token,grant:Grant){
  const access='wa_'+randomToken(),refresh='wr_'+randomToken();
  this.put(await sha256(access),'access',data,Date.now()+3600000);
  this.put(await sha256(refresh),'refresh',data,grant.expires);
  return good({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:data.scope});
 }
 async exchange(input:{grantType:string;clientId:string;resource:string;redirectUri:string;code:string;verifier:string;refresh:string;ownerHash:string}) {
  const verifierHash=await sha256(input.verifier),key=input.grantType==='authorization_code'?'code_'+await sha256(input.code):await sha256(input.refresh);
  return this.gate(async()=>{
   if(!this.get<Client>(input.clientId))return fail('invalid_client');
   const grant=this.get<Grant>('active');
   if(!grant||!grant.ready||grant.ownerHash!==input.ownerHash)return fail('invalid_grant');
   if(input.grantType==='authorization_code'){
    const code=this.get<Code>(key);
    if(!code||code.clientId!==input.clientId||code.redirectUri!==input.redirectUri||code.resource!==input.resource||code.grantId!==grant.id||code.challenge!==verifierHash||!/^[-._~A-Za-z0-9]{43,128}$/.test(input.verifier))return fail('invalid_grant');
    if(code.used){this.delete('active');await this.syncGrant(null);return fail('invalid_grant');}
    this.put(key,'code',{...code,used:true},grant.expires);
    return this.tokens({clientId:input.clientId,grantId:grant.id,resource:code.resource,scope:code.scope},grant);
   }
   if(input.grantType!=='refresh_token')return fail('unsupported_grant_type');
   const token=this.get<Token>(key);
   if(!input.refresh.startsWith('wr_')||!token||token.clientId!==input.clientId||token.resource!==input.resource||token.grantId!==grant.id)return fail('invalid_grant');
   if(token.used){this.delete('active');await this.syncGrant(null);return fail('invalid_grant');}
   // Keep a tombstone until grant expiry so replay revokes the entire token family.
   this.put(key,'refresh',{...token,used:true},grant.expires);
   return this.tokens({...token,used:false},grant);
  });
 }
 async validate(access:string,resource:string,ownerHash:string):Promise<OAuthResult<OAuthGrant>> {
  if(!access.startsWith('wa_'))return fail('invalid_token',401);
  const hash=await sha256(access);
  return this.gate(async()=>{
   const token=this.get<Token>(hash),grant=this.get<Grant>('active');
   if(!token||!grant?.ready||grant.ownerHash!==ownerHash||token.grantId!==grant.id||token.resource!==resource||token.scope!==OAUTH_SCOPE)return fail('invalid_token',401);
   return good({id:grant.id,expires:grant.expires,ownerHash:grant.ownerHash});
  });
 }
 async revoke(token:string,clientId:string):Promise<OAuthResult<Record<string,never>>> {
  const key=await sha256(token);
  return this.gate(async()=>{
   const record=this.get<Token>(key),grant=this.get<Grant>('active');
   if(record&&record.clientId===clientId&&record.grantId===grant?.id){this.delete('active');await this.syncGrant(null);}
   return good({});
  });
 }
 async revokeAll():Promise<OAuthResult<Record<string,never>>>{return this.gate(async()=>{this.delete('active');await this.syncGrant(null);return good({});});}
}
