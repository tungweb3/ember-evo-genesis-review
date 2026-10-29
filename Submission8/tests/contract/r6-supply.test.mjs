import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,COST,TX} from './hardening-harness.mjs';
import {ethers} from '../tools/runtime.mjs';

// R6 (owner 2026-10-22): supply 1,688 at deployment (owner 2026-10-28; 1,288 from 2026-10-25) with skin caps
// 1,068/218/218/68/68/48; the owner may reset the caps until minting opens (first mint, the free start time, or
// lockSupply), never above 2,222, never a skin at 0 and never below the free-mint list.
const DEFAULT=[1068n,218n,218n,68n,68n,48n];
const caps=async h=>Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCap(i)));
function events(h,receipt,name){return receipt.logs.map(l=>{try{return h.contract.interface.parseLog(l);}catch{return null;}}).filter(l=>l?.name===name);}

test('R6 supply: deployed at 1,688 = 1,068/218/218/68/68/48, ceiling 2,222, not fixed yet',async()=>{
 const h=await harness();try{
  assert.equal(await h.contract.maxSupply(),1688n);assert.deepEqual(await caps(h),DEFAULT);
  assert.equal(await h.contract.SUPPLY_CEILING(),2222n);assert.equal(await h.contract.supplyLocked(),false);assert.equal(await h.contract.supplyFixed(),false);
  await assert.rejects(h.contract.skinCap.staticCall(6),/SKIN_INVALID/);
 }finally{await h.close();}
});

test('R6 supply: the owner can reset the caps before minting opens; the total follows and the change is logged',async()=>{
 const h=await harness();try{
  await assert.rejects(h.contract.connect(h.alice).configureSupply.staticCall([1,1,1,1,1,1]),/OwnableUnauthorizedAccount/);
  const rc=await h.mine(h.contract.configureSupply([500,200,150,80,40,30],TX));
  assert.equal(await h.contract.maxSupply(),1000n);assert.deepEqual(await caps(h),[500n,200n,150n,80n,40n,30n]);
  const ev=events(h,rc,'SupplyConfigured')[0];assert.equal(ev.args.maxSupply,1000n);
  await h.mine(h.contract.configureSupply(DEFAULT,TX));assert.equal(await h.contract.maxSupply(),1688n);   // and back
 }finally{await h.close();}
});

test('R6 supply: a skin at 0, a total above 2,222 and a total below the free-mint list are refused',async()=>{
 const h=await harness();try{
  await assert.rejects(h.contract.configureSupply.staticCall([768,168,168,68,68,0]),/SKIN_CAP_ZERO/);
  await assert.rejects(h.contract.configureSupply.staticCall([1500,300,200,100,100,23]),/SUPPLY_CEILING/);
  await h.contract.configureSupply.staticCall([1500,300,200,100,100,22]);   // exactly 2,222 is fine
  // free-mint list of 10, start in the future: a total of 9 is refused, 10 is fine
  const now=await h.time();await h.mine(h.contract.configureSnapshot(ethers.id('root'),10,now-1,now+3600,TX));
  await assert.rejects(h.contract.configureSupply.staticCall([4,1,1,1,1,1]),/SUPPLY_BELOW_SNAPSHOT/);
  await h.mine(h.contract.configureSupply([5,1,1,1,1,1],TX));assert.equal(await h.contract.maxSupply(),10n);
 }finally{await h.close();}
});

test('R6 supply: fixed for good once the free start time arrives, even before any mint',async()=>{
 const h=await harness();try{
  const now=await h.time();await h.mine(h.contract.configureSnapshot(ethers.id('root'),1,now-1,now+30,TX));
  await h.contract.configureSupply.staticCall(DEFAULT);
  await h.rpc.request({method:'evm_increaseTime',params:[31]});await h.rpc.request({method:'evm_mine',params:[]});
  assert.equal(await h.contract.supplyFixed(),true);await assert.rejects(h.contract.configureSupply.staticCall(DEFAULT),/SUPPLY_FIXED/);
 }finally{await h.close();}
});

test('R6 supply: the first mint fixes it (supplyFixed; no write per mint since 2026-10-27); lockSupply locks it earlier and only once',async()=>{
 const h=await harness();try{
  await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST,TX));
  const rc=await h.paid(h.alice,await h.approval(h.a,'first'));
  assert.equal(await h.contract.supplyFixed(),true);assert.equal(await h.contract.supplyLocked(),false);assert.equal(events(h,rc,'SupplyLocked').length,0);
  await assert.rejects(h.contract.configureSupply.staticCall(DEFAULT),/SUPPLY_FIXED/);
 }finally{await h.close();}
 const g=await harness();try{
  await assert.rejects(g.contract.connect(g.alice).lockSupply.staticCall(),/OwnableUnauthorizedAccount/);
  await g.mine(g.contract.lockSupply(TX));assert.equal(await g.contract.supplyFixed(),true);
  await assert.rejects(g.contract.configureSupply.staticCall(DEFAULT),/SUPPLY_FIXED/);await assert.rejects(g.contract.lockSupply.staticCall(),/SUPPLY_LOCKED/);
 }finally{await g.close();}
});

test('R6 supply: with reset caps, direct picks and randoms fill every skin exactly and then it is sold out',async()=>{
 const h=await harness();try{
  const small=[3n,2n,2n,1n,1n,1n];await h.mine(h.contract.configureSupply(small,TX));
  await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*11n,TX));
  // 2 green, 1 ice, 1 purple chosen; 6 randoms fill the rest (one per mint transaction, each its own epoch is fine)
  for(const [tag,choice] of [['g1',0],['g2',0],['i1',1],['p1',2],['r1',3],['r2',3],['r3',3],['r4',3],['r5',3],['r6',3]])
   await h.paid(h.alice,await h.approval(h.a,tag,choice===3?'':undefined,{choice}));
  assert.equal(await h.contract.totalMinted(),10n);
  for(let i=0;i<40;i++){const [exists,,known]=await h.contract.nextRevealEpoch();if(!exists)break;
   if(!known){await h.rpc.request({method:'hardhat_mine',params:['0x1a']});continue;}await h.mine(h.contract.settle(TX));}
  assert.equal(await h.contract.pendingRandom(),0n);
  assert.deepEqual(await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i))),small);
  assert.equal(await h.contract.paidAvailability(),0n);
  const p=await h.approval(h.a,'eleven','',{choice:3});
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/PAID_NOT_AVAILABLE/);
 }finally{await h.close();}
});

test('R6 price (owner 2026-10-28): the proposed Genesis paid price is 20 imdUSD + 1,200 GOLD, paid to the treasury Safe, proposed only and never approved here',async()=>{
 const {readFileSync}=await import('node:fs'),policy=await import('../lib/policy.mjs');
 const cfg=JSON.parse(readFileSync(new URL('../config/genesis.json',import.meta.url),'utf8'));
 assert.equal(policy.PROPOSED_PRICE_ATOMIC,20n*10n**18n);assert.equal(policy.PROPOSED_GOLD_COST,1200n);
 assert.equal(cfg.paid.proposedPrice,20);assert.equal(cfg.paid.proposedPriceAtomic,'20000000000000000000');assert.equal(cfg.paid.goldCost,1200);
 assert.equal(cfg.paymentToken,'0x61aaf8a992a3143e2b0c9cb0030b9fe702854a25');assert.equal(cfg.paymentTokenSymbol,'imdUSD');assert.equal(cfg.paymentDecimals,18);
 assert.equal(ethers.getAddress(cfg.receivingAddress),'0x29e7c208481f648795f677b55F6ECb2bADc2F01E');   // EmberEvo Treasury (Safe 2 of 3)
 assert.equal(cfg.paid.priceApproved,false);assert.equal(cfg.paid.priceStatus,'PROPOSED_NOT_APPROVED');
 assert.equal(cfg.fixtureOnly.embeoAtomic,'400000000000000000000000');   // only the local fixture token's amount; its GOLD stays 1 (a mechanics unit: the GOLD ledger and the fixture contracts count whole GOLD)
});
