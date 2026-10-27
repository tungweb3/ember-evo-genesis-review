import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,toHex} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {fixture,NOW,W,account,H} from './world-gold-audit5-fixture.mjs';
import {reserveGenesisGold,genesisGoldOrder,reconcileGenesisGold,reconcileGenesisDeployments,goldConsentDomain,goldConsentMessage,GOLD_CONSENT_TYPES,GENESIS_DEAD} from '../server/genesis-gold.ts';
import {createGenesisR5Reader,R5_TOPICS} from '../server/genesis-gold-reader.ts';
import {GENESIS_DEPLOYMENTS} from '../server/genesis-deployments.ts';
import {createGenesisGoldService,PRODUCTION_GENESIS} from '../worker/app.ts';

const CODE='0x6080604052',CODE_HASH=keccak256(CODE),CONTRACT='0x'+'c'.repeat(40),EMBEO='300000000000000000000000';
const DEP={id:'sepolia-r5-test-1',environment:'sepolia',chainId:11155111,contract:CONTRACT,codeHash:CODE_HASH,deployBlock:'100',embeoCost:EMBEO,goldCost:'8',signer:'0x'+'5'.repeat(40)};
const LIST=[DEP,{...DEP,id:'mainnet-other',environment:'production',chainId:1}];
const DEADLINE=NOW/1000+300;
const order=(patch={})=>({orderId:H(0xabc),wallet:W,lookKey:H(0x1001),choice:1,uriHash:keccak256(toHex('ipfs://looks/x/1')),recipient:GENESIS_DEAD,embeoCost:EMBEO,goldCost:'8',deadline:String(DEADLINE),signerEpoch:'1',...patch});
const consent=(o,signer=account,d=DEP)=>signer.signTypedData({domain:goldConsentDomain(d),types:GOLD_CONSENT_TYPES,primaryType:'GenesisGoldHold',message:goldConsentMessage(d,o)});
const request=async(o=order(),signer=account)=>({deploymentId:DEP.id,order:o,consentSignature:await consent(o,signer)});
const reserve=(f,req,now=NOW)=>reserveGenesisGold(f.db,LIST,'sepolia',req,now,()=>now);
/** A fresh test DB's migration seeds controls that may be on; every test sets the mint control it needs explicitly. */
const mintControl=(f,enabled)=>f.admin({action:'control',feature:'mint',enabled,version:f.db.raw.prepare("SELECT version FROM world_gold_controls WHERE feature='mint'").get().version});
async function setup({open=true,topups=1}={}){
 const f=await fixture();for(let i=0;i<topups;i++)await f.topup();
 await mintControl(f,open);
 assert.equal(f.db.raw.prepare("SELECT enabled FROM world_gold_controls WHERE feature='mint'").get().enabled,open?1:0);
 return f;
}
const codeOf=async(p,c)=>{await assert.rejects(p,e=>{assert.equal(e.message,c);return true;});};

test('a wallet-consented hold reserves exactly the registry GOLD cost; a lost response retried returns the same hold',async()=>{
 const f=await setup();try{
  const req=await request(),a=await reserve(f,req);
  assert.deepEqual([a.state,a.book,a.reserved,a.available],['held','10','8','2']);
  const b=await reserve(f,req);assert.deepEqual(b,a);
  assert.deepEqual([(await f.snapshot()).reserved],['8']);
  const stored=f.db.raw.prepare('SELECT auth_json,chain_instance,deadline,amount FROM world_gold_mints WHERE id=?').get(order().orderId);
  assert.equal(stored.chain_instance,DEP.id);assert.equal(stored.deadline,DEADLINE*1000);assert.equal(stored.amount,8);
  assert.equal(JSON.parse(stored.auth_json).order.choice,1);
  const q=await genesisGoldOrder(f.db,LIST,'sepolia',{deploymentId:DEP.id,orderId:order().orderId});assert.equal(q.state,'held');assert.equal(q.bindingDigest,a.bindingDigest);
 }finally{f.close();}
});
test('the same orderId with any other content conflicts and holds nothing more',async()=>{
 const f=await setup({topups:2});try{
  await reserve(f,await request());
  for(const patch of [{choice:2},{lookKey:H(0x1002)},{uriHash:H(5)},{deadline:String(DEADLINE+1)},{signerEpoch:'2'}])
   await codeOf(reserve(f,await request(order(patch))),'MINT_ORDER_CONFLICT');
  assert.equal((await f.snapshot()).reserved,'8');
 }finally{f.close();}
});
test('consent must be the wallet’s own signature over this exact order',async()=>{
 const f=await setup();try{
  const other=privateKeyToAccount(generatePrivateKey());
  await codeOf(reserve(f,await request(order(),other)),'INVALID_GOLD_CONSENT');
  const signedOther={deploymentId:DEP.id,order:order(),consentSignature:await consent(order({choice:2}))};
  await codeOf(reserve(f,signedOther),'INVALID_GOLD_CONSENT');
  const otherChain={deploymentId:DEP.id,order:order(),consentSignature:await consent(order(),account,{...DEP,chainId:1})};
  await codeOf(reserve(f,otherChain),'INVALID_GOLD_CONSENT');
  await codeOf(reserve(f,{...await request(),consentSignature:'0x1234'}),'INVALID_GOLD_CONSENT');
  assert.equal((await f.snapshot()).reserved,'0');
 }finally{f.close();}
});
test('costs, recipient, deadline, choice and deployment come from the registry and the R5 rules, not the caller',async()=>{
 const f=await setup({topups:3});try{
  for(const [patch,code] of [[{goldCost:'7'},'MINT_PRICE_MISMATCH'],[{embeoCost:'1'},'MINT_PRICE_MISMATCH'],[{recipient:'0x'+'9'.repeat(40)},'MINT_PRICE_MISMATCH'],
   [{deadline:String(NOW/1000+901)},'INVALID_MINT_AUTH'],[{deadline:String(NOW/1000)},'MINT_AUTH_EXPIRED'],[{orderId:'0x'+'0'.repeat(64)},'INVALID_MINT_AUTH'],
   [{choice:4},'INVALID_MINT_AUTH'],[{signerEpoch:'0'},'INVALID_MINT_AUTH'],[{lookKey:'0x'+'0'.repeat(64)},'INVALID_MINT_AUTH']])
   await codeOf(reserve(f,{deploymentId:DEP.id,order:order(patch),consentSignature:await consent(order())}),code);
  await codeOf(reserve(f,{...await request(),deploymentId:'mainnet-other'}),'MINT_DEPLOYMENT_UNKNOWN');
  await codeOf(reserveGenesisGold(f.db,LIST,'production',await request(),NOW,()=>NOW),'MINT_DEPLOYMENT_UNKNOWN');
  await codeOf(reserve(f,{...await request(),extra:1}),'INVALID_MINT_AUTH');
  assert.equal((await f.snapshot()).reserved,'0');
 }finally{f.close();}
});
test('closed mint control, missing GOLD and the empty production registry all refuse; SQL text never crosses the service',async()=>{
 const f=await setup({open:false});try{
  await codeOf(reserve(f,await request()),'FEATURE_PAUSED');
  await mintControl(f,true);
  await reserve(f,await request());
  const svc=createGenesisGoldService({DB:f.db},{deployments:LIST,environment:'sepolia'},fetch,()=>NOW);
  await codeOf(svc.reserve(await request(order({orderId:H(0xabd)}))),'GOLD_INSUFFICIENT');
  assert.equal(GENESIS_DEPLOYMENTS.length,0);assert.equal(PRODUCTION_GENESIS.environment,'production');
  await codeOf(createGenesisGoldService({DB:f.db}).reserve(await request(order({orderId:H(0xabe)}))),'MINT_DEPLOYMENT_UNKNOWN');
  await codeOf(createGenesisGoldService({}).order({deploymentId:DEP.id,orderId:H(1)}),'GOLD_NOT_CONFIGURED');
 }finally{f.close();}
});

// A JSON-RPC stand-in for one chain: logs and receipts are encoded the way the R5 contract emits them.
const pad=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
const word=v=>BigInt(v).toString(16).padStart(64,'0');
function chain({tokenId=0n,revoked=false,finalTime=NOW/1000,code=CODE,minted={},consumed={},chainId=11155111,fail=null,receiptTo=CONTRACT,otherMints=[]}={}){
 const o=order(),tx=H(0x7777),blockOfTx=150,fin={number:'0xc8',hash:H(0xf1),timestamp:'0x'+finalTime.toString(16)};
 const consumedLog={address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.consumed,o.orderId,pad(W),pad(tokenId)],data:'0x'+word(consumed.gold??8)};
 const mintedLog={address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.minted,pad(minted.wallet??W),pad(tokenId),minted.lookKey??o.lookKey],
  data:'0x'+word(minted.choice??o.choice)+word(minted.skin??1)+word(minted.paid??1)+word(minted.cost??EMBEO)};
 // other tokens minted in the same transaction (a batch or a bundle): [wallet, tokenId]
 const others=otherMints.map(([w,id])=>({address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.minted,pad(w),pad(id),o.lookKey],data:'0x'+word(0)+word(0)+word(0)+word(0)}));
 const calls=[];
 const rpc=async(method,params)=>{calls.push(method);if(fail===method)throw Error('MINT_CHAIN_UNAVAILABLE');
  switch(method){
   case 'eth_chainId':return '0x'+chainId.toString(16);
   case 'eth_getBlockByNumber':return params[0]==='finalized'||params[0]===fin.number?fin:{number:params[0],hash:H(0xb0),timestamp:'0x1'};
   case 'eth_getCode':return code;
   case 'eth_call':{const sel=params[0].data.slice(0,10);return sel===keccak256(toHex('paidOrderTokenId(bytes32)')).slice(0,10)?pad(tokenId):pad(revoked?1:0);}
   case 'eth_getLogs':return tokenId?[consumedLog]:[];
   case 'eth_getTransactionReceipt':return {transactionHash:tx,status:'0x1',to:receiptTo,blockNumber:'0x'+blockOfTx.toString(16),blockHash:H(0xb0),logs:[...others,mintedLog,consumedLog]};
  }throw Error('unexpected '+method);};
 return {rpc,calls};
}
const settle=(f,c,extra={})=>reconcileGenesisGold(f.db,LIST,'sepolia',(d,hint)=>createGenesisR5Reader(d,c.rpc,hint),{deploymentId:DEP.id,orderId:order().orderId,...extra},NOW);

test('a finalized PaidOrderConsumed with its GenesisMinted spends the hold once',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const r=await settle(f,chain({tokenId:7n}));
  assert.deepEqual([r.state,r.reconciliation],['consumed','settled']);
  const s=await f.snapshot();assert.deepEqual([s.book,s.reserved,s.available],['2','0','2']);
  assert.equal((await settle(f,chain({tokenId:7n}))).state,'consumed');assert.equal((await f.snapshot()).book,'2');
  const proof=JSON.parse(f.db.raw.prepare('SELECT evidence_json FROM world_gold_mints WHERE id=?').get(order().orderId).evidence_json);
  assert.deepEqual([proof.mode,proof.tokenId,proof.transactionHash,proof.blockNumber],['finalized-chain','7',H(0x7777),'200']);
 }finally{f.close();}
});
test('Genesis audit 2026-10-27 finding 2: a paid mint sent through a smart-contract wallet or a bundle (receipt.to is not the contract, other tokens minted in the same transaction) still settles; a second mint of this same token does not',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const conflict=await settle(f,chain({tokenId:7n,receiptTo:'0x'+'5a'.repeat(20),otherMints:[[W,7n]]}));
  assert.deepEqual([conflict.state,conflict.code],['held','MINT_PROOF_CONFLICT']);
  const r=await settle(f,chain({tokenId:7n,receiptTo:'0x'+'5a'.repeat(20),otherMints:[['0x'+'e'.repeat(40),8n],[W,9n]]}));
  assert.deepEqual([r.state,r.reconciliation],['consumed','settled']);
  const s=await f.snapshot();assert.deepEqual([s.book,s.reserved],['2','0']);
 }finally{f.close();}
});
test('release needs a finalized unused order that is revoked or strictly past its deadline',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const atDeadline=await settle(f,chain({finalTime:DEADLINE}));assert.deepEqual([atDeadline.state,atDeadline.reconciliation],['held','pending']);
  const released=await settle(f,chain({finalTime:DEADLINE+1}));assert.equal(released.state,'released');
  const s=await f.snapshot();assert.deepEqual([s.book,s.reserved,s.available],['10','0','10']);
 }finally{f.close();}
 const g=await setup();try{await reserve(g,await request());assert.equal((await settle(g,chain({revoked:true}))).state,'released');}finally{g.close();}
});
test('wrong chain, code, events or an RPC failure keep the hold; nothing is released on a guess',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const cases=[[{chainId:1},'MINT_SCOPE_MISMATCH'],[{code:'0x60aa'},'MINT_SCOPE_MISMATCH'],[{tokenId:7n,minted:{lookKey:H(0x1002)}},'MINT_PROOF_CONFLICT'],
   [{tokenId:7n,minted:{choice:3}},'MINT_PROOF_CONFLICT'],[{tokenId:7n,minted:{cost:'1'}},'MINT_PROOF_CONFLICT'],[{tokenId:7n,minted:{paid:0}},'MINT_PROOF_CONFLICT'],
   [{tokenId:7n,consumed:{gold:9}},'MINT_PROOF_CONFLICT'],[{tokenId:7n,minted:{wallet:'0x'+'e'.repeat(40)}},'MINT_PROOF_CONFLICT'],
   [{finalTime:DEADLINE+1,fail:'eth_call'},'MINT_CHAIN_UNAVAILABLE'],[{tokenId:7n,fail:'eth_getTransactionReceipt'},'MINT_CHAIN_UNAVAILABLE']];
  for(const [opt,code] of cases){const r=await settle(f,chain(opt));assert.deepEqual([r.state,r.reconciliation,r.code],['held','pending',code],JSON.stringify(opt,(k,v)=>typeof v==='bigint'?String(v):v));}
  assert.equal((await f.snapshot()).reserved,'8');
  // A transaction hint is verified like a found log: it cannot point at another order's mint.
  const c=chain({tokenId:7n});const r=await settle(f,c,{transactionHash:H(0x7777)});assert.equal(r.state,'consumed');assert.ok(!c.calls.includes('eth_getLogs'));
 }finally{f.close();}
});
test('cron pages through held orders of its deployments with a persisted cursor',async()=>{
 const f=await setup({topups:5});try{
  for(let i=0;i<5;i++){const o=order({orderId:H(0x500+i)});await reserve(f,{deploymentId:DEP.id,order:o,consentSignature:await consent(o)});}
  const c=chain({finalTime:DEADLINE+1}),reader=(d,hint)=>createGenesisR5Reader(d,c.rpc,hint);
  const out=await reconcileGenesisDeployments(f.db,LIST,'sepolia',reader,NOW);
  assert.equal(out.length,1);assert.equal(out[0].outcomes.filter(o=>o.status==='released').length,5);
  assert.equal(f.db.raw.prepare('SELECT after FROM genesis_gold_cursors WHERE deployment=?').get(DEP.id).after,'');
  assert.equal((await f.snapshot()).reserved,'0');
  assert.deepEqual(await reconcileGenesisDeployments(f.db,LIST,'local',reader,NOW),[]);
 }finally{f.close();}
});
