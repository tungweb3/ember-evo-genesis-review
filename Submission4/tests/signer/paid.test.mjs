// Paid route end to end: the real R5 contract on a local chain with Sepolia's chain id, the World GOLD book (the
// handoff copy at C:\EW-V2, rehearsal migrations incl. 9001) behind the GenesisGold service, this signer in between,
// and the book's finalized-chain reader settling from the contract's own events. Skipped if the World copy is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {harness,TX} from '../../contract/tests/hardening-harness.mjs';
import {ethers} from '../../contract/tools/runtime.mjs';
import {PaidApprovalSigner} from '../paid-approval.mjs';
import {createHandler} from '../worker.mjs';

// The World copy: WORLD_SOURCE, else the original handoff copy, else the GOLD work copy made on D: after the C: drive
// failure (2026-10-27).
const WORLD=new URL([process.env.WORLD_SOURCE,'C:/EW-V2/EmberWorld_V2_Final/workspace/world-reviewed-release-2026-10-19/source',
 'D:/A/Desktop/Claude/EW-V2-gold-sepolia/source'].filter(Boolean).map(p=>'file:///'+p.replaceAll('\\','/').replace(/\/?$/,'/'))
 .find(u=>existsSync(fileURLToPath(new URL('server/genesis-gold.ts',u))))??'file:///C:/EW-V2/missing/');
const present=existsSync(fileURLToPath(new URL('server/genesis-gold.ts',WORLD)));
const SEPOLIA=11155111,BASE='ipfs://REHEARSAL/looks/';
const look=(o={})=>({body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null,...o});
const code=async(p,c)=>{await assert.rejects(p,e=>{assert.equal(e.code??e.message,c);return true;});};

async function setup(grantGold=3){
 const w=async p=>import(new URL(p,WORLD).href);
 const [{openD1},{buildSeedSql},svc,gg,reader,wg]=await Promise.all([w('tests/d1-sqlite.mjs'),w('scripts/sepolia-gold-seed.mjs'),w('server/genesis-gold-service.ts'),
  w('server/genesis-gold.ts'),w('server/genesis-gold-reader.ts'),w('server/world-gold.ts')]);
 const h=await harness('FixtureToken','EmberEvoGenesisCandidate',SEPOLIA);
 await h.configure([],undefined,{pending:'ipfs://REHEARSAL/pending.json',base:BASE});
 const db=openD1();db.raw.exec(readFileSync(new URL('migrations-sepolia/9001_sepolia_test_gold.sql',WORLD),'utf8'));
 const contract=h.contract.target.toLowerCase();
 const dep={id:'sepolia-r5-rehearsal-1',environment:'sepolia',chainId:SEPOLIA,contract,codeHash:ethers.keccak256(await h.provider.getCode(contract)),
  deployBlock:String(await h.contract.startBlock()),embeoCost:String(await h.contract.paidCost()),goldCost:String(await h.contract.paidGoldCost()),signer:h.approvalSigner.address,
  recipient:(await h.contract.paymentRecipient()).toLowerCase()};
 let nowMs=0;const sync=async()=>{nowMs=Number((await h.provider.getBlock('latest')).timestamp)*1000;};await sync();
 db.raw.exec(buildSeedSql({batch:'rehearsal-1',source:'paid route end-to-end test',wallets:[{wallet:h.a,cap:100,note:'test wallet alice'}],grants:[{wallet:h.a,amount:grantGold}]},nowMs));
 const gold=svc.createGenesisGoldService({DB:db},{deployments:[dep],environment:'sepolia'},fetch,()=>nowMs);
 const paid=new PaidApprovalSigner({provider:h.provider,contractAddress:h.contract.target,chainId:SEPOLIA,signer:h.approvalSigner,metadataBase:BASE,
  gold,deploymentId:dep.id,ticketSecret:'rehearsal-ticket-secret-0123456789abcdef'});
 const rpc=(method,params)=>h.rpc.request({method,params});
 const settle=async orderId=>{await sync();return gg.reconcileGenesisGold(db,[dep],'sepolia',(d,hint)=>reader.createGenesisR5Reader(d,rpc,hint),{deploymentId:dep.id,orderId},nowMs);};
 const balance=async()=>{const s=await wg.worldGoldSnapshot(db,h.a.toLowerCase(),nowMs);return [s.book,s.reserved,s.available];};
 const order=async(l,choice,who=h.alice)=>{await sync();const p=await paid.prepare({wallet:await who.getAddress(),look:l,choice});
  const consentSignature=await who.signTypedData(p.consent.domain,p.consent.types,p.consent.message);return {p,req:{order:p.order,uri:p.uri,ticket:p.ticket,consentSignature}};};
 const mint=async(m,who=h.alice)=>{await h.mine(h.token.connect(who).approve(h.contract.target,await h.contract.paidCost(),TX));
  return h.mine(h.contract.connect(who).mintPaid(m.lookKey,m.choice,m.uri,m.orderId,m.deadline,m.goldSignature,TX));};
 return {h,db,dep,paid,gold,settle,balance,order,mint,sync,close:()=>h.close()};
}

test('paid mint end to end: consent, GOLD held, R5 mint pays the treasury recipient, finalized reconcile spends the GOLD exactly once',{skip:!present&&'World copy not present'},async()=>{
 const f=await setup();try{
  const {p,req}=await order(f,look(),1);
  assert.equal(p.order.goldCost,f.dep.goldCost);assert.equal(p.order.embeoCost,f.dep.embeoCost);assert.equal(p.uri,BASE+p.order.lookKey+'/1');
  const recipient=await f.h.contract.paymentRecipient();assert.equal(p.order.recipient,recipient.toLowerCase());assert.equal(f.dep.recipient,recipient.toLowerCase());
  const a=await f.paid.approve(req);assert.deepEqual(a.gold,{state:'held',book:'3',reserved:'1',available:'2'});
  // one signature, and the transaction carries only the order id and deadline (2026-10-28)
  assert.deepEqual(Object.keys(a.mintPaid).sort(),['choice','deadline','goldSignature','lookKey','orderId','uri']);assert.equal(a.mintPaid.orderId,p.order.orderId);assert.equal(a.mintPaid.deadline,p.order.deadline);
  const again=await f.paid.approve(req);assert.deepEqual(again.mintPaid,a.mintPaid,'a lost response is retried with the same order and signatures');
  assert.deepEqual(await f.balance(),['3','1','2']);
  const before=await f.h.token.balanceOf(recipient);
  const rc=await f.mint(a.mintPaid);assert.equal(rc.status,1);
  assert.equal(await f.h.token.balanceOf(recipient)-before,BigInt(f.dep.embeoCost));
  assert.equal(await f.h.contract.tokenURI(1),p.uri);
  const s=await f.settle(p.order.orderId);assert.deepEqual([s.state,s.reconciliation],['consumed','settled'],JSON.stringify(s));
  assert.deepEqual(await f.balance(),['2','0','2']);
  assert.equal((await f.settle(p.order.orderId)).state,'consumed');assert.deepEqual(await f.balance(),['2','0','2']);
  await code(f.paid.approve(req),'ORDER_ALREADY_MINTED');
 }finally{await f.close();}
});
test('a random paid mint settles the same way (choice 3, empty uri, skin unknown at mint)',{skip:!present&&'World copy not present'},async()=>{
 const f=await setup();try{
  const {p,req}=await order(f,look({hat:'HAT_BERET.beret'}),3);assert.equal(p.uri,'');
  const a=await f.paid.approve(req);await f.mint(a.mintPaid);
  assert.equal((await f.settle(p.order.orderId)).state,'consumed');assert.deepEqual(await f.balance(),['2','0','2']);
 }finally{await f.close();}
});
test('an unused order is released only after the chain passes its deadline; until then the GOLD stays held',{skip:!present&&'World copy not present'},async()=>{
 const f=await setup();try{
  const {p,req}=await order(f,look({shoes:'SNEAKER.low'}),2);await f.paid.approve(req);
  let s=await f.settle(p.order.orderId);assert.deepEqual([s.state,s.reconciliation],['held','pending']);assert.deepEqual(await f.balance(),['3','1','2']);
  await f.h.rpc.request({method:'evm_increaseTime',params:[700]});await f.h.rpc.request({method:'evm_mine',params:[]});
  s=await f.settle(p.order.orderId);assert.equal(s.state,'released');assert.deepEqual(await f.balance(),['3','0','3']);
  await code(f.paid.approve(req),'ORDER_RELEASED');
 }finally{await f.close();}
});
test('a changed order, another wallet’s consent, a missing balance and a closed route are all refused before any signature',{skip:!present&&'World copy not present'},async()=>{
 const f=await setup(1);try{
  const {req}=await order(f,look(),1);
  await code(f.paid.approve({...req,order:{...req.order,choice:2}}),'ORDER_TICKET_INVALID');
  await code(f.paid.approve({...req,order:{...req.order,goldCost:'0'}}),'ORDER_TICKET_INVALID');
  await code(f.paid.approve({...req,uri:'ipfs://elsewhere'}),'ORDER_TICKET_INVALID');
  const bobConsent=await f.h.bob.signTypedData({name:'Ember World GOLD',version:'1',chainId:SEPOLIA},(await import('../paid-approval.mjs')).GOLD_CONSENT_TYPES,{...req.order,genesis:f.h.contract.target});
  await code(f.paid.approve({...req,consentSignature:bobConsent}),'INVALID_GOLD_CONSENT');
  assert.deepEqual(await f.balance(),['1','0','1']);
  await f.paid.approve(req);
  const second=await order(f,look({hat:'HAT_PEAKED.captain'}),0);
  await code(f.paid.approve(second.req),'GOLD_INSUFFICIENT');
  assert.deepEqual(await f.balance(),['1','1','0']);
  await f.h.mine(f.h.contract.setMintPaused(true,TX));await code(f.paid.prepare({wallet:f.h.a,look:look({hat:'HAT_BERET.beret'}),choice:1}),'MINT_PAUSED');
  const ORIGIN='https://mint.example.test';
  const on=createHandler({approver:async()=>{throw Error('unused');},paidApprover:async()=>f.paid,allowedOrigins:[ORIGIN]});
  const off=createHandler({approver:async()=>{throw Error('unused');},allowedOrigins:[ORIGIN]});
  const post=(fetch,path)=>fetch(new Request('https://signer.example.test'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'{}'}));
  assert.equal((await post(off,'/v1/paid/prepare')).status,501);assert.equal((await post(off,'/v1/approval/paid')).status,501);
  assert.deepEqual(await (await post(on,'/v1/paid/prepare')).json(),{ok:false,error:{code:'REQUEST_FIELDS_INVALID'}});
 }finally{await f.close();}
});
const order=(f,...a)=>f.order(...a);
