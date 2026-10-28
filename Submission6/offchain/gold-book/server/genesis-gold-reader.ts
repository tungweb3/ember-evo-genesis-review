import {keccak256,toHex} from 'viem';
import type {MintProof,MintProofReader,StoredMintBinding} from './world-gold.ts';
import {GENESIS_R5_AUTH_SCHEMA,GENESIS_MAX_TTL_S,type GenesisDeployment} from './genesis-gold.ts';
// Finalized-chain reader for Genesis paid orders. Every fact comes from one finalized block of the pinned deployment
// (chain id, runtime code hash); a missing, malformed or inconsistent answer throws, and reconcileHeldMintGold keeps the
// order held. Wall-clock time, a wallet's "confirmed" or a caller's word never settles anything.

export type JsonRpc=(method:string,params:unknown[])=>Promise<unknown>;
export const GENESIS_RPC_METHODS=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getLogs','eth_getTransactionReceipt']);
/** A test chain's RPC request gives up after this long, so a hanging endpoint cannot hold up the cron. */
export const GENESIS_RPC_TIMEOUT_MS=8000;
/** Plain JSON-RPC over fetch with a method allow-list. Any transport or RPC error (a timeout, a non-2xx reply too) is
 *  MINT_CHAIN_UNAVAILABLE. */
export function genesisRpc(url:string,fetcher:typeof fetch=fetch):JsonRpc{
 let id=0;
 return async(method,params)=>{
  if(!GENESIS_RPC_METHODS.has(method))throw Error('RPC_METHOD_NOT_ALLOWED');
  let reply:{result?:unknown;error?:unknown};
  try{
   const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(GENESIS_RPC_TIMEOUT_MS)});
   if(!r.ok)throw Error();reply=await r.json() as typeof reply;
  }
  catch{throw Error('MINT_CHAIN_UNAVAILABLE');}
  if(reply.error!==undefined||reply.result===undefined)throw Error('MINT_CHAIN_UNAVAILABLE');
  return reply.result;
 };
}

const topic=(sig:string)=>keccak256(toHex(sig));
export const R5_TOPICS={consumed:topic('PaidOrderConsumed(bytes32,address,uint256,uint256)'),minted:topic('GenesisMinted(address,uint256,bytes32,uint8,uint8,bool,uint256)')};
const SELECTOR={tokenId:topic('paidOrderTokenId(bytes32)').slice(0,10),revoked:topic('paidOrderRevoked(bytes32)').slice(0,10)};
/** Seconds per slot of the proof-of-stake chains the search window is computed for: at most one block per slot, so
 *  blocks k apart are at least k slots apart in time. A chain not listed (a local test chain) is searched from its
 *  deploy block. If Ethereum ever shortens its slot, this table must change with it (the window would otherwise miss
 *  the order's log and the order would stay held, never be settled wrongly). */
export const GENESIS_SLOT_SECONDS:Readonly<Record<number,number>>=Object.freeze({1:12,11155111:12});
/** Margin before the order window for clock differences between the book (which checked the deadline) and the chain. */
export const GENESIS_WINDOW_MARGIN_S=120;
/** Blocks per eth_getLogs request: the World's Alchemy Free endpoint accepts at most 10 (server/economy-rpc.ts). */
export const GENESIS_LOG_BLOCK_RANGE=10;
const fail=(s:string):never=>{throw Error(s);};
type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Json:fail('MINT_CHAIN_UNAVAILABLE');
const qty=(v:unknown)=>typeof v==='string'&&/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)?BigInt(v):fail('MINT_CHAIN_UNAVAILABLE');
const h32=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-fA-F]{64}$/.test(v)?v.toLowerCase():fail('MINT_CHAIN_UNAVAILABLE');
const wordAt=(data:string,i:number)=>BigInt('0x'+data.slice(2+64*i,2+64*(i+1)));
const addrTopic=(t:string)=>/^0x0{24}[0-9a-f]{40}$/.test(t)?'0x'+t.slice(26):fail('MINT_PROOF_CONFLICT');
const hex=(n:bigint)=>'0x'+n.toString(16);

/** The blocks that can hold this order's consumption, all at or below the finalized block. The contract accepts the
 *  order only until its deadline, and the book only held it at most GENESIS_MAX_TTL_S before that deadline, so the
 *  consumption lies in [deadline - TTL - margin, deadline] in chain time. With at most one block per slot:
 *  - block `fin - floor((finTime - start) / slot) - 1` is older than `start` (the blocks after it span more than that);
 *  - from a block with timestamp t, no block later than `floor((deadline - t) / slot)` blocks on is at or before deadline.
 *  When the first guess is far older than `start` (missed slots since the order), a binary search over timestamps finds
 *  the last block before it, so the window stays about TTL / slot blocks however late the reconciliation runs. */
async function orderWindow(rpc:JsonRpc,d:GenesisDeployment,deadlineS:bigint,fin:{number:bigint;time:bigint}){
 const deploy=BigInt(d.deployBlock),slotN=GENESIS_SLOT_SECONDS[d.chainId];
 if(!slotN)return {from:deploy,to:fin.number};
 const slot=BigInt(slotN),start=deadlineS-BigInt(GENESIS_MAX_TTL_S+GENESIS_WINDOW_MARGIN_S);
 const timeOf=async(n:bigint)=>{const b=obj(await rpc('eth_getBlockByNumber',[hex(n),false]));if(qty(b.number)!==n)fail('MINT_CHAIN_UNAVAILABLE');return qty(b.timestamp);};
 if(fin.time<start)fail('MINT_CHAIN_UNAVAILABLE');
 let lo=fin.number-(fin.time-start)/slot-1n;
 if(lo<=deploy){const t=await timeOf(deploy);return {from:deploy,to:t>deadlineS?deploy:min(fin.number,deploy+(deadlineS-t)/slot)};}
 let loTime=await timeOf(lo);
 if(loTime>=start)fail('MINT_CHAIN_UNAVAILABLE');                              // the one-block-per-slot rule did not hold
 if(start-loTime>16n*slot){
  // invariant: timeOf(lo) < start <= timeOf(hi)
  let hi=min(fin.number,lo+(start-loTime+slot-1n)/slot);
  if(await timeOf(hi)<start)fail('MINT_CHAIN_UNAVAILABLE');
  while(hi-lo>1n){const mid=(lo+hi)/2n,t=await timeOf(mid);if(t<start){lo=mid;loTime=t;}else hi=mid;}
 }
 return {from:lo,to:min(fin.number,lo+(deadlineS-loTime)/slot)};
}
const min=(a:bigint,b:bigint)=>a<b?a:b;

/** hint.transactionHash (optional): where the consumption is, so no log search is needed. It is verified like a found
 *  log. logBlockRange: blocks per eth_getLogs request (the provider's limit). */
export function createGenesisR5Reader(d:GenesisDeployment,rpc:JsonRpc,hint:{transactionHash?:string}={},logBlockRange=GENESIS_LOG_BLOCK_RANGE):MintProofReader{
 const contract=d.contract.toLowerCase();
 if(!Number.isSafeInteger(logBlockRange)||logBlockRange<1)fail('MINT_CHAIN_UNAVAILABLE');
 // The runtime code at a block is fixed by that block's hash, so one reader (one cron page) fetches and hashes the
 // ~24 KB bytecode once per finalized block instead of once per order (review 2026-10-28: the cron's 50 ms CPU limit).
 let codeVerifiedAt='';
 return {chainId:d.chainId,contract,chainInstance:d.id,async read(m:StoredMintBinding):Promise<MintProof>{
  if(m.chainId!==d.chainId||m.contract!==contract||m.chainInstance!==d.id)fail('MINT_SCOPE_MISMATCH');
  const auth=obj(m.auth),order=obj(auth.order);
  if(auth.schema!==GENESIS_R5_AUTH_SCHEMA||auth.deploymentId!==d.id||auth.codeHash!==d.codeHash||order.orderId!==m.id||order.wallet!==m.wallet||order.goldCost!==m.gold
   ||typeof order.deadline!=='string'||BigInt(order.deadline)*1000n!==BigInt(m.deadline))fail('MINT_PROOF_CONFLICT');
  if(qty(await rpc('eth_chainId',[]))!==BigInt(d.chainId))fail('MINT_SCOPE_MISMATCH');
  const fin=obj(await rpc('eth_getBlockByNumber',['finalized',false])),finNumber=qty(fin.number),finHash=h32(fin.hash),finTime=qty(fin.timestamp);
  const at=hex(finNumber);
  if(codeVerifiedAt!==finHash){
   const code=await rpc('eth_getCode',[contract,at]);
   if(typeof code!=='string'||code==='0x'||keccak256(code as `0x${string}`)!==d.codeHash)fail('MINT_SCOPE_MISMATCH');
   codeVerifiedAt=finHash;
  }
  const call=async(selector:string)=>{const r=await rpc('eth_call',[{to:contract,data:selector+m.id.slice(2)},at]);if(typeof r!=='string'||!/^0x[0-9a-f]{64}$/i.test(r))fail('MINT_CHAIN_UNAVAILABLE');return BigInt(r as string);};
  const tokenId=await call(SELECTOR.tokenId),revokedWord=await call(SELECTOR.revoked);
  if(revokedWord>1n)fail('MINT_CHAIN_UNAVAILABLE');
  let transactionHash:string|undefined;
  if(tokenId!==0n){
   let txHash=hint.transactionHash;
   if(!txHash){
    // Bounded search (planned before mainnet in the Genesis audit notes): only the order's own window, in requests of
    // at most logBlockRange blocks, stopping at the first one that holds the order's log.
    const w=await orderWindow(rpc,d,BigInt(order.deadline as string),{number:finNumber,time:finTime});
    for(let a=w.from;a<=w.to&&!txHash;a+=BigInt(logBlockRange)){
     const b=min(w.to,a+BigInt(logBlockRange)-1n);
     const logs=await rpc('eth_getLogs',[{address:contract,topics:[R5_TOPICS.consumed,m.id],fromBlock:hex(a),toBlock:hex(b)}]);
     if(!Array.isArray(logs))fail('MINT_CHAIN_UNAVAILABLE');
     const live=(logs as unknown[]).map(obj).filter(l=>l.removed!==true);
     if(live.length>1)fail('MINT_PROOF_CONFLICT');if(live.length===1)txHash=h32(live[0].transactionHash);
    }
    if(!txHash)fail('MINT_PROOF_CONFLICT');
   }
   const receipt=obj(await rpc('eth_getTransactionReceipt',[txHash]));
   const rBlock=qty(receipt.blockNumber),rHash=h32(receipt.blockHash);
   // Not receipt.to: a Safe, an ERC-4337 bundle or an EIP-7702 batch calls the contract from inside its own transaction
   // (Genesis audit 2026-10-27, finding 2). The logs below are checked by their emitting address instead.
   if(qty(receipt.status)!==1n||rBlock>finNumber)fail('MINT_PROOF_CONFLICT');
   if(h32(obj(await rpc('eth_getBlockByNumber',[hex(rBlock),false])).hash)!==rHash)fail('MINT_PROOF_CONFLICT');
   const own=(Array.isArray(receipt.logs)?receipt.logs as unknown[]:[]).map(obj).filter(l=>String(l.address).toLowerCase()===contract&&l.removed!==true);
   const topics=(l:Json)=>Array.isArray(l.topics)?(l.topics as unknown[]).map(h32):[];
   const consumed=own.filter(l=>topics(l)[0]===R5_TOPICS.consumed&&topics(l)[1]===m.id);
   // A transaction may mint several tokens (a batch, a bundle, a free mint next to the paid one): take this order's own
   // GenesisMinted, the one for this wallet and token id.
   const tokenTopic='0x'+tokenId.toString(16).padStart(64,'0');
   const minted=own.filter(l=>{const t=topics(l);return t[0]===R5_TOPICS.minted&&t[2]===tokenTopic&&t[1]!==undefined&&addrTopic(t[1])===m.wallet;});
   if(consumed.length!==1||minted.length!==1)fail('MINT_PROOF_CONFLICT');
   const c=topics(consumed[0]),g=topics(minted[0]),cData=String(consumed[0].data),gData=String(minted[0].data);
   if(!/^0x[0-9a-f]{64}$/i.test(cData)||!/^0x[0-9a-f]{256}$/i.test(gData)||c.length!==4||g.length!==4)fail('MINT_PROOF_CONFLICT');
   // PaidOrderConsumed(orderId, wallet, tokenId; goldCost) and GenesisMinted(wallet, tokenId, lookKey; choice, skin, paid, cost)
   if(addrTopic(c[2])!==m.wallet||BigInt(c[3])!==tokenId||wordAt(cData,0)!==BigInt(m.gold)
    ||addrTopic(g[1])!==m.wallet||BigInt(g[2])!==tokenId||g[3]!==order.lookKey||wordAt(gData,0)!==BigInt(order.choice as number)
    ||wordAt(gData,2)!==1n||wordAt(gData,3)!==BigInt(order.embeoCost as string))fail('MINT_PROOF_CONFLICT');
   transactionHash=h32(receipt.transactionHash??txHash);
  }
  // The finalized block must still be the one every read above used.
  if(h32(obj(await rpc('eth_getBlockByNumber',[at,false])).hash)!==finHash)fail('MINT_CHAIN_UNAVAILABLE');
  return {schema:'ember-mint-proof-v1',mode:'finalized-chain',orderId:m.id,wallet:m.wallet,gold:m.gold,chainId:d.chainId,contract,chainInstance:d.id,
   blockHash:finHash,blockNumber:String(finNumber),chainTimeMs:Number(finTime)*1000,tokenId:String(tokenId),revoked:revokedWord===1n,...transactionHash?{transactionHash}:{}};
 }};
}
