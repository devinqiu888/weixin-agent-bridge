import { WeixinAccount } from '../../src/account';
/** Test-only storage hooks. Never exported by the production Worker. */
export class TestAccount extends WeixinAccount {
 async seed() {
  await this.ctx.storage.put('binding',{token:'fixture-token',baseUrl:'https://ilinkai.weixin.qq.com',owner:'owner',generation:crypto.randomUUID(),cursor:''});
  await this.ctx.storage.deleteAlarm();
  return {seeded:true};
 }
 async pollOnce() { try{await super.alarm();}finally{await this.ctx.storage.deleteAlarm();}return {done:true}; }
 async inspect() {
  return {lastError:await this.ctx.storage.get('lastError'),binding:!!await this.ctx.storage.get('binding'),login:!!await this.ctx.storage.get('login'),alarm:await this.ctx.storage.getAlarm(),rows:this.ctx.storage.sql.exec('SELECT id,state,reply,client_id FROM messages').toArray()};
 }
}
export default {
 async fetch(request:Request,env:{ACCOUNTS:DurableObjectNamespace<TestAccount>}) {
  const stub=env.ACCOUNTS.getByName('test');
  const path=new URL(request.url).pathname;
  const data=request.method==='POST'?await request.json() as {id?:string;text?:string}:{};
  try{
   let value:unknown;
   switch(path){
    case '/seed':value=await stub.seed();break;
    case '/poll':value=await stub.pollOnce();break;
    case '/receive':value=await stub.receive(0);break;
    case '/reply':value=await stub.reply(data.id??'',data.text??'');break;
    case '/disconnect':value=await stub.disconnect();break;
    case '/start':value=await stub.startLogin();break;
    case '/diagnostics':value=await stub.getCallbackDiagnostics();break;
    case '/inspect':value=await stub.inspect();break;
    default:return new Response('not found',{status:404});
   }
   return Response.json(value);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'failed'},{status:409});}
 }
};
