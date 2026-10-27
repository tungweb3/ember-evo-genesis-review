import type {D1Database} from './d1.ts';
import {recoverTypedDataAddress} from 'viem';
import {economyAddress,economyDigest} from './economy-config.ts';
import {reserveMintGold,storedMintGold,goldBalanceStatement,goldBalanceView,reconcileHeldMintGold,type MintProofReader,type StoredMintBinding} from './world-gold.ts';
import {requireWorldGoldSchema} from './world-gold-schema.ts';
// Genesis R5 paid mint <-> shared GOLD book. The Genesis signer calls these through a same-account service binding
// (worker/index.ts GenesisGold); there is no public URL. Costs come from the pinned deployment registry, never from the
// caller, and a hold needs the wallet's own EIP-712 consent to exactly this order: a service credential is not consent.
// Settlement stays with reconcileHeldMintGold and a finalized-chain reader (genesis-gold-reader.ts); no caller can
// declare an order consumed or released.

export const GENESIS_R5_AUTH_SCHEMA='genesis-r5-paid-v1';
/** version: the default for registry entries without domainVersion (the stored document of their holds stays as it was). */
export const GENESIS_R5_DOMAIN={name:'EmberEvoGenesisCandidate',version:'5'} as const;
export const GENESIS_DEAD='0x000000000000000000000000000000000000dead';
/** Longest authorization window a hold accepts (seconds from now to the R5 deadline). */
export const GENESIS_MAX_TTL_S=900;
/** A deployment the book accepts orders for. id is the persistent chainInstance stored with every hold. */
/** domainVersion: the contract's EIP-712 domain version, written into every hold's document (Genesis audit 2026-10-27,
 *  finding 10: a stale constant made the stored domain differ from the one the contract verifies). */
export type GenesisDeployment={id:string;environment:'production'|'sepolia'|'local';chainId:number;contract:string;codeHash:string;
 deployBlock:string;embeoCost:string;goldCost:string;signer:string;domainVersion?:string};
export type GenesisOrder={orderId:string;wallet:string;lookKey:string;choice:number;uriHash:string;recipient:string;embeoCost:string;
 goldCost:string;deadline:string;signerEpoch:string};
export const GOLD_CONSENT_TYPES={GenesisGoldHold:[{name:'orderId',type:'bytes32'},{name:'wallet',type:'address'},{name:'goldCost',type:'uint256'},
 {name:'genesis',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},
 {name:'embeoCost',type:'uint256'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]} as const;
/** What the wallet signs before any GOLD is held: domain "Ember World GOLD" v1 on the deployment's own chain. */
export const goldConsentDomain=(d:GenesisDeployment)=>({name:'Ember World GOLD',version:'1',chainId:d.chainId});
export const goldConsentMessage=(d:GenesisDeployment,o:GenesisOrder)=>({orderId:o.orderId as `0x${string}`,wallet:o.wallet as `0x${string}`,
 goldCost:BigInt(o.goldCost),genesis:d.contract as `0x${string}`,lookKey:o.lookKey as `0x${string}`,choice:o.choice,uriHash:o.uriHash as `0x${string}`,
 embeoCost:BigInt(o.embeoCost),deadline:BigInt(o.deadline),signerEpoch:BigInt(o.signerEpoch)});

const fail=(s:string):never=>{throw Error(s);};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const word=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const dec=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v);
const ORDER_KEYS=['orderId','wallet','lookKey','choice','uriHash','recipient','embeoCost','goldCost','deadline','signerEpoch'];

/** The deployments of this environment only: a Sepolia Worker never sees mainnet entries and the reverse. */
export function genesisDeployment(list:readonly GenesisDeployment[],environment:string,id:unknown):GenesisDeployment{
 const d=list.find(x=>x.id===id&&x.environment===environment);if(!d)fail('MINT_DEPLOYMENT_UNKNOWN');return d!;
}
/** Every field fixed and normalized, in one key order, so a retry stores byte-identical JSON. */
function parseOrder(d:GenesisDeployment,v:unknown,nowMs:number):GenesisOrder{
 if(!record(v)||!exact(v,ORDER_KEYS))fail('INVALID_MINT_AUTH');const o=v as Record<string,unknown>;
 let wallet='',recipient='';try{wallet=economyAddress(o.wallet);recipient=economyAddress(o.recipient);}catch{fail('INVALID_MINT_AUTH');}
 if(!word(o.orderId)||o.orderId==='0x'+'0'.repeat(64)||!word(o.lookKey)||o.lookKey==='0x'+'0'.repeat(64)||!word(o.uriHash)
  ||!Number.isInteger(o.choice)||(o.choice as number)<0||(o.choice as number)>3||!dec(o.embeoCost)||!dec(o.goldCost)||!dec(o.deadline)||!dec(o.signerEpoch)||o.signerEpoch==='0')fail('INVALID_MINT_AUTH');
 if(recipient!==GENESIS_DEAD||o.embeoCost!==d.embeoCost||o.goldCost!==d.goldCost)fail('MINT_PRICE_MISMATCH');
 const deadlineS=Number(o.deadline);
 if(!Number.isSafeInteger(deadlineS*1000)||deadlineS*1000<=nowMs)fail('MINT_AUTH_EXPIRED');
 if(deadlineS*1000-nowMs>GENESIS_MAX_TTL_S*1000)fail('INVALID_MINT_AUTH');
 return {orderId:o.orderId as string,wallet,lookKey:o.lookKey as string,choice:o.choice as number,uriHash:o.uriHash as string,recipient,
  embeoCost:o.embeoCost as string,goldCost:o.goldCost as string,deadline:o.deadline as string,signerEpoch:o.signerEpoch as string};
}
/** The stored auth document (world-gold-result.ts checks it against the typed binding). */
export function genesisAuthDocument(d:GenesisDeployment,o:GenesisOrder,consentSignature:string){
 return {schema:GENESIS_R5_AUTH_SCHEMA,deploymentId:d.id,codeHash:d.codeHash,
  domain:{name:GENESIS_R5_DOMAIN.name,version:d.domainVersion??GENESIS_R5_DOMAIN.version,chainId:d.chainId,verifyingContract:d.contract},
  order:{orderId:o.orderId,wallet:o.wallet,lookKey:o.lookKey,choice:o.choice,uriHash:o.uriHash,recipient:o.recipient,embeoCost:o.embeoCost,
   goldCost:o.goldCost,deadline:o.deadline,signerEpoch:o.signerEpoch},
  consent:{signature:consentSignature}};
}
const withoutConsent=(json:string)=>{const doc=JSON.parse(json) as Record<string,unknown>;delete doc.consent;return JSON.stringify(doc);};
async function view(db:D1Database,row:StoredMintBinding,auth:unknown){
 const balance=goldBalanceView(await goldBalanceStatement(db,row.wallet).first<{book:string;reserved:string}>());
 return {orderId:row.id,state:row.state,bindingDigest:await economyDigest(JSON.stringify(auth)),...balance};
}

export type GenesisReserveRequest={deploymentId:string;order:GenesisOrder;consentSignature:string};
/** Holds goldCost for one R5 order after verifying the wallet's consent. Retrying the same order returns its current
 *  state (held, consumed or released) instead of holding twice; the same orderId with any other content conflicts. */
export async function reserveGenesisGold(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,req:unknown,nowMs:number,now:()=>number=Date.now){
 await requireWorldGoldSchema(db);
 if(!record(req)||!exact(req,['deploymentId','order','consentSignature']))fail('INVALID_MINT_AUTH');
 const r=req as Record<string,unknown>,d=genesisDeployment(deployments,environment,r.deploymentId);
 const sig=r.consentSignature;if(typeof sig!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(sig))fail('INVALID_GOLD_CONSENT');
 const existing=await storedMintGold(db,record(r.order)&&typeof r.order.orderId==='string'?r.order.orderId:'').catch(()=>null);
 if(existing){
  // An identical retry (any valid consent signature of the same wallet) is answered from the stored order, so a lost
  // response never causes a second hold. Validation of the stored order happened when it was first held.
  const o=parseOrder(d,r.order,Math.min(nowMs,existing.deadline-1));
  const sameScope=existing.chainInstance===d.id&&existing.chainId===d.chainId&&existing.contract===d.contract;
  const auth=genesisAuthDocument(d,o,sig as string),stored=JSON.stringify(existing.auth);
  if(!sameScope||withoutConsent(stored)!==withoutConsent(JSON.stringify(auth)))fail('MINT_ORDER_CONFLICT');
  await verifyConsent(d,o,sig as string);
  return view(db,existing,existing.auth);
 }
 const o=parseOrder(d,r.order,nowMs);await verifyConsent(d,o,sig as string);
 const auth=genesisAuthDocument(d,o,sig as string);
 await reserveMintGold(db,{id:o.orderId,wallet:o.wallet,auth,gold:o.goldCost,chainId:d.chainId,contract:d.contract,chainInstance:d.id,deadline:Number(o.deadline)*1000},nowMs,now);
 return view(db,await storedMintGold(db,o.orderId),auth);
}
async function verifyConsent(d:GenesisDeployment,o:GenesisOrder,signature:string){
 let signer='';
 try{signer=await recoverTypedDataAddress({domain:goldConsentDomain(d),types:GOLD_CONSENT_TYPES,primaryType:'GenesisGoldHold',message:goldConsentMessage(d,o),signature:signature as `0x${string}`});}
 catch{fail('INVALID_GOLD_CONSENT');}
 if(signer.toLowerCase()!==o.wallet)fail('INVALID_GOLD_CONSENT');
}

/** State of one order of this deployment (no consent signature or other wallet data is returned). */
export async function genesisGoldOrder(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,req:unknown){
 if(!record(req)||!exact(req,['deploymentId','orderId'])||!word(req.orderId))fail('INVALID_MINT_AUTH');
 const r=req as Record<string,unknown>,d=genesisDeployment(deployments,environment,r.deploymentId),row=await storedMintGold(db,r.orderId as string);
 if(row.chainInstance!==d.id)fail('MINT_ORDER_MISSING');
 return view(db,row,row.auth);
}

export type GenesisReaderFactory=(d:GenesisDeployment,hint:{transactionHash?:string})=>MintProofReader;
/** Asks the book to settle one order from finalized chain facts. A chain failure leaves it held ('pending'). */
export async function reconcileGenesisGold(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,reader:GenesisReaderFactory,req:unknown,nowMs:number){
 if(!record(req)||!(exact(req,['deploymentId','orderId'])||exact(req,['deploymentId','orderId','transactionHash']))||!word(req.orderId)
  ||(req.transactionHash!==undefined&&!word(req.transactionHash)))fail('INVALID_MINT_AUTH');
 const q=req as Record<string,unknown>,d=genesisDeployment(deployments,environment,q.deploymentId),row=await storedMintGold(db,q.orderId as string);
 if(row.chainInstance!==d.id)fail('MINT_ORDER_MISSING');
 let status=row.state;
 if(row.state==='held'){const r=await reconcileHeldMintGold(db,reader(d,{transactionHash:q.transactionHash as string|undefined}),nowMs,{orderId:row.id});status=r.outcomes[0]?.status??'pending';}
 const latest=await storedMintGold(db,row.id);
 return {orderId:row.id,state:latest.state,reconciliation:latest.state==='held'?'pending':'settled',...latest.state==='held'&&status!=='pending'?{code:status}:{}};
}

/** Cron: one bounded page of held orders per deployment, resuming from a persisted cursor so later orders are never
 *  starved by earlier ones that stay pending. */
export async function reconcileGenesisDeployments(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,reader:GenesisReaderFactory,nowMs:number){
 const out:{deployment:string;outcomes:{id:string;status:string}[]}[]=[];
 for(const d of deployments.filter(x=>x.environment===environment)){
  const at=await db.prepare('SELECT after FROM genesis_gold_cursors WHERE deployment=?').bind(d.id).first<{after:string}>();
  const r=await reconcileHeldMintGold(db,reader(d,{}),nowMs,{after:at?.after??'',limit:32});
  await db.prepare('INSERT INTO genesis_gold_cursors(deployment,after,updated_ms) VALUES(?,?,?) ON CONFLICT(deployment) DO UPDATE SET after=excluded.after,updated_ms=excluded.updated_ms')
   .bind(d.id,r.next??'',nowMs).run();
  out.push({deployment:d.id,outcomes:r.outcomes.filter(o=>o.status!=='MINT_SCOPE_MISMATCH')});
 }
 return out;
}
