import worker,{WeixinAccount,OAuthState} from '../../src/index';
export {WeixinAccount};
export class TestOAuth extends OAuthState {
 expire(kind:string){this.ctx.storage.sql.exec('UPDATE oauth_records SET expires=0 WHERE kind=?',kind);}
 inspect(){return this.ctx.storage.sql.exec<{kind:string;value:string;key:string}>('SELECT kind,value,key FROM oauth_records').toArray();}
}
export default {async fetch(request:Request,env:Env,ctx:ExecutionContext){
 const path=new URL(request.url).pathname;
 const store=env.OAUTH.getByName('single-owner') as unknown as DurableObjectStub<TestOAuth>;
 if(path.startsWith('/test/expire/')){await store.expire(path.slice('/test/expire/'.length));return new Response('ok');}
 if(path==='/test/inspect')return Response.json(await store.inspect());
 return worker.fetch(request,env);
}};
