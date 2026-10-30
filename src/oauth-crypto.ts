export const OAUTH_SCOPE = 'weixin:bridge';
export function randomToken(): string {
 return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function sha256(value:string):Promise<string> {
 return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function equalSecret(a:string,b:string):Promise<boolean> {
 const [x,y]=await Promise.all([sha256(a),sha256(b)]);let diff=0;
 for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);
 return diff===0;
}
export type OAuthGrant = {id:string;ownerHash:string;expires:number};
