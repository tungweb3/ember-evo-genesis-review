import type {D1Database} from './d1.ts';
import {recoverTypedDataAddress} from 'viem';
import {economyAddress,economyDigest} from './economy-config.ts';
import {reserveMintGold,storedMintGold,goldBalanceStatement,goldBalanceView,reconcileHeldMintGold,type MintProofReader,type StoredMintBinding} from './world-gold.ts';
import {requireWorldGoldSchema} from './world-gold-schema.ts';
// Genesis paid mint <-> shared GOLD book. The Genesis signer calls these through a same-account service binding
// (worker/index.ts GenesisGold); there is no public URL. Costs come from the pinned deployment registry, never from the
// caller, and a hold needs the wallet's own EIP-712 consent to exactly this order: a service credential is not consent.
// Settlement stays with reconcileHeldMintGold and a finalized-chain reader (genesis-gold-reader.ts); no caller can
// declare an order consumed or released.
// Ported 2026-10-28 from the Sepolia rehearsal book (Genesis audits 31bb373a, 388b71cb, d726b1cd, b0b1d96a reviewed it
// there as secondary scope). Difference: every registry entry names its domain version and payment recipient; there is
// no default (the rehearsal defaulted to version 5 and the burn address for its first deployments).

/** v2 (Genesis audit 944905c3, 2026-10-29): the order names the payment token. No v1 hold exists in production. */
export const GENESIS_R5_AUTH_SCHEMA='genesis-r5-paid-v2';
/** The contract's EIP-712 domain name; the version is each deployment's own (registry domainVersion). */
export const GENESIS_DOMAIN_NAME='EmberEvoGenesisCandidate';
/** Longest authorization window a hold accepts (seconds from now to the order deadline). The chain reader relies on it:
 *  an order can only be consumed in the GENESIS_MAX_TTL_S seconds before its deadline. */
export const GENESIS_MAX_TTL_S=900;
/** A deployment the book accepts orders for. id is the persistent chainInstance stored with every hold.
 *  domainVersion: the contract's EIP-712 domain version, written into every hold's document (Genesis audit 2026-10-27,
 *  finding 10). recipient: the contract's immutable paymentRecipient (the treasury Safe on mainnet). embeoCost: the
 *  contract's paidCost, the dollar price in 18 decimals (named before the token became imdUSD); the contract signs it and
 *  reports it in GenesisMinted.cost whichever token paid (20 USDC = 20e6 is charged, 20e18 is reported), so one value
 *  serves every token (World audit 8febfeed finding 1 read the single-token Submission5 contract, which reported the
 *  amount paid). paymentToken / goldCost / paymentAmount: the deployment's payment token (imdUSD v1), its GOLD price
 *  and the exact amount mintPaid charges in its smallest unit (paymentTokens(token): low 128 bits);
 *  addedTokens: the tokens added with addPaymentToken with their GOLD prices and amounts (owner 2026-10-29: USDC 1,600
 *  GOLD for 20000000, imdUSD v2 1,200; imdUSD is the discounted price), at most two. The reader settles an order only on
 *  a Transfer of exactly that amount (World audit 93dae57f finding 1). The order names its token (Genesis audit 944905c3,
 *  finding 1) and the contract's PaidAuthorization binds it, so an order is held only at the price listed for that
 *  token and is payable only in it. All are read back from the deployed contract before an entry is added. */
export type GenesisDeployment={id:string;environment:'production'|'sepolia'|'local';chainId:number;contract:string;codeHash:string;
 deployBlock:string;embeoCost:string;paymentToken:string;goldCost:string;paymentAmount:string;addedTokens:readonly {token:string;goldCost:string;amount:string}[];signer:string;
 domainVersion:string;recipient:string};
export type GenesisOrder={orderId:string;wallet:string;lookKey:string;choice:number;uriHash:string;recipient:string;token:string;embeoCost:string;
 goldCost:string;deadline:string;signerEpoch:string};
export const GOLD_CONSENT_TYPES={GenesisGoldHold:[{name:'orderId',type:'bytes32'},{name:'wallet',type:'address'},{name:'goldCost',type:'uint256'},
 {name:'genesis',type:'address'},{name:'token',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},
 {name:'embeoCost',type:'uint256'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]} as const;
/** What the wallet signs before any GOLD is held: domain "Ember World GOLD" v1 on the deployment's own chain. */
export const goldConsentDomain=(d:GenesisDeployment)=>({name:'Ember World GOLD',version:'1',chainId:d.chainId});
export const goldConsentMessage=(d:GenesisDeployment,o:GenesisOrder)=>({orderId:o.orderId as `0x${string}`,wallet:o.wallet as `0x${string}`,
 goldCost:BigInt(o.goldCost),genesis:d.contract as `0x${string}`,token:o.token as `0x${string}`,lookKey:o.lookKey as `0x${string}`,choice:o.choice,uriHash:o.uriHash as `0x${string}`,
 embeoCost:BigInt(o.embeoCost),deadline:BigInt(o.deadline),signerEpoch:BigInt(o.signerEpoch)});

const fail=(s:string):never=>{throw Error(s);};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const word=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const dec=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v);
const ORDER_KEYS=['orderId','wallet','lookKey','choice','uriHash','recipient','token','embeoCost','goldCost','deadline','signerEpoch'];

/** A registry entry in the one form every comparison uses: addresses and the code hash lowercase (an EIP-55 address
 *  copied from an explorer would otherwise make retries conflict and the reader never match). A malformed entry is
 *  refused, never guessed at. */
export function pinnedDeployment(d:GenesisDeployment):GenesisDeployment{
 const lowAddr=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)?v.toLowerCase():fail('MINT_DEPLOYMENT_INVALID');
 const codeHash=typeof d.codeHash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(d.codeHash)?d.codeHash.toLowerCase():fail('MINT_DEPLOYMENT_INVALID');
 const paymentToken=lowAddr(d.paymentToken);
 // at most two added tokens, each a distinct token other than paymentToken, each with a positive GOLD price and amount
 const added=Array.isArray(d.addedTokens)&&d.addedTokens.length<=2?d.addedTokens.map(t=>record(t)&&exact(t,['token','goldCost','amount'])&&dec(t.goldCost)&&t.goldCost!=='0'
  &&dec(t.amount)&&t.amount!=='0'?{token:lowAddr(t.token),goldCost:t.goldCost as string,amount:t.amount as string}:fail('MINT_DEPLOYMENT_INVALID')):fail('MINT_DEPLOYMENT_INVALID');
 if(added.some((t,i)=>t.token===paymentToken||added.findIndex(u=>u.token===t.token)!==i))fail('MINT_DEPLOYMENT_INVALID');
 if(!dec(d.deployBlock)||!dec(d.embeoCost)||!dec(d.goldCost)||d.goldCost==='0'||!dec(d.paymentAmount)||d.paymentAmount==='0'||typeof d.domainVersion!=='string'||!/^[0-9]{1,8}$/.test(d.domainVersion)
  ||!Number.isSafeInteger(d.chainId)||d.chainId<1)fail('MINT_DEPLOYMENT_INVALID');
 return {...d,paymentToken,addedTokens:added,contract:lowAddr(d.contract),codeHash,recipient:lowAddr(d.recipient),signer:lowAddr(d.signer)};
}
/** The deployments of this environment only: a Sepolia Worker never sees mainnet entries and the reverse. */
export function genesisDeployment(list:readonly GenesisDeployment[],environment:string,id:unknown):GenesisDeployment{
 const d=list.find(x=>x.id===id&&x.environment===environment);if(!d)fail('MINT_DEPLOYMENT_UNKNOWN');return pinnedDeployment(d!);
}
/** The GOLD price this deployment lists for a payment token, or undefined for a token it does not list. */
export function genesisTokenGoldCost(d:GenesisDeployment,token:string){
 return token===d.paymentToken?d.goldCost:d.addedTokens.find(t=>t.token===token)?.goldCost;
}
/** The exact amount (smallest unit) mintPaid charges in a payment token, or undefined for a token it does not list. */
export function genesisTokenAmount(d:GenesisDeployment,token:string){
 return token===d.paymentToken?d.paymentAmount:d.addedTokens.find(t=>t.token===token)?.amount;
}
/** Every field fixed and normalized, in one key order, so a retry stores byte-identical JSON. prices=false (an
 *  identical retry of a stored order, World audit 8febfeed finding 4) skips the registry's price, recipient and cost
 *  check: the caller compares the result byte for byte with the order that passed it when it was first held. */
function parseOrder(d:GenesisDeployment,v:unknown,nowMs:number,prices=true):GenesisOrder{
 if(!record(v)||!exact(v,ORDER_KEYS))fail('INVALID_MINT_AUTH');const o=v as Record<string,unknown>;
 let wallet='',recipient='',token='';try{wallet=economyAddress(o.wallet);recipient=economyAddress(o.recipient);token=economyAddress(o.token);}catch{fail('INVALID_MINT_AUTH');}
 if(!word(o.orderId)||o.orderId==='0x'+'0'.repeat(64)||!word(o.lookKey)||o.lookKey==='0x'+'0'.repeat(64)||!word(o.uriHash)
  ||!Number.isInteger(o.choice)||(o.choice as number)<0||(o.choice as number)>3||!dec(o.embeoCost)||!dec(o.goldCost)||!dec(o.deadline)||!dec(o.signerEpoch)||o.signerEpoch==='0')fail('INVALID_MINT_AUTH');
 if(prices&&(recipient!==economyAddress(d.recipient)||o.embeoCost!==d.embeoCost||o.goldCost!==genesisTokenGoldCost(d,token)))fail('MINT_PRICE_MISMATCH');
 const deadlineS=Number(o.deadline);
 if(!Number.isSafeInteger(deadlineS*1000)||deadlineS*1000<=nowMs)fail('MINT_AUTH_EXPIRED');
 if(deadlineS*1000-nowMs>GENESIS_MAX_TTL_S*1000)fail('INVALID_MINT_AUTH');
 return {orderId:o.orderId as string,wallet,lookKey:o.lookKey as string,choice:o.choice as number,uriHash:o.uriHash as string,recipient,token,
  embeoCost:o.embeoCost as string,goldCost:o.goldCost as string,deadline:o.deadline as string,signerEpoch:o.signerEpoch as string};
}
/** The stored auth document (world-gold-result.ts checks it against the typed binding). */
export function genesisAuthDocument(d:GenesisDeployment,o:GenesisOrder,consentSignature:string){
 return {schema:GENESIS_R5_AUTH_SCHEMA,deploymentId:d.id,codeHash:d.codeHash,
  domain:{name:GENESIS_DOMAIN_NAME,version:d.domainVersion,chainId:d.chainId,verifyingContract:d.contract},
  order:{orderId:o.orderId,wallet:o.wallet,lookKey:o.lookKey,choice:o.choice,uriHash:o.uriHash,recipient:o.recipient,token:o.token,embeoCost:o.embeoCost,
   goldCost:o.goldCost,deadline:o.deadline,signerEpoch:o.signerEpoch},
  consent:{signature:consentSignature}};
}
const withoutConsent=(json:string)=>{const doc=JSON.parse(json) as Record<string,unknown>;delete doc.consent;return JSON.stringify(doc);};
async function view(db:D1Database,row:StoredMintBinding,auth:unknown){
 const balance=goldBalanceView(await goldBalanceStatement(db,row.wallet).first<{book:string;reserved:string}>());
 return {orderId:row.id,state:row.state,bindingDigest:await economyDigest(JSON.stringify(auth)),...balance};
}

export type GenesisReserveRequest={deploymentId:string;order:GenesisOrder;consentSignature:string};
/** Holds goldCost for one order after verifying the wallet's consent. Retrying the same order returns its current
 *  state (held, consumed or released) instead of holding twice; the same orderId with any other content conflicts. */
export async function reserveGenesisGold(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,req:unknown,nowMs:number,now:()=>number=Date.now){
 await requireWorldGoldSchema(db);
 if(!record(req)||!exact(req,['deploymentId','order','consentSignature']))fail('INVALID_MINT_AUTH');
 const r=req as Record<string,unknown>,d=genesisDeployment(deployments,environment,r.deploymentId);
 const sig=r.consentSignature;if(typeof sig!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(sig))fail('INVALID_GOLD_CONSENT');
 const existing=await storedMintGold(db,record(r.order)&&typeof r.order.orderId==='string'?r.order.orderId:'').catch(()=>null);
 if(existing){
  // An identical retry (any valid consent signature of the same wallet) is answered from the stored order, so a lost
  // response never causes a second hold. Validation of the stored order happened when it was first held, so a later
  // registry edit never turns an identical retry into MINT_PRICE_MISMATCH (World audit 8febfeed finding 4).
  const o=parseOrder(d,r.order,Math.min(nowMs,existing.deadline-1),false);
  const sameScope=existing.chainInstance===d.id&&existing.chainId===d.chainId&&existing.contract===d.contract;
  const auth=genesisAuthDocument(d,o,sig as string),stored=JSON.stringify(existing.auth);
  if(!sameScope||withoutConsent(stored)!==withoutConsent(JSON.stringify(auth)))fail('MINT_ORDER_CONFLICT');
  await verifyConsent(d,o,sig as string);
  return view(db,existing,existing.auth);
 }
 const o=parseOrder(d,r.order,nowMs);await verifyConsent(d,o,sig as string);
 const auth=genesisAuthDocument(d,o,sig as string);
 await reserveMintGold(db,{id:o.orderId,wallet:o.wallet,auth,gold:o.goldCost,chainId:d.chainId,contract:d.contract,chainInstance:d.id,deadline:Number(o.deadline)*1000,
  domainVersion:d.domainVersion,recipient:economyAddress(d.recipient)},nowMs,now);
 return view(db,await storedMintGold(db,o.orderId),auth);
}
async function verifyConsent(d:GenesisDeployment,o:GenesisOrder,signature:string){
 let signer='';
 try{signer=await recoverTypedDataAddress({domain:goldConsentDomain(d),types:GOLD_CONSENT_TYPES,primaryType:'GenesisGoldHold',message:goldConsentMessage(d,o),signature:signature as `0x${string}`});}
 catch{fail('INVALID_GOLD_CONSENT');}
 if(signer.toLowerCase()!==o.wallet)fail('INVALID_GOLD_CONSENT');
}

/** State of one order of this deployment, with the wallet's GOLD balance (book, reserved, available) that the signer
 *  shows on the Mint page; the consent signature is never returned (World audit 8febfeed finding 6: the comment used to
 *  say no wallet data was returned). */
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

/** Held orders one cron run reads per deployment. Small, so the Genesis step stays well inside the scheduled
 *  invocation's CPU and subrequest limits it shares with the World's own GOLD work (review 2026-10-28). It counts
 *  orders, sized for the worst one: a consumed order found by log search costs about 35-41 RPC calls (window binary
 *  search, up to 11 eth_getLogs of GENESIS_LOG_BLOCK_RANGE blocks, receipt, blocks), an order never paid about 5-6
 *  (chain id, finalized block, code once per block, two eth_call, final block). With the GOLD step on the every-minute
 *  trigger that is at most 8 releases per deployment per minute, about 480 an hour (World audit e3e9b712 finding 4). */
export const GENESIS_CRON_PAGE=8;
/** Cron: one bounded page of held orders per deployment, resuming from a persisted cursor so later orders are never
 *  starved by earlier ones that stay pending. The page is this deployment's own held orders (World audit 8febfeed
 *  finding 3: the locked reconcileHeldMintGold pages every held mint, so it is called once per id here). A deployment
 *  that fails (a malformed entry, storage) is reported by its code and never stops the others. */
export async function reconcileGenesisDeployments(db:D1Database,deployments:readonly GenesisDeployment[],environment:string,reader:GenesisReaderFactory,nowMs:number,limit=GENESIS_CRON_PAGE){
 const out:{deployment:string;outcomes:{id:string;status:string}[];failed?:string}[]=[];
 for(const entry of deployments.filter(x=>x.environment===environment)){
  try{
   const d=pinnedDeployment(entry);
   const at=await db.prepare('SELECT after FROM genesis_gold_cursors WHERE deployment=?').bind(d.id).first<{after:string}>();
   if(!Number.isInteger(limit)||limit<1||limit>32)fail('INVALID_RECONCILIATION_LIMIT');
   // One row more than the page, so a full page knows whether anything follows it (World audit e3e9b712 finding 2:
   // an exact multiple of the page used to cost one empty run per cycle).
   const page=await db.prepare("SELECT id FROM world_gold_mints WHERE state='held' AND chain_instance=? AND chain_id=? AND contract=? AND id>? ORDER BY id LIMIT ?")
    .bind(d.id,d.chainId,d.contract,at?.after??'',limit+1).all<{id:string}>();
   const more=page.results.length>limit,ids=page.results.slice(0,limit).map(x=>x.id),read=reader(d,{}),outcomes:{id:string;status:string}[]=[];
   for(const id of ids)outcomes.push(...(await reconcileHeldMintGold(db,read,nowMs,{orderId:id})).outcomes);
   await db.prepare('INSERT INTO genesis_gold_cursors(deployment,after,updated_ms) VALUES(?,?,?) ON CONFLICT(deployment) DO UPDATE SET after=excluded.after,updated_ms=excluded.updated_ms')
    .bind(d.id,more?ids.at(-1)!:'',nowMs).run();
   // Every outcome is kept: the page is this deployment's own, so MINT_SCOPE_MISMATCH can only come from the reader (the
   // RPC on another chain, or code that does not hash to the registry's codeHash) and must be seen (World audit e3e9b712
   // finding 1: it was filtered out and the run left no trace).
   out.push({deployment:d.id,outcomes});
  }catch(error){
   out.push({deployment:String(entry.id),outcomes:[],failed:error instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)?error.message:'GENESIS_GOLD_FAILED'});
  }
 }
 return out;
}
