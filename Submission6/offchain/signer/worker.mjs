// HTTP layer of the Genesis approval signer (Cloudflare Workers fetch API; also runs under Node for tests).
// POST /v1/approval/free  {wallet, look, choice} -> mintFree arguments
// POST /v1/eligibility    {wallet} -> on the free-mint list? already claimed?
// POST /v1/paid/prepare   {wallet, look, choice, token} -> order + GOLD consent typed data + ticket (no GOLD moves yet)
// POST /v1/approval/paid  {order, uri, ticket, consentSignature} -> GOLD held in the World book, mintPaid arguments
//                         (both 501 when this Worker has no GOLD binding)
// GET  /v1/health         -> catalogue version
// GET  /v1/stats          -> {totalMinted, maxSupply}
// GET  /v1/look/<lookKey> -> {lookKey, canonical, look}: the outfit behind an on-chain lookKey (501 without a LOOKS binding)
// GET  /v1/reveals        -> {block, reveals}: the committed secrets of the epochs whose seed block is mined, which the
//                            next mint (or settle) must carry; the page fetches them right before it sends (501 without REVEAL_SEED)
// The chain keeps only lookKey (a hash). Owner 2026-10-26: the signer records lookKey -> canonical look in LOOKS before it
// hands out a free approval or a paid order, so the page (and later the metadata) can show what each token wears.
import {keccak256,toUtf8Bytes} from '../vendor/ethers.min.js';
import {ApprovalError} from './free-approval.mjs';
import {RevealError} from './reveal-chain.mjs';
import {CATALOGUE,CANONICAL_PREFIX,LOOK_FIELDS} from './look.mjs';

export const MAX_BODY_BYTES=4096;
const LOOK_KEY=/^0x[0-9a-f]{64}$/;

/** canonicalLook() read back: {body, hat, ...} with "none" as null; null when the text is not a canonical look. */
export function lookFromCanonical(canonical){
 const parts=String(canonical).split(';');
 if(parts.shift()!==CANONICAL_PREFIX||parts.length!==LOOK_FIELDS.length)return null;
 const look={};
 for(const [i,p] of parts.entries()){const [k,v]=p.split('=');if(k!==LOOK_FIELDS[i]||!v)return null;look[k]=v==='none'?null:v;}
 return look;
}
const BASE_HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

/** approver(): the FreeApprovalSigner. paidApprover(): the PaidApprovalSigner, or null when the paid route is off.
 *  reveals(): {block, reveals} (signer/reveal-chain.mjs readyReveals), or null when no reveal seed is configured.
 *  allowedOrigins: exact origins of the mint page. */
export function createHandler({approver,paidApprover=null,reveals=null,allowedOrigins}){
 const origins=new Set(allowedOrigins);
 const cors=origin=>origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{};
 const reply=(status,data,origin)=>new Response(JSON.stringify(data),{status,headers:{...BASE_HEADERS,...cors(origin)}});
 const error=(status,code,origin)=>reply(status,{ok:false,error:{code}},origin);
 const limited=async(request,env)=>{if(!env.RATE_LIMITER)return false;const {success}=await env.RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')??'unknown'});return !success;};
 return async function fetch(request,env={}){
  const url=new URL(request.url),origin=request.headers.get('Origin')??'';
  try{
   if(request.method==='OPTIONS'){
    if(!origins.has(origin))return new Response(null,{status:403});
    return new Response(null,{status:204,headers:{...cors(origin),'Access-Control-Allow-Methods':'POST, GET','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}});
   }
   if(url.search)return error(400,'QUERY_NOT_ALLOWED',origin);
   if(request.method==='GET'&&url.pathname==='/v1/health')return reply(200,{ok:true,catalogueVersion:CATALOGUE.version},origin);
   if(request.method==='GET'&&url.pathname==='/v1/stats')return reply(200,{ok:true,...await (await approver(env)).stats()},origin);
   if(request.method==='GET'&&url.pathname.startsWith('/v1/look/')){
    const lookKey=url.pathname.slice('/v1/look/'.length).toLowerCase();
    if(!LOOK_KEY.test(lookKey))return error(400,'LOOK_KEY_INVALID',origin);
    if(!env.LOOKS)return error(501,'LOOK_STORE_NOT_READY',origin);
    const canonical=await env.LOOKS.get(lookKey);
    if(canonical===null||keccak256(toUtf8Bytes(canonical))!==lookKey)return error(404,'LOOK_NOT_FOUND',origin);
    return reply(200,{ok:true,lookKey,canonical,look:lookFromCanonical(canonical)},origin);
   }
   if(request.method==='GET'&&url.pathname==='/v1/reveals'){
    const ready=reveals?await reveals(env):null;
    if(!ready)return error(501,'REVEAL_NOT_READY',origin);
    if(await limited(request,env))return error(429,'RATE_LIMITED',origin);
    return reply(200,{ok:true,...await ready()},origin);
   }
   if(request.method!=='POST')return error(405,'METHOD_NOT_ALLOWED',origin);
   if(!origins.has(origin))return error(403,'ORIGIN_NOT_ALLOWED',origin);
   const paid={'/v1/paid/prepare':'prepare','/v1/approval/paid':'approve'}[url.pathname];
   const paidSigner=paid&&paidApprover?await paidApprover(env):null;
   if(paid&&!paidSigner)return error(501,'PAID_ROUTE_NOT_READY',origin);
   const op=paid??{'/v1/approval/free':'approve','/v1/eligibility':'eligibility'}[url.pathname];
   if(!op)return error(404,'NOT_FOUND',origin);
   if(await limited(request,env))return error(429,'RATE_LIMITED',origin);
   if((request.headers.get('Content-Type')??'').split(';')[0].trim()!=='application/json')return error(415,'JSON_REQUIRED',origin);
   const text=await request.text();
   if(new TextEncoder().encode(text).length>MAX_BODY_BYTES)return error(413,'REQUEST_TOO_LARGE',origin);
   let body;try{body=JSON.parse(text);}catch{return error(400,'REQUEST_JSON_INVALID',origin);}
   const result=await (paidSigner??await approver(env))[op](body);
   // free approval and paid prepare carry the canonical look: record it before the wallet can mint with it
   // (a look already stored is not written again: KV allows one write per key per second, and the value never changes)
   if(result.canonical&&env.LOOKS){
    const k=keccak256(toUtf8Bytes(result.canonical));
    try{if(await env.LOOKS.get(k)!==result.canonical)await env.LOOKS.put(k,result.canonical);}
    catch(e){
     // a concurrent request for the same look may have written it a moment ago (KV then refuses this write)
     const stored=await env.LOOKS.get(k).catch(()=>null);
     if(stored!==result.canonical){console.error('look store failed',e?.message);return error(503,'LOOK_STORE_UNAVAILABLE',origin);}
    }
   }
   return reply(200,{ok:true,...result},origin);
  }catch(e){
   if(e instanceof ApprovalError||e instanceof RevealError)return error(e.status,e.code,origin);
   console.error('approval failed',e?.message);
   return error(500,'INTERNAL_ERROR',origin);
  }
 };
}
