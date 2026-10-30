import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const bundle=build({entryPoints:['test/fixtures/worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']}).then(result=>result.outputFiles[0]!.text);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const message=(id:string,owner='owner')=>({message_id:id,from_user_id:owner,message_type:1,context_token:'ctx',item_list:[{type:1,text_item:{text:'hello'}}]});
async function harness(outbound:(request:Request)=>Promise<Response>){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await bundle,compatibilityDate:'2026-10-30',durableObjects:{ACCOUNTS:{className:'TestAccount',useSQLite:true}},outboundService:outbound}));
 const call=async(path:string,body?:unknown)=>{const response=await mf.dispatchFetch('https://fixture.test'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json() as Record<string,unknown>};};
 return {mf,call};
}
test('Durable Object: owner filtering, durable deduplication, duplicate reply suppression',{timeout:10000},async()=>{
 let sends=0;
 const {mf,call}=await harness(async request=>{
  const path=new URL(request.url).pathname;
  if(path.endsWith('/getupdates'))return Response.json({msgs:[message('1'),message('1'),message('2','outsider')],get_updates_buf:'next'});
  if(path.endsWith('/sendmessage')){sends++;return Response.json({ret:0,message_id:'sent-1'});}
  throw new Error('Unexpected outbound: '+path);
 });
 try{
  assert.equal((await call('/seed')).status,200);assert.equal((await call('/poll')).status,200);await call('/poll');
  const received=await call('/receive');assert.deepEqual(received.data.messages,[{messageId:'1',senderId:'owner',text:'hello'}]);
  assert.equal((await call('/reply',{id:'1',text:'answer'})).data.status,'sent');
  assert.equal((await call('/reply',{id:'1',text:'answer'})).data.duplicateSuppressed,true);
  assert.equal((await call('/reply',{id:'1',text:'different'})).status,409);
  assert.equal(sends,1);
 }finally{await mf.dispose();}
});
test('Durable Object: upstream send failure persists uncertain state and prevents retry',{timeout:10000},async()=>{
 let sends=0;
 const {mf,call}=await harness(async request=>{
  if(new URL(request.url).pathname.endsWith('/getupdates'))return Response.json({msgs:[message('1')]});
  sends++;return new Response('gateway failed',{status:502});
 });
 try{
  await call('/seed');await call('/poll');
  assert.equal((await call('/reply',{id:'1',text:'answer'})).data.status,'outcome_unknown');
  assert.equal((await call('/reply',{id:'1',text:'answer'})).data.retryAllowed,false);assert.equal(sends,1);
  const inspection=await call('/inspect');assert.equal((inspection.data.rows as Array<{state:string}>)[0]?.state,'uncertain');
 }finally{await mf.dispose();}
});
test('Durable Object: disconnect during long poll cannot resurrect account or messages',{timeout:10000},async()=>{
 const started=deferred<void>(),release=deferred<Response>();
 const {mf,call}=await harness(async()=>{started.resolve();return release.promise;});
 try{
  await call('/seed');const poll=call('/poll');await started.promise;
  await call('/disconnect');release.resolve(Response.json({msgs:[message('late')],get_updates_buf:'late'}));await poll;
  const state=(await call('/inspect')).data;assert.equal(state.binding,false);assert.equal(state.alarm,null);assert.deepEqual(state.rows,[]);
 }finally{release.resolve(Response.json({}));await mf.dispose();}
});
test('Durable Object: disconnect during login cannot restore pending binding',{timeout:10000},async()=>{
 const started=deferred<void>(),release=deferred<Response>();
 const {mf,call}=await harness(async()=>{started.resolve();return release.promise;});
 try{
  const login=call('/start');await started.promise;await call('/disconnect');
  release.resolve(Response.json({qrcode:'late',qrcode_img_content:'qr-content'}));assert.equal((await login).status,409);
  const state=(await call('/inspect')).data;assert.equal(state.binding,false);assert.equal(state.login,false);
 }finally{release.resolve(Response.json({}));await mf.dispose();}
});
test('Durable Object: disconnect during send reports unknown outcome and does not recreate rows',{timeout:10000},async()=>{
 const started=deferred<void>(),release=deferred<Response>();
 const {mf,call}=await harness(async request=>{
  if(new URL(request.url).pathname.endsWith('/getupdates'))return Response.json({msgs:[message('1')]});
  started.resolve();return release.promise;
 });
 try{
  await call('/seed');await call('/poll');const sending=call('/reply',{id:'1',text:'answer'});await started.promise;
  await call('/disconnect');release.resolve(Response.json({ret:0,message_id:'sent'}));
  assert.equal((await sending).data.status,'outcome_unknown');
  const state=(await call('/inspect')).data;assert.equal(state.binding,false);assert.deepEqual(state.rows,[]);
 }finally{release.resolve(Response.json({}));await mf.dispose();}
});

test('admin diagnostics count filtering and message states without retaining message content',{timeout:10000},async()=>{
 let empty=false;
 const {mf,call}=await harness(async()=>Response.json({msgs:empty?[]:[
  message('1'),message('1'),{...message('type'),message_type:2},message('owner-filter','outside-user'),
  {...message('missing-id'),message_id:''},{...message('missing-context'),context_token:''},
  {...message('no-text'),item_list:[{type:1,text_item:{text:'   '}}]}
 ]}));
 try{
  await call('/seed');await call('/poll');
  const first=(await call('/diagnostics')).data;
  assert.deepEqual(first.messageCounts,{pending:1,sending:0,sent:0,uncertain:0});
  const batch=first.lastNonEmptyBatch as Record<string,unknown>;
  assert.deepEqual(batch.skipped,{type:1,owner:1,id:1,context:1,no_text:1});
  assert.equal(batch.total,7);assert.equal(batch.accepted,2);assert.equal(batch.inserted,1);assert.equal(batch.duplicates,1);
  const serialized=JSON.stringify(first);for(const privateValue of ['hello','outside-user','fixture-token','context_token','missing-context'])assert.ok(!serialized.includes(privateValue));
  empty=true;await call('/poll');assert.deepEqual((await call('/diagnostics')).data.lastNonEmptyBatch,batch);
 }finally{await mf.dispose();}
});
