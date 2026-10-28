import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,toHex,getAddress} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {fixture,NOW,W,account,H} from './world-gold-audit5-fixture.mjs';
import {reserveGenesisGold,genesisGoldOrder,reconcileGenesisGold,reconcileGenesisDeployments,goldConsentDomain,goldConsentMessage,GOLD_CONSENT_TYPES,GENESIS_CRON_PAGE} from '../server/genesis-gold.ts';
import {createGenesisR5Reader,genesisRpc,R5_TOPICS,GENESIS_LOG_BLOCK_RANGE} from '../server/genesis-gold-reader.ts';
import {maintainGenesisGold} from '../server/genesis-gold-service.ts';
import {GENESIS_DEPLOYMENTS} from '../server/genesis-deployments.ts';
import {encodeMintAuth} from '../server/world-gold-result.ts';
import {createGenesisGoldService,PRODUCTION_GENESIS} from '../worker/app.ts';

// Ported 2026-10-28 from the Sepolia rehearsal book's tests. Every registry entry names its domain version and recipient.
const SAFE='0x29e7c208481f648795f677b55f6ecb2badc2f01e',DEAD='0x000000000000000000000000000000000000dead';
const CODE='0x6080604052',CODE_HASH=keccak256(CODE),CONTRACT='0x'+'c'.repeat(40),EMBEO='300000000000000000000000';
const DEP={id:'sepolia-r5-test-1',environment:'sepolia',chainId:11155111,contract:CONTRACT,codeHash:CODE_HASH,deployBlock:'100',embeoCost:EMBEO,goldCost:'8',addedTokenGoldCosts:['9'],signer:'0x'+'5'.repeat(40),domainVersion:'7',recipient:SAFE};
const LIST=[DEP,{...DEP,id:'mainnet-other',environment:'production',chainId:1}];
const DEADLINE=NOW/1000+300;
const order=(patch={})=>({orderId:H(0xabc),wallet:W,lookKey:H(0x1001),choice:1,uriHash:keccak256(toHex('ipfs://looks/x/1')),recipient:SAFE,embeoCost:EMBEO,goldCost:'8',deadline:String(DEADLINE),signerEpoch:'1',...patch});
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
test('the stored document names the deployment’s own EIP-712 domain version (Genesis audit 2026-10-27, finding 10)',async()=>{
 const f=await setup();try{
  const V7={...DEP,id:'sepolia-r6-v8',domainVersion:'8'},o=order();
  const r=await reserveGenesisGold(f.db,[V7],'sepolia',{deploymentId:V7.id,order:o,consentSignature:await consent(o,account,V7)},NOW,()=>NOW);
  assert.equal(r.state,'held');
  assert.equal(JSON.parse(f.db.raw.prepare('SELECT auth_json FROM world_gold_mints WHERE id=?').get(o.orderId).auth_json).domain.version,'8');
 }finally{f.close();}
});
test('Genesis owner 2026-10-28: the recipient comes from the registry (the treasury Safe); any other address, the burn address too, is refused',async()=>{
 const f=await setup();try{
  const T=DEP;
  const req=async o=>({deploymentId:T.id,order:o,consentSignature:await consent(o,account,T)});
  await codeOf(reserveGenesisGold(f.db,[T],'sepolia',await req(order({recipient:DEAD})),NOW,()=>NOW),'MINT_PRICE_MISMATCH');
  const ok=await reserveGenesisGold(f.db,[T],'sepolia',await req(order({recipient:'0x29e7c208481f648795f677b55F6ECb2bADc2F01E'})),NOW,()=>NOW);
  assert.equal(ok.state,'held');assert.equal((await f.snapshot()).reserved,'8');
 }finally{f.close();}
});
test('Genesis audit b0b1d96a finding 3: the stored-hold check takes domain version and recipient from the binding, not any of 5 / 7 and any address',()=>{
 const doc=(version,recipient)=>({schema:'genesis-r5-paid-v1',deploymentId:DEP.id,codeHash:CODE_HASH,
  domain:{name:'EmberEvoGenesisCandidate',version,chainId:DEP.chainId,verifyingContract:CONTRACT},
  order:order({recipient}),consent:{signature:'0x'+'1'.repeat(130)}});
 const bind=(domainVersion,recipient)=>({id:H(0xabc),wallet:W.toLowerCase(),gold:'8',deadline:DEADLINE*1000,chainId:DEP.chainId,contract:CONTRACT,chainInstance:DEP.id,domainVersion,recipient});
 assert.equal(typeof encodeMintAuth(doc('5',DEAD),bind('5',DEAD)),'string');
 assert.equal(typeof encodeMintAuth(doc('7',SAFE),bind('7',SAFE)),'string');
 assert.throws(()=>encodeMintAuth(doc('7',DEAD),bind('5',DEAD)));   // the auditor's case: v7 document, v5 deployment
 assert.throws(()=>encodeMintAuth(doc('7',SAFE),bind('7',DEAD)));            // another recipient than the deployment's
 assert.throws(()=>encodeMintAuth(doc('5',DEAD),bind(undefined,undefined))); // no registry values: refused
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
function chain({tokenId=0n,revoked=false,finalTime=NOW/1000,code=CODE,minted={},consumed={},chainId=11155111,fail=null,receiptTo=CONTRACT,otherMints=[],finNumber=200,blockOfTx=150,timeOf=null,receiptBlockHash=H(0xb0),logList=null}={}){
 const o=order(),tx=H(0x7777),fin={number:'0x'+finNumber.toString(16),hash:H(0xf1),timestamp:'0x'+finalTime.toString(16)};
 const ts=n=>timeOf?timeOf(n):finalTime-12*(finNumber-n);
 const logRanges=[];
 const consumedLog={address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.consumed,o.orderId,pad(W),pad(tokenId)],data:'0x'+word(consumed.gold??8)};
 const mintedLog={address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.minted,pad(minted.wallet??W),pad(tokenId),minted.lookKey??o.lookKey],
  data:'0x'+word(minted.choice??o.choice)+word(minted.skin??1)+word(minted.paid??1)+word(minted.cost??EMBEO)};
 // other tokens minted in the same transaction (a batch or a bundle): [wallet, tokenId]
 const others=otherMints.map(([w,id])=>({address:CONTRACT,removed:false,transactionHash:tx,topics:[R5_TOPICS.minted,pad(w),pad(id),o.lookKey],data:'0x'+word(0)+word(0)+word(0)+word(0)}));
 const calls=[];
 const rpc=async(method,params)=>{calls.push(method);if(fail===method)throw Error('MINT_CHAIN_UNAVAILABLE');
  switch(method){
   case 'eth_chainId':return '0x'+chainId.toString(16);
   case 'eth_getBlockByNumber':return params[0]==='finalized'||params[0]===fin.number?fin:{number:params[0],hash:H(0xb0),timestamp:'0x'+ts(Number(params[0])).toString(16)};
   case 'eth_getCode':return code;
   case 'eth_call':{const sel=params[0].data.slice(0,10);return sel===keccak256(toHex('paidOrderTokenId(bytes32)')).slice(0,10)?pad(tokenId):pad(revoked?1:0);}
   case 'eth_getLogs':{
    // a real node filters by address and topics: a reader asking with the wrong ones finds nothing
    const q=params[0],from=Number(q.fromBlock),to=Number(q.toBlock);logRanges.push([from,to]);
    const match=q.address===CONTRACT&&q.topics?.length===2&&q.topics[0]===R5_TOPICS.consumed&&q.topics[1]===o.orderId;
    return match&&tokenId&&from<=blockOfTx&&blockOfTx<=to?logList??[consumedLog]:[];}
   case 'eth_getTransactionReceipt':return {transactionHash:tx,status:'0x1',to:receiptTo,blockNumber:'0x'+blockOfTx.toString(16),blockHash:receiptBlockHash,logs:[...others,mintedLog,consumedLog]};
  }throw Error('unexpected '+method);};
 return {rpc,calls,logRanges,consumedLog};
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
test('cron pages through held orders of its deployments with a persisted cursor, checking the bytecode once per finalized block',async()=>{
 const n=GENESIS_CRON_PAGE+2,f=await setup({topups:n});try{
  const ids=[];for(let i=0;i<n;i++){const o=order({orderId:H(0x500+i)});ids.push(o.orderId);await reserve(f,{deploymentId:DEP.id,order:o,consentSignature:await consent(o)});}
  const cursor=()=>f.db.raw.prepare('SELECT after FROM genesis_gold_cursors WHERE deployment=?').get(DEP.id).after;
  // still before the deadline: every order stays pending, so only the cursor moves the next run on
  const wait=chain({finalTime:DEADLINE}),waitReader=(d,hint)=>createGenesisR5Reader(d,wait.rpc,hint);
  const first=await reconcileGenesisDeployments(f.db,LIST,'sepolia',waitReader,NOW);
  assert.deepEqual(first[0].outcomes.map(o=>o.id),ids.slice(0,GENESIS_CRON_PAGE));assert.equal(cursor(),ids[GENESIS_CRON_PAGE-1]);
  assert.equal(wait.calls.filter(m=>m==='eth_getCode').length,1);
  const second=await reconcileGenesisDeployments(f.db,LIST,'sepolia',waitReader,NOW);
  assert.deepEqual(second[0].outcomes.map(o=>o.id),ids.slice(GENESIS_CRON_PAGE));assert.equal(cursor(),'');
  const c=chain({finalTime:DEADLINE+1}),reader=(d,hint)=>createGenesisR5Reader(d,c.rpc,hint);
  const out=await reconcileGenesisDeployments(f.db,LIST,'sepolia',reader,NOW);
  assert.equal(out.length,1);assert.equal(out[0].outcomes.filter(o=>o.status==='released').length,GENESIS_CRON_PAGE);
  await reconcileGenesisDeployments(f.db,LIST,'sepolia',reader,NOW);
  assert.equal((await f.snapshot()).reserved,'0');
  assert.deepEqual(await reconcileGenesisDeployments(f.db,LIST,'local',reader,NOW),[]);
 }finally{f.close();}
});
test('review 2026-10-28: a malformed registry entry is reported by its code and the other deployments are still settled',async()=>{
 const list=[{...DEP,id:'sepolia-broken',codeHash:'0x12'},DEP];
 const f=await setup();try{
  await reserve(f,await request());
  const c=chain({finalTime:DEADLINE+1}),reader=(d,hint)=>createGenesisR5Reader(d,c.rpc,hint);
  const out=await reconcileGenesisDeployments(f.db,list,'sepolia',reader,NOW);
  assert.deepEqual(out.map(r=>[r.deployment,r.failed??null]),[['sepolia-broken','MINT_DEPLOYMENT_INVALID'],[DEP.id,null]]);
  assert.equal(out[1].outcomes[0].status,'released');
 }finally{f.close();}
 const g=await setup();try{
  await reserve(g,await request());
  // the cron's own step logs the broken entry by code and still reads the working one (a chain that answers nothing: held)
  const logged=await maintainGenesisGold({DB:g.db,GENESIS_RPC_URL:'https://rpc.test',ECONOMY_CHAIN_LIMITER:{limit:async()=>({success:true})}},{deployments:list,environment:'sepolia'},
   async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:null})),NOW);
  assert.deepEqual(logged,[{deployment:'sepolia-broken',status:'MINT_DEPLOYMENT_INVALID'},{id:order().orderId,status:'MINT_CHAIN_UNAVAILABLE'}]);
  assert.equal((await g.snapshot()).reserved,'8');
 }finally{g.close();}
});
test('review 2026-10-28: a test chain RPC request has a timeout, and a non-2xx reply is a chain failure',async()=>{
 let signal;
 const ok=genesisRpc('https://rpc.test',async(url,init)=>{signal=init.signal;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x1'}));});
 assert.equal(await ok('eth_chainId',[]),'0x1');assert.ok(signal instanceof AbortSignal);
 const bad=genesisRpc('https://rpc.test',async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x1'}),{status:502}));
 await codeOf(bad('eth_chainId',[]),'MINT_CHAIN_UNAVAILABLE');
 const hang=genesisRpc('https://rpc.test',async()=>{throw new DOMException('timed out','TimeoutError');});
 await codeOf(hang('eth_chainId',[]),'MINT_CHAIN_UNAVAILABLE');
});
test('review 2026-10-28: a receipt from a block that is no longer canonical, a removed log or two live logs never settle',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const reorged=await settle(f,chain({tokenId:7n,receiptBlockHash:H(0xb1)}));
  assert.deepEqual([reorged.state,reorged.code],['held','MINT_PROOF_CONFLICT']);
  const base=chain({tokenId:7n}).consumedLog;
  const removed=await settle(f,chain({tokenId:7n,logList:[{...base,removed:true}]}));
  assert.deepEqual([removed.state,removed.code],['held','MINT_PROOF_CONFLICT']);
  const two=await settle(f,chain({tokenId:7n,logList:[base,{...base,transactionHash:H(0x7778)}]}));
  assert.deepEqual([two.state,two.code],['held','MINT_PROOF_CONFLICT']);
  assert.equal((await f.snapshot()).reserved,'8');
  assert.equal((await settle(f,chain({tokenId:7n}))).state,'consumed');
 }finally{f.close();}
});

// Bounded search (2026-10-28, before mainnet): without a transaction hint the reader looks only at the order's own
// window, in requests the World's Alchemy Free endpoint accepts (10 blocks each).
const searched=c=>c.logRanges.reduce((n,[a,b])=>n+b-a+1,0);
test('without a hint the log search covers only the order window, in requests of at most 10 blocks, and settles',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const c=chain({tokenId:7n});
  const r=await settle(f,c);assert.deepEqual([r.state,r.reconciliation],['consumed','settled']);
  assert.ok(c.logRanges.length>0&&c.logRanges.every(([a,b])=>b-a+1<=GENESIS_LOG_BLOCK_RANGE&&a<=b&&b<=200));
  // the window starts before the earliest block the order could be consumed in and the search stopped at the log
  const deadline=DEADLINE,earliest=deadline-900;assert.ok(NOW/1000-12*(200-c.logRanges[0][0])<earliest);
  assert.equal(c.logRanges.at(-1)[0]<=150&&150<=c.logRanges.at(-1)[1],true);
 }finally{f.close();}
});
test('a reconciliation a month late, with missed slots since the order, still searches about one order window',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  // block B0 is at NOW; every 20th slot after it is missed (a block every 12.6 s on average)
  const B0=5_000_000,T0=NOW/1000,timeOf=n=>T0+12*(n-B0)+12*Math.floor((n-B0)/20);
  const finNumber=B0+205_000,c=chain({tokenId:7n,finNumber,finalTime:timeOf(finNumber),blockOfTx:B0+10,timeOf});
  const r=await settle(f,c);assert.equal(r.state,'consumed');
  assert.ok(searched(c)<=130,'searched '+searched(c)+' blocks');
  assert.ok(c.calls.filter(m=>m==='eth_getBlockByNumber').length<=30);
  assert.ok(c.logRanges.every(([a,b])=>b-a+1<=GENESIS_LOG_BLOCK_RANGE));
 }finally{f.close();}
});
test('a consumption outside the window, or timestamps that break one block per slot, keep the hold; a verified hint still settles',async()=>{
 const f=await setup();try{
  await reserve(f,await request());
  const outside=await settle(f,chain({tokenId:7n,blockOfTx:120}));
  assert.deepEqual([outside.state,outside.code],['held','MINT_PROOF_CONFLICT']);
  const dense=await settle(f,chain({tokenId:7n,timeOf:n=>NOW/1000-(200-n)}));   // one block per second
  assert.deepEqual([dense.state,dense.code],['held','MINT_CHAIN_UNAVAILABLE']);
  assert.equal((await f.snapshot()).reserved,'8');
  const hinted=chain({tokenId:7n,blockOfTx:120});
  assert.equal((await settle(f,hinted,{transactionHash:H(0x7777)})).state,'consumed');assert.equal(hinted.logRanges.length,0);
 }finally{f.close();}
});
test('the production registry is empty and every entry type names its domain version and recipient',async()=>{
 assert.deepEqual([...GENESIS_DEPLOYMENTS],[]);
 const {readFileSync}=await import('node:fs');
 const src=readFileSync(new URL('../server/genesis-gold.ts',import.meta.url),'utf8');
 assert.match(src,/domainVersion:string;recipient:string\}/);assert.doesNotMatch(src,/\?\?\s*GENESIS_DEAD|0x0{36}dead/i);
});

test('review 2026-10-28: a registry entry with EIP-55 capitals or an uppercase code hash still retries and settles; a malformed entry is refused',async()=>{
 const f=await setup();try{
  const UP={...DEP,contract:getAddress(CONTRACT),codeHash:CODE_HASH.toUpperCase().replace('0X','0x'),recipient:'0x29e7c208481f648795f677b55F6ECb2bADc2F01E'};
  const req={deploymentId:UP.id,order:order(),consentSignature:await consent(order(),account,UP)};
  const a=await reserveGenesisGold(f.db,[UP],'sepolia',req,NOW,()=>NOW);assert.equal(a.state,'held');
  assert.deepEqual(await reserveGenesisGold(f.db,[UP],'sepolia',req,NOW,()=>NOW),a);                 // retry: no MINT_ORDER_CONFLICT
  const c=chain({tokenId:7n});
  const r=await reconcileGenesisGold(f.db,[UP],'sepolia',(d,hint)=>createGenesisR5Reader(d,c.rpc,hint),{deploymentId:UP.id,orderId:order().orderId},NOW);
  assert.equal(r.state,'consumed');
  await codeOf(reserveGenesisGold(f.db,[{...DEP,codeHash:'0x12'}],'sepolia',req,NOW,()=>NOW),'MINT_DEPLOYMENT_INVALID');
 }finally{f.close();}
});

test('owner 2026-10-29: every payment token has its own GOLD price (imdUSD discounted, USDC higher); a hold is the price the wallet consented to and settles only at that price',async()=>{
 const f=await setup();try{
  // GOLD 8 stands for imdUSD's 1,200, 9 for USDC's 1,600: an order at either price is held at exactly that price
  const o=order({goldCost:'9'}),a=await reserve(f,{deploymentId:DEP.id,order:o,consentSignature:await consent(o)});
  assert.deepEqual([a.state,a.book,a.reserved,a.available],['held','10','9','1']);
  // the chain must report the same GOLD price for the token actually paid: the imdUSD price on a USDC hold is a conflict
  const cheap=await settle(f,chain({tokenId:7n,consumed:{gold:8}}));assert.deepEqual([cheap.state,cheap.code],['held','MINT_PROOF_CONFLICT']);
  const r=await settle(f,chain({tokenId:7n,consumed:{gold:9}}));assert.deepEqual([r.state,r.reconciliation],['consumed','settled']);
  assert.deepEqual([(await f.snapshot()).book,(await f.snapshot()).reserved],['1','0']);
  // a price on no token of the deployment is refused before anything is held
  const g=order({orderId:H(0xabd),goldCost:'10'});
  await codeOf(reserve(f,{deploymentId:DEP.id,order:g,consentSignature:await consent(g)}),'MINT_PRICE_MISMATCH');
 }finally{f.close();}
});
test('owner 2026-10-29: a registry entry lists at most two added-token GOLD prices, each a positive integer, no repeats; a malformed list refuses the entry',async()=>{
 const f=await setup();try{
  for(const addedTokenGoldCosts of [undefined,'9',['0'],['9','9','9'],['9','9'],['09'],[9]]){
   const bad={...DEP,addedTokenGoldCosts};
   await codeOf(reserveGenesisGold(f.db,[bad],'sepolia',await request(),NOW,()=>NOW),'MINT_DEPLOYMENT_INVALID');
  }
  const none={...DEP,addedTokenGoldCosts:[]},o=order({goldCost:'9'});
  await codeOf(reserveGenesisGold(f.db,[none],'sepolia',{deploymentId:DEP.id,order:o,consentSignature:await consent(o)},NOW,()=>NOW),'MINT_PRICE_MISMATCH');
  assert.equal((await f.snapshot()).reserved,'0');
 }finally{f.close();}
});
test('review 2026-10-29: every registry entry id is unique within its environment (the cron keeps one cursor per id)',()=>{
 const keys=GENESIS_DEPLOYMENTS.map(d=>d.environment+':'+d.id);assert.equal(new Set(keys).size,keys.length);
});
