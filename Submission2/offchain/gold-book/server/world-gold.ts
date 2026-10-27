import type {D1Database,D1PreparedStatement} from './d1.ts';
import {economyAddress,economyDigest,economyUint,ECONOMY_MAX_INTEGER,type EconomyConfig} from './economy-config.ts';
import {economyConfigStatement} from './economy-reconciliation.ts';
import {AIMARKET_ACTIVITY_ADMIN_WALLETS} from './aimarket-admin.ts';
import {requireWorldGoldSchema} from './world-gold-schema.ts';
import {reconcileRewardEntitlements} from './economy-rewards.ts';
import {encodeGoldResult,encodeMintAuth,hasGoldResultContract} from './world-gold-result.ts';

export const WORLD_GOLD_TABLES=['world_gold_products','world_gold_links','world_gold_mints','world_gold_holds','world_gold_jobs','world_gold_entries','world_gold_admin_actions','world_gold_campaigns','world_gold_controls','world_gold_write_checks'] as const;
export const WORLD_GOLD_AUDIT_TABLES=['world_gold_reconcile_errors','world_gold_mint_settlements'] as const;
// Per-order technical integer limit, not a cap on total GOLD issuance.
export const WORLD_GOLD_MAX_PRODUCT=BigInt(Number.MAX_SAFE_INTEGER);
const st=(db:D1Database,sql:string,...args:unknown[])=>db.prepare(sql).bind(...args);
const check=(db:D1Database,predicate:string,...args:unknown[])=>st(db,`INSERT INTO world_gold_write_checks(id,accepted) SELECT ?,CASE WHEN ${predicate} THEN 1 ELSE 0 END`,crypto.randomUUID(),...args);
const authCheck=(db:D1Database,wallet:string,now:number,auth?:{tokenHash:string})=>check(db,auth?`EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND address=? AND revoked_at IS NULL AND expires_at>? AND wallet_type='EOA' AND verification_method='ECDSA')`:'1',...auth?[auth.tokenHash,wallet,now]:[]);
const writeGuardFailed=(e:unknown)=>e instanceof Error&&/CHECK constraint failed:\s*accepted\s*=\s*1/i.test(e.message);
const fail=(s:string):never=>{throw Error(s);};
const at=(n:number)=>Number.isSafeInteger(n)&&n>0?n:fail('INVALID_CLOCK');
const ident=(s:string)=>typeof s==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(s)?s:fail('INVALID_PRODUCT');
export const requestId=(s:string)=>typeof s==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(s)?s:fail('INVALID_REQUEST_ID');
type Product={id:string;product:string;version:number;kind:'topup'|'service';title:string;gold:string;embeo:string|null;enabled:number};
const productSelect='id,product,version,kind,title,CAST(gold AS TEXT) gold,embeo,enabled';
export type WorldGoldContext={db:D1Database;config:EconomyConfig;nowMs:number;now?:()=>number;serviceReady?:boolean};
export async function goldProducts(db:D1Database){return (await db.prepare(`SELECT ${productSelect} FROM world_gold_products p WHERE version=(SELECT MAX(version) FROM world_gold_products WHERE product=p.product) ORDER BY product`).all<Product>()).results;}
export async function goldFeature(db:D1Database,feature:'topup'|'service'|'mint'){
 if(!(await st(db,'SELECT enabled FROM world_gold_controls WHERE feature=?',feature).first<{enabled:number}>())?.enabled)fail('FEATURE_PAUSED');
}
export function goldBalanceStatement(db:D1Database,wallet:string){
 return st(db,`SELECT CAST(COALESCE((SELECT balance FROM economy_gold_accounts WHERE wallet=?),0) AS TEXT) book, CAST(COALESCE((SELECT SUM(amount) FROM world_gold_holds WHERE wallet=? AND state='held'),0) AS TEXT) reserved`,wallet,wallet);
}
export function goldBalanceView(row:{book:string;reserved:string}|undefined|null){
 if(!row)fail('LEDGER_UNAVAILABLE');
 const available=BigInt(row!.book)-BigInt(row!.reserved);if(available<0n)fail('LEDGER_INTEGRITY');
 return {book:row!.book,reserved:row!.reserved,available:String(available)};
}
export async function worldGoldSnapshot(db:D1Database,wallet:string,nowMs:number){
 wallet=economyAddress(wallet);at(nowMs);await requireWorldGoldSchema(db);
 const [balance,history,orders,mints,owed]=await db.batch([
  goldBalanceStatement(db,wallet),
  st(db,'SELECT id,delta,kind,reference,created_ms FROM world_gold_history WHERE wallet=? ORDER BY created_ms DESC,id DESC LIMIT 100',wallet),
  st(db,`SELECT o.id,o.service_id product,o.currency,o.amount,o.status,o.created_ms,o.expires_ms,l.kind,CAST(l.gold AS TEXT) gold,j.state delivery,j.result_json result FROM economy_orders o JOIN world_gold_links l ON l.order_id=o.id LEFT JOIN world_gold_jobs j ON j.order_id=o.id WHERE o.wallet=? ORDER BY o.created_ms DESC,o.id DESC LIMIT 100`,wallet),
  st(db,`SELECT id,state,CAST(amount AS TEXT) gold,deadline FROM world_gold_mints WHERE wallet=? ORDER BY created_ms DESC,id DESC LIMIT 100`,wallet),
  st(db,`SELECT id,config_id configId,day_start_ms dayStartMs,CAST(delta AS TEXT) gold,retry_ms retryMs,attempts FROM economy_gold_reward_entitlements WHERE wallet=? AND settled_ms IS NULL ORDER BY day_start_ms,id LIMIT 100`,wallet)
 ]);
 const view=goldBalanceView(balance.results[0] as {book:string;reserved:string}|undefined);
 return {wallet,...view,asOf:nowMs,history:history.results,orders:orders.results,mints:mints.results,pendingRewards:owed.results,pendingRewardsLimit:100,historyLimit:100,goldTransferable:false};
}
export async function goldQuote(ctx:WorldGoldContext,args:{wallet:string;requestId:string;product:string;authorization?:{tokenHash:string}}){
 const {db,config,nowMs}=ctx;at(nowMs);await requireWorldGoldSchema(db);const wallet=economyAddress(args.wallet),rid=requestId(args.requestId);ident(args.product);
 const retryId=(row:{id:string;status:string;expires_ms:number;created_ms:number})=>{const fresh=at(ctx.now?.()??nowMs);if(fresh<nowMs||fresh<row.created_ms)fail('INVALID_CLOCK');if(row.status==='pending'&&row.expires_ms<=fresh)fail('ORDER_EXPIRED');return row.id;};
 // Retrying an old request uses the original quote, even after disabling/repricing.
 const old=await st(db,'SELECT id,status,expires_ms,created_ms FROM economy_orders WHERE wallet=? AND request_id=?',wallet,rid).first<{id:string;status:string;expires_ms:number;created_ms:number}>();
 if(old){const link=await st(db,'SELECT p.product FROM world_gold_links l JOIN world_gold_products p ON p.id=l.product_id WHERE l.order_id=?',old.id).first<{product:string}>();if(link?.product!==args.product)fail('IDEMPOTENCY_CONFLICT');return retryId(old);}
 const p=(await goldProducts(db)).find(p=>p.product===args.product);if(!p?.enabled)fail('PRODUCT_UNAVAILABLE');
 economyUint(p!.gold,WORLD_GOLD_MAX_PRODUCT);
 if(p!.kind==='service'&&ctx.serviceReady!==true)fail('SERVICE_DELIVERY_UNAVAILABLE');
 if(p!.kind==='service'&&!hasGoldResultContract(p!.product))fail('SERVICE_RESULT_SCHEMA_UNBOUND');
 await goldFeature(db,p!.kind);
 const freshNow=at(ctx.now?.()??nowMs);if(freshNow<nowMs)fail('INVALID_CLOCK');
 const id='0x'+[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join(''),currency=p!.kind==='topup'?'EMBEO':'GOLD';
 try{await db.batch([
  authCheck(db,wallet,freshNow,args.authorization),economyConfigStatement(db,config),
  check(db,`EXISTS(SELECT 1 FROM world_gold_controls WHERE feature=? AND enabled=1) AND EXISTS(SELECT 1 FROM world_gold_products WHERE id=? AND enabled=1 AND version=(SELECT MAX(version) FROM world_gold_products WHERE product=?)) AND NOT EXISTS(SELECT 1 FROM economy_chain_state WHERE config_id=? AND halted_reason IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM economy_config_lineage WHERE ancestor_id=?)`,p!.kind,p!.id,p!.product,config.id,config.id),
  st(db,`INSERT INTO economy_orders(id,config_id,wallet,request_id,service_id,currency,amount,request_payload,created_ms,expires_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`,id,config.id,wallet,rid,p!.product,currency,p!.kind==='topup'?p!.embeo:p!.gold,JSON.stringify([config.id,p!.product,currency]),freshNow,freshNow+900000),
  st(db,'INSERT INTO world_gold_links(order_id,product_id,kind,gold) VALUES(?,?,?,?)',id,p!.id,p!.kind,p!.gold),
  st(db,'DELETE FROM world_gold_write_checks')
 ]);}catch(error){const retry=await st(db,'SELECT o.id,o.status,o.expires_ms,o.created_ms,p.product FROM economy_orders o JOIN world_gold_links l ON l.order_id=o.id JOIN world_gold_products p ON p.id=l.product_id WHERE o.wallet=? AND o.request_id=?',wallet,rid).first<{id:string;status:string;expires_ms:number;created_ms:number;product:string}>();if(retry?.product===args.product)return retryId(retry);
  if(writeGuardFailed(error)){
   const fresh=at(ctx.now?.()??nowMs);if(fresh<freshNow)fail('INVALID_CLOCK');
   await goldFeature(db,p!.kind);
   const current=(await goldProducts(db)).find(row=>row.product===args.product);if(!current?.enabled||current.id!==p!.id)fail('PRODUCT_UNAVAILABLE');
   if(await st(db,'SELECT 1 FROM economy_chain_state WHERE config_id=? AND halted_reason IS NOT NULL',config.id).first())fail('ECONOMY_HALTED');
   if(await st(db,'SELECT 1 FROM economy_config_lineage WHERE ancestor_id=?',config.id).first())fail('ECONOMY_CONFIG_REPLACED');
  }throw error;}
 return id;
}
const credit=(db:D1Database,orderId:string,kind:'topup'|'service-refund',nowMs:number)=>st(db,`INSERT INTO world_gold_entries(id,wallet,delta,kind,reference,order_id,created_ms)
 SELECT ?||':'||CAST(l.gold AS TEXT),o.wallet,l.gold-COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=o.id AND kind=?),0),?,?||':'||CAST(l.gold AS TEXT),o.id,? FROM economy_orders o JOIN world_gold_links l ON l.order_id=o.id WHERE o.id=? AND o.status='paid' AND l.gold>COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=o.id AND kind=?),0)
 ${kind==='topup'?"AND l.kind='topup' AND o.currency='EMBEO'":"AND l.kind='service' AND o.currency='GOLD' AND EXISTS(SELECT 1 FROM world_gold_jobs WHERE order_id=o.id AND state='failed')"}
 ON CONFLICT(reference) DO NOTHING`,kind+':'+orderId,kind,kind,kind+':'+orderId,nowMs,orderId,kind);
/** Shared by automatic retry and admin repair. No caller-supplied credit amount. */
export async function reconcileWorldGold(db:D1Database,nowMs:number,orderId?:string){
 at(nowMs);await requireWorldGoldSchema(db);
 const pending=await db.prepare(`SELECT o.id,l.kind,e.code,e.retry_ms FROM economy_orders o JOIN world_gold_links l ON l.order_id=o.id LEFT JOIN world_gold_reconcile_errors e ON e.order_id=o.id WHERE o.status='paid' AND ((l.kind='topup' AND l.gold>COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=o.id AND kind='topup'),0)) OR (l.kind='service' AND NOT EXISTS(SELECT 1 FROM world_gold_jobs WHERE order_id=o.id))) ${orderId?'AND o.id=?':'AND (e.order_id IS NULL OR e.retry_ms<=?)'} ORDER BY o.created_ms,o.id LIMIT 128`).bind(orderId??nowMs).all<{id:string;kind:string;code:string|null;retry_ms:number|null}>();
 const failures:{orderId:string;code:string}[]=[];let processed=0;
 // An owned HTTP retry observes the same cooldown as cron. Keep the original
 // failure and retry deadline; a refresh must not postpone an owed credit.
 const deferred=(id:string,e:{code:string|null;retry_ms:number|null})=>{if(e.retry_ms!==null&&e.retry_ms>nowMs){failures.push({orderId:id,code:e.code??'GOLD_RECONCILE_RETRY'});return true;}return false;};
 const recordFailure=async(id:string,error:unknown)=>{const message=error instanceof Error?error.message:'';const code=message.includes('GOLD_BALANCE_CAPACITY')?'GOLD_BALANCE_CAPACITY':'GOLD_RECONCILE_RETRY';failures.push({orderId:id,code});await st(db,`INSERT INTO world_gold_reconcile_errors(order_id,code,retry_ms,attempts) VALUES(?,?,?,1) ON CONFLICT(order_id) DO UPDATE SET code=excluded.code,retry_ms=excluded.retry_ms,attempts=attempts+1`,id,code,nowMs+300000).run();};
 for(const o of pending.results){
  if(deferred(o.id,o))continue;processed++;
  try{await db.batch([
   o.kind==='topup'?credit(db,o.id,'topup',nowMs):st(db,`INSERT INTO world_gold_jobs(order_id,wallet,state,updated_ms) SELECT id,wallet,'queued',? FROM economy_orders WHERE id=? ON CONFLICT(order_id) DO NOTHING`,nowMs,o.id),
   st(db,'DELETE FROM world_gold_reconcile_errors WHERE order_id=?',o.id)
  ]);}catch(error){await recordFailure(o.id,error);}
 }
 const failed=await db.prepare(`SELECT j.order_id,e.code,e.retry_ms FROM world_gold_jobs j LEFT JOIN world_gold_reconcile_errors e ON e.order_id=j.order_id WHERE j.state='failed' ${orderId?'AND j.order_id=?':'AND (e.order_id IS NULL OR e.retry_ms<=?)'} ORDER BY j.order_id LIMIT 128`).bind(orderId??nowMs).all<{order_id:string;code:string|null;retry_ms:number|null}>();
 for(const j of failed.results){if(deferred(j.order_id,j))continue;try{await refundGold(db,j.order_id,nowMs);await st(db,'DELETE FROM world_gold_reconcile_errors WHERE order_id=?',j.order_id).run();}catch(error){await recordFailure(j.order_id,error);}}
 await st(db,'DELETE FROM world_gold_write_checks').run();
 const rewards=orderId?[]:await reconcileRewardEntitlements(db,nowMs);
 return {processed,failures,rewards};
}
export async function refundGold(db:D1Database,orderId:string,nowMs:number){
 at(nowMs);await requireWorldGoldSchema(db);await db.batch([credit(db,orderId,'service-refund',nowMs),st(db,`UPDATE world_gold_jobs SET state='refunded',updated_ms=? WHERE order_id=? AND state='failed' AND EXISTS(SELECT 1 FROM world_gold_entries e JOIN world_gold_links l ON l.order_id=e.order_id WHERE e.order_id=world_gold_jobs.order_id AND e.reference='service-refund:'||l.order_id||':'||CAST(l.gold AS TEXT))`,nowMs,orderId)]);
 const j=await st(db,'SELECT state FROM world_gold_jobs WHERE order_id=?',orderId).first<{state:string}>();if(j?.state!=='refunded')fail('REFUND_NOT_ENTITLED');
}
/** An adapter must use orderId as its provider idempotency key. A timeout is
 * unknown, not failed. After lease expiry, retry QUERY/DELIVER of the same key. */
export async function claimGoldJob(db:D1Database,orderId:string,nowMs:number,clock?:()=>number){
 at(nowMs);await requireWorldGoldSchema(db);const fresh=at(clock?.()??nowMs);if(fresh<nowMs)fail('INVALID_CLOCK');nowMs=fresh;const token=crypto.randomUUID();
 const result=await st(db,`UPDATE world_gold_jobs SET state='working',attempt=?,lease_ms=?,updated_ms=? WHERE order_id=? AND (state='queued' OR (state='working' AND lease_ms<=?)) RETURNING wallet`,token,nowMs+60000,nowMs,orderId,nowMs).run();
 return result.results.length?token:null;
}
export type GoldFailureProof={kind:'provider-confirmed-nondelivery';provider:string;reference:string};
export async function finishGoldJob(db:D1Database,args:{orderId:string;attempt:string;nowMs:number;now?:()=>number;outcome:{result:unknown}|{failure:string;evidence:GoldFailureProof}}){
 at(args.nowMs);await requireWorldGoldSchema(db);let json:string|null=null,failure:string|null=null,evidence:unknown=null;
 if('result' in args.outcome){
  const job=await st(db,`SELECT p.product FROM world_gold_jobs j JOIN world_gold_links l ON l.order_id=j.order_id JOIN world_gold_products p ON p.id=l.product_id WHERE j.order_id=?`,args.orderId).first<{product:string}>();
  if(job&&!hasGoldResultContract(job.product))fail('SERVICE_RESULT_SCHEMA_UNBOUND');
  ({json,failure}=encodeGoldResult(job?.product??'',args.outcome.result));
 }
 else {const p=args.outcome.evidence;if(!p||p.kind!=='provider-confirmed-nondelivery'||typeof p.provider!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.provider)||typeof p.reference!=='string'||!/^[A-Za-z0-9._:/-]{1,80}$/.test(p.reference)||typeof args.outcome.failure!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(args.outcome.failure))fail('DELIVERY_EVIDENCE_REQUIRED');failure=args.outcome.failure;evidence=p;}
 if(failure&&evidence===null)evidence={kind:'world-result-unusable',source:'storage-encoder',reference:args.orderId,code:failure};
 const finishedAt=at(args.now?.()??args.nowMs);if(finishedAt<args.nowMs)fail('INVALID_CLOCK');
 const done=failure===null;
 const changed=await st(db,`UPDATE world_gold_jobs SET state=?,result_json=?,failure=?,delivery_evidence_json=?,lease_ms=NULL,updated_ms=? WHERE order_id=? AND state='working' AND attempt=? AND lease_ms>? RETURNING order_id`,done?'delivered':'failed',done?json:null,failure,evidence===null?null:JSON.stringify(evidence),finishedAt,args.orderId,args.attempt,finishedAt).run();
 if(!changed.results.length)fail('STALE_DELIVERY');if(!done)await refundGold(db,args.orderId,finishedAt);
}
export type MintBinding={id:string;wallet:string;auth:unknown;gold:string;chainId:number;contract:string;chainInstance:string;deadline:number};
export async function reserveMintGold(db:D1Database,m:MintBinding,nowMs:number,now:()=>number|Promise<number>=Date.now){
 at(nowMs);await requireWorldGoldSchema(db);const wallet=economyAddress(m.wallet),contract=economyAddress(m.contract),gold=economyUint(m.gold,WORLD_GOLD_MAX_PRODUCT);
 if(!/^0x[0-9a-f]{64}$/.test(m.id)||!Number.isSafeInteger(m.deadline)||m.deadline<=nowMs||!Number.isSafeInteger(m.chainId)||m.chainId<1||typeof m.chainInstance!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(m.chainInstance))fail('INVALID_MINT_AUTH');
 const old=await st(db,'SELECT auth_json,state,wallet,CAST(amount AS TEXT) gold,chain_id chainId,contract,chain_instance chainInstance,deadline FROM world_gold_mints WHERE id=?',m.id).first<Omit<StoredMintBinding,'auth'>&{auth_json:string}>();
 if(old&&(old.state!=='held'||old.wallet!==wallet||old.gold!==gold||old.chainId!==m.chainId||old.contract!==contract||old.chainInstance!==m.chainInstance||old.deadline!==m.deadline))fail('MINT_ORDER_CONFLICT');
 const encoded=encodeMintAuth(m.auth,{...m,wallet,contract,gold});
 const fresh=async()=>{const n=at(await now());if(n<nowMs)fail('INVALID_CLOCK');if(m.deadline<=n)fail('MINT_AUTH_EXPIRED');return n;};
 if(old){if(old.auth_json!==encoded||old.state!=='held'||old.wallet!==wallet||old.gold!==gold||old.chainId!==m.chainId||old.contract!==contract||old.chainInstance!==m.chainInstance||old.deadline!==m.deadline)fail('MINT_ORDER_CONFLICT');await fresh();return;}
 await goldFeature(db,'mint');
 const freshNow=await fresh();
 await db.batch([
  check(db,"?< ? AND EXISTS(SELECT 1 FROM world_gold_controls WHERE feature='mint' AND enabled=1)",freshNow,m.deadline),
  st(db,`INSERT INTO world_gold_mints(id,wallet,auth_json,amount,chain_id,contract,chain_instance,deadline,created_ms,state) VALUES(?,?,?,?,?,?,?,?,?,'held')`,m.id,wallet,encoded,gold,m.chainId,contract,m.chainInstance,m.deadline,freshNow),
  st(db,"INSERT INTO world_gold_holds(id,wallet,amount,state) VALUES(?,?,?,'held')",m.id,wallet,gold),st(db,'DELETE FROM world_gold_write_checks')
 ]);
}
/** Server verifier only; HTTP never accepts these facts from a browser. */
export type MintOutcome={id:string;chainId:number;contract:string;chainInstance:string;state:'consumed'|'released';evidence:Record<string,unknown>};
export type StoredMintBinding=MintBinding&{state:string};
export type MintProof={schema:'ember-mint-proof-v1';mode:'finalized-chain'|'private-chain-fixture';orderId:string;wallet:string;gold:string;chainId:number;contract:string;chainInstance:string;blockHash:string;blockNumber:string;chainTimeMs:number;tokenId:string;revoked:boolean;transactionHash?:string};
/** Only a server-owned reader of the original chain namespace may supply facts.
 * A new private chain/process instance cannot stand in for the original one. */
export type MintProofReader={chainId:number;contract:string;chainInstance:string;read:(binding:StoredMintBinding)=>Promise<MintProof>};
export async function storedMintGold(db:D1Database,id:string):Promise<StoredMintBinding>{
 await requireWorldGoldSchema(db);
 const r=await st(db,`SELECT id,wallet,auth_json,CAST(amount AS TEXT) gold,chain_id chainId,contract,chain_instance chainInstance,deadline,state FROM world_gold_mints WHERE id=?`,id).first<Omit<StoredMintBinding,'auth'>&{auth_json:string}>();
 if(!r)fail('MINT_ORDER_MISSING');const {auth_json,...binding}=r!;return {...binding,auth:JSON.parse(auth_json)};
}
function validateMintProof(m:StoredMintBinding,o:MintOutcome,pending=false){
 const e=o.evidence as unknown as MintProof,hash=(s:unknown)=>typeof s==='string'&&/^0x[0-9a-f]{64}$/.test(s)&&s!=='0x'+'0'.repeat(64),uint=(s:unknown)=>typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s);
 if(!e||e.schema!=='ember-mint-proof-v1'||!['finalized-chain','private-chain-fixture'].includes(e.mode)||((e.mode==='private-chain-fixture')!==(m.chainId===31337))||e.orderId!==m.id||e.wallet!==m.wallet||e.gold!==m.gold||e.chainId!==m.chainId||e.contract!==m.contract||e.chainInstance!==m.chainInstance||!hash(e.blockHash)||!uint(e.blockNumber)||!Number.isSafeInteger(e.chainTimeMs)||e.chainTimeMs<=0||!uint(e.tokenId)||typeof e.revoked!=='boolean')fail('MINT_EVIDENCE_REQUIRED');
 if(!pending){if(o.state==='consumed'){if(BigInt(e.tokenId)===0n||!hash(e.transactionHash)||e.revoked)fail('MINT_PROOF_CONFLICT');}
 else if(o.state!=='released'||e.tokenId!=='0'||(!e.revoked&&e.chainTimeMs<=m.deadline))fail('MINT_AUTH_EXECUTABLE');}
 const json=JSON.stringify(e);if(new TextEncoder().encode(json).length>16000)fail('MINT_EVIDENCE_REQUIRED');return json;
}
export async function settleMintGold(db:D1Database,o:MintOutcome,nowMs:number){
 at(nowMs);const row=await storedMintGold(db,o.id);
 if(row.chainId!==o.chainId||row.contract!==economyAddress(o.contract)||row.chainInstance!==o.chainInstance)fail('MINT_SCOPE_MISMATCH');
 if(row.state===o.state)return;if(row.state!=='held')fail('MINT_STATE_CONFLICT');
 const evidence=validateMintProof(row,o),beforeId='mint-before:'+o.id;
 const view=`json_object('state',(SELECT state FROM world_gold_mints WHERE id=?),'book',CAST(COALESCE((SELECT balance FROM economy_gold_accounts WHERE wallet=?),0) AS TEXT),'held',CAST(COALESCE((SELECT SUM(amount) FROM world_gold_holds WHERE wallet=? AND state='held'),0) AS TEXT))`;
 const statements=[st(db,`INSERT INTO world_gold_write_checks(id,accepted,before_json) SELECT ?,1,${view}`,beforeId,o.id,row.wallet,row.wallet),st(db,"UPDATE world_gold_mints SET state=?,evidence_json=? WHERE id=? AND state='held'",o.state,evidence,o.id),st(db,"UPDATE world_gold_holds SET state=? WHERE id=? AND state='held'",o.state,o.id)];
 if(o.state==='consumed')statements.push(st(db,`INSERT INTO world_gold_entries(id,wallet,delta,kind,reference,order_id,created_ms) SELECT ?,wallet,-amount,'mint-payment',?,id,? FROM world_gold_mints WHERE id=? AND state='consumed' ON CONFLICT(reference) DO NOTHING`,'mint-payment:'+o.id,'mint-payment:'+o.id,nowMs,o.id));
 statements.push(st(db,`INSERT INTO world_gold_mint_settlements(order_id,state,evidence_json,before_json,after_json,created_ms) SELECT ?,?,?,before_json,${view},? FROM world_gold_write_checks WHERE id=?`,o.id,o.state,evidence,o.id,row.wallet,row.wallet,nowMs,beforeId),st(db,'DELETE FROM world_gold_write_checks'));
 try{await db.batch(statements);}catch(error){const latest=await storedMintGold(db,o.id);if(latest.state===o.state&&await st(db,'SELECT order_id FROM world_gold_mint_settlements WHERE order_id=?',o.id).first())return;if(latest.state!=='held')fail('MINT_STATE_CONFLICT');throw error;}
}
/** Bounded recovery from persisted orders, independent of a service's memory map.
 * Supply a trusted reader for the preserved namespace. Missing original chain
 * authority is an explicit blocked outcome; elapsed wall time never releases. */
export async function reconcileHeldMintGold(db:D1Database,reader:MintProofReader,nowMs:number,options:{orderId?:string;after?:string;limit?:number}={}){
 at(nowMs);await requireWorldGoldSchema(db);const limit=options.limit??32;if(!Number.isInteger(limit)||limit<1||limit>32)fail('INVALID_RECONCILIATION_LIMIT');
 const ids=await st(db,`SELECT id FROM world_gold_mints WHERE state='held' AND id>? ${options.orderId?'AND id=?':''} ORDER BY id LIMIT ?`,options.after??'',...options.orderId?[options.orderId]:[],limit).all<{id:string}>();
 const outcomes:{id:string;status:string}[]=[];
 for(const {id} of ids.results){try{const m=await storedMintGold(db,id);if(reader.chainId!==m.chainId||economyAddress(reader.contract)!==m.contract||reader.chainInstance!==m.chainInstance)fail('MINT_SCOPE_MISMATCH');
   const proof=await reader.read(m),state=proof.tokenId!=='0'?'consumed':proof.revoked||proof.chainTimeMs>m.deadline?'released':null;
   // Validate even a pending proof before interpreting the clock/revocation.
   if(state){await settleMintGold(db,{id,chainId:m.chainId,contract:m.contract,chainInstance:m.chainInstance,state,evidence:proof},nowMs);outcomes.push({id,status:state});}
   else {validateMintProof(m,{id,chainId:m.chainId,contract:m.contract,chainInstance:m.chainInstance,state:'released',evidence:proof},true);outcomes.push({id,status:'pending'});}
  }catch(error){const code=error instanceof Error?error.message:'';outcomes.push({id,status:['MINT_SCOPE_MISMATCH','MINT_EVIDENCE_REQUIRED','MINT_PROOF_CONFLICT','MINT_AUTH_EXECUTABLE'].includes(code)?code:'MINT_CHAIN_UNAVAILABLE'});}}
 return {outcomes,next:ids.results.length===limit?ids.results.at(-1)!.id:null};
}
export async function goldCampaign(db:D1Database,nowMs:number){
 at(nowMs);const c=await db.prepare('SELECT version,starts_ms startsMs,ends_ms endsMs,stopped FROM world_gold_campaigns ORDER BY version DESC LIMIT 1').first<{version:number;startsMs:number;endsMs:number;stopped:number}>();
 return c?{...c,active:!c.stopped&&nowMs>=c.startsMs&&nowMs<c.endsMs,asOf:nowMs}:{version:0,startsMs:null,endsMs:null,stopped:0,active:false,asOf:nowMs};
}
type AdminCommand={action:'product';product:string;kind:'topup'|'service';title:string;gold:string;embeo?:string;enabled:boolean;version:number}|{action:'campaign';version:number;startsMs:number;endsMs:number;stopped:boolean}|{action:'control';feature:'topup'|'service'|'mint';enabled:boolean;version:number}|{action:'repair-topup'|'refund-service';orderId:string};
export async function goldAdminCommand(db:D1Database,args:{wallet:string;requestId:string;command:AdminCommand;reason:string;nowMs:number;now?:()=>number;authorization?:{tokenHash:string};serviceReady?:boolean}){
 const wallet=economyAddress(args.wallet),rid=requestId(args.requestId),started=at(args.nowMs),cmd=args.command;
 if(!AIMARKET_ACTIVITY_ADMIN_WALLETS.includes(wallet))fail('ADMIN_REQUIRED');
 await requireWorldGoldSchema(db);
 if(typeof args.reason!=='string'||args.reason.trim().length<3||args.reason.length>500)fail('REASON_REQUIRED');
 const id=await economyDigest(wallet+':'+rid),payload=JSON.stringify([cmd,args.reason]);
 const old=await st(db,'SELECT payload FROM world_gold_admin_actions WHERE id=?',id).first<{payload:string}>();if(old){if(old.payload!==payload)fail('IDEMPOTENCY_CONFLICT');return;}
 const now=at(args.now?.()??started);if(now<started)fail('INVALID_CLOCK');
 const auditState=`json_object('productVersion',(SELECT MAX(version) FROM world_gold_products WHERE product=?),'campaignVersion',(SELECT MAX(version) FROM world_gold_campaigns),'feature',(SELECT json_object('enabled',enabled,'version',version) FROM world_gold_controls WHERE feature=?),'order',(SELECT json_object('id',o.id,'wallet',o.wallet,'status',o.status,'book',CAST(COALESCE((SELECT balance FROM economy_gold_accounts WHERE wallet=o.wallet),0) AS TEXT),'credited',CAST(COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=o.id AND kind='topup'),0) AS TEXT),'refunded',CAST(COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=o.id AND kind='service-refund'),0) AS TEXT),'delivery',(SELECT state FROM world_gold_jobs WHERE order_id=o.id)) FROM economy_orders o WHERE id=?))`;
 const auditArgs=['product' in cmd?cmd.product:'','feature' in cmd?cmd.feature:'','orderId' in cmd?cmd.orderId:''];
 const beforeId='admin-before:'+id;
 const audit=st(db,`INSERT INTO world_gold_admin_actions(id,wallet,request_id,action,payload,created_ms,before_json,after_json) SELECT ?,?,?,?,?,?,before_json,${auditState} FROM world_gold_write_checks WHERE id=?`,id,wallet,rid,cmd.action,payload,now,...auditArgs,beforeId);
 const guards:{sql:string;values:unknown[];code:string}[]=[];
 const guard=(code:string,sql:string,...values:unknown[])=>{guards.push({sql,values,code});return check(db,sql,...values);};
 const list:D1PreparedStatement[]=[authCheck(db,wallet,now,args.authorization),st(db,`INSERT INTO world_gold_write_checks(id,accepted,before_json) SELECT ?,1,${auditState}`,beforeId,...auditArgs)];
 if(cmd.action==='product'){
  ident(cmd.product);if(!['topup','service'].includes(cmd.kind)||typeof cmd.enabled!=='boolean'||typeof cmd.title!=='string'||!cmd.title.trim()||cmd.title.length>120||!Number.isSafeInteger(cmd.version)||cmd.version<1)fail('INVALID_PRODUCT');
  if(cmd.kind==='service'&&cmd.enabled&&args.serviceReady!==true)fail('SERVICE_DELIVERY_UNAVAILABLE');
  const gold=economyUint(cmd.gold,WORLD_GOLD_MAX_PRODUCT),embeo=cmd.kind==='topup'?economyUint(cmd.embeo):null;
  const pid=cmd.product+':'+cmd.version;
  list.push(guard('VERSION_CONFLICT','?=COALESCE((SELECT MAX(version) FROM world_gold_products WHERE product=?),0)+1',cmd.version,cmd.product),st(db,`INSERT INTO world_gold_products(id,product,version,kind,title,gold,embeo,enabled,created_ms) VALUES(?,?,?,?,?,?,?,?,?)`,pid,cmd.product,cmd.version,cmd.kind,cmd.title,gold,embeo,Number(cmd.enabled),now));
 }else if(cmd.action==='campaign'){
  if(!Number.isSafeInteger(cmd.startsMs)||cmd.startsMs<=0||!Number.isSafeInteger(cmd.endsMs)||cmd.endsMs<=0||cmd.endsMs<=cmd.startsMs||!Number.isSafeInteger(cmd.version)||cmd.version<1||typeof cmd.stopped!=='boolean')fail('INVALID_CAMPAIGN');
  list.push(guard('VERSION_CONFLICT','?=COALESCE((SELECT MAX(version) FROM world_gold_campaigns),0)+1',cmd.version),st(db,`INSERT INTO world_gold_campaigns(version,starts_ms,ends_ms,stopped,created_ms,actor) VALUES(?,?,?,?,?,?)`,cmd.version,cmd.startsMs,cmd.endsMs,Number(cmd.stopped),now,wallet));
 }else if(cmd.action==='control'){
  if(!['topup','service','mint'].includes(cmd.feature)||typeof cmd.enabled!=='boolean'||!Number.isSafeInteger(cmd.version))fail('INVALID_CONTROL');
  if(cmd.feature==='service'&&cmd.enabled&&args.serviceReady!==true)fail('SERVICE_DELIVERY_UNAVAILABLE');
  list.push(guard('VERSION_CONFLICT','EXISTS(SELECT 1 FROM world_gold_controls WHERE feature=? AND version=?)',cmd.feature,cmd.version),st(db,'UPDATE world_gold_controls SET enabled=?,version=version+1 WHERE feature=? AND version=? RETURNING feature',Number(cmd.enabled),cmd.feature,cmd.version));
 }else if(cmd.action==='repair-topup'){list.push(guard('REPAIR_NOT_ENTITLED',"EXISTS(SELECT 1 FROM world_gold_links l JOIN economy_orders o ON o.id=l.order_id WHERE o.id=? AND l.kind='topup' AND o.status='paid')",cmd.orderId),credit(db,cmd.orderId,'topup',now),st(db,"DELETE FROM world_gold_reconcile_errors WHERE order_id=? AND EXISTS(SELECT 1 FROM world_gold_links l WHERE l.order_id=world_gold_reconcile_errors.order_id AND l.gold<=COALESCE((SELECT SUM(delta) FROM world_gold_entries WHERE order_id=l.order_id AND kind='topup'),0))",cmd.orderId));}
 else if(cmd.action==='refund-service'){list.push(guard('REFUND_NOT_ENTITLED',"EXISTS(SELECT 1 FROM world_gold_jobs WHERE order_id=? AND state IN ('failed','refunded'))",cmd.orderId),credit(db,cmd.orderId,'service-refund',now),st(db,`UPDATE world_gold_jobs SET state='refunded',updated_ms=? WHERE order_id=? AND state='failed' AND EXISTS(SELECT 1 FROM world_gold_entries e JOIN world_gold_links l ON l.order_id=e.order_id WHERE e.order_id=world_gold_jobs.order_id AND e.reference='service-refund:'||l.order_id||':'||CAST(l.gold AS TEXT))`,now,cmd.orderId),st(db,"DELETE FROM world_gold_reconcile_errors WHERE order_id=? AND EXISTS(SELECT 1 FROM world_gold_jobs WHERE order_id=world_gold_reconcile_errors.order_id AND state='refunded')",cmd.orderId));}
 else fail('UNKNOWN_ACTION');
 list.push(audit,st(db,'DELETE FROM world_gold_write_checks'));
 try{const results=await db.batch(list);return {id,results:results.map(r=>r.meta.changes??0)};}
 catch(error){
  // Only our own accepted=1 CHECK invokes business-guard classification.
  // Reuse its identical predicate; a genuine D1/storage fault remains503.
  if(writeGuardFailed(error))for(const g of guards)if(!await st(db,'SELECT 1 WHERE '+g.sql,...g.values).first())fail(g.code);
  throw error;
 }
}
