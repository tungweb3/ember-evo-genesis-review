import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,COST,TX} from './hardening-harness.mjs';
import config from '../config/genesis.json' with {type:'json'};
import {ethers} from '../tools/runtime.mjs';

// Owner 2026-10-29: imdUSD v1 is the deployment's payment token; the owner adds USDC (6 decimals) before minting opens
// and imdUSD v2 (18 decimals, the imdUSD team's suggestion) when it exists. At most two more tokens, each once, usable
// PAYMENT_TOKEN_DELAY after being added, all at the same dollar price and recipient. Each token has its own GOLD price:
// paying in imdUSD is a GOLD discount (mainnet: imdUSD 1,200 GOLD, USDC 1,600 GOLD; here the fixture's GOLD and USDC_GOLD).
const RECIPIENT=config.receivingAddress,DELAY=2*24*3600,USDC_COST=COST/10n**12n,GOLD=BigInt(config.fixtureOnly.gold),USDC_GOLD=1600n;
async function later(h,s){await h.rpc.request({method:'evm_increaseTime',params:[s]});await h.rpc.request({method:'evm_mine',params:[]});}
function events(h,rc,name){return rc.logs.map(l=>{try{return h.contract.interface.parseLog(l);}catch{return null;}}).filter(l=>l?.name===name);}
const unpack=v=>({amount:v&((1n<<128n)-1n),gold:(v>>128n)&((1n<<88n)-1n),usableAt:v>>216n});
async function setup(){
 const h=await harness();await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*10n,TX));
 const usdc=await h.deploy('contracts/test/Fixtures.sol:DecimalsToken',[h.a,6]),v2=await h.deploy('contracts/test/Fixtures.sol:FixtureToken',[h.a]);
 for(const t of [usdc,v2])await h.mine(t.connect(h.alice).approve(h.contract.target,COST*10n,TX));
 return {h,usdc,v2};
}
// an order signed (GOLD reserved) at `gold` for payment in `token` (Swarm audit 944905c3: the signature names the token)
const args=async(h,tag,gold=GOLD,token=h.token.target)=>h.paidArgs(await h.approval(h.a,tag,undefined,{choice:0}),undefined,undefined,undefined,gold,token);
const pay=async(h,a,token)=>h.mine(h.contract.connect(h.alice).mintPaid(...a,await h.reveals(),token,TX));
const refuse=async(h,a,token,re)=>assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...a,await h.reveals(),token),re);

test('the deployment token is in the table from the start at paidCost and paidGoldCost; any other token is refused until added',async()=>{
 const {h,usdc}=await setup();try{
  assert.deepEqual(unpack(await h.contract.paymentTokens(h.token.target)),{amount:COST,gold:await h.contract.paidGoldCost(),usableAt:0n});
  const a=await args(h,'none');
  for(const t of [usdc.target,'0x0000000000000000000000000000000000000000',h.contract.target])await refuse(h,a,t,/PAYMENT_TOKEN_UNAVAILABLE/);
  const before=await h.token.balanceOf(RECIPIENT);await pay(h,a,h.token.target);assert.equal(await h.token.balanceOf(RECIPIENT),before+COST);
 }finally{h.close();}
});

test('only the owner adds, at most two tokens, each once; 6 or 18 decimals, a contract, not paymentToken or the recipient; a GOLD price in range',async()=>{
 const {h,usdc,v2}=await setup();try{
  await assert.rejects(h.contract.connect(h.alice).addPaymentToken.staticCall(usdc.target,USDC_GOLD),/OwnableUnauthorizedAccount/);
  const eight=await h.deploy('contracts/test/Fixtures.sol:DecimalsToken',[h.a,8]);
  for(const bad of [h.token.target,RECIPIENT,h.contract.target,h.b,eight.target])
   await assert.rejects(h.contract.addPaymentToken.staticCall(bad,USDC_GOLD),/TOKEN_IDENTITY_REQUIRED|reverted/,bad);
  for(const gold of [0n,1n<<88n])await assert.rejects(h.contract.addPaymentToken.staticCall(usdc.target,gold),/TOKEN_IDENTITY_REQUIRED/,String(gold));
  const rc=await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX)),at=BigInt((await h.provider.getBlock(rc.blockNumber)).timestamp);
  const [ev]=events(h,rc,'PaymentTokenAdded');
  assert.deepEqual([ev.args.token,ev.args.amount,ev.args.goldCost,ev.args.usableAt],[usdc.target,USDC_COST,USDC_GOLD,at+BigInt(DELAY)]);
  assert.deepEqual(unpack(await h.contract.paymentTokens(usdc.target)),{amount:USDC_COST,gold:USDC_GOLD,usableAt:at+BigInt(DELAY)});
  await assert.rejects(h.contract.addPaymentToken.staticCall(usdc.target,USDC_GOLD),/TOKEN_IDENTITY_REQUIRED/);   // once only
  await h.mine(h.contract.addPaymentToken(v2.target,GOLD,TX));
  assert.deepEqual(unpack(await h.contract.paymentTokens(v2.target)).amount,COST);
  const third=await h.deploy('contracts/test/Fixtures.sol:FixtureToken',[h.a]);
  await assert.rejects(h.contract.addPaymentToken.staticCall(third.target,GOLD),/TOKEN_IDENTITY_REQUIRED/);   // at most two
 }finally{h.close();}
});

test('an added token pays only after the delay: 20 USDC (6 decimals) at its GOLD price or 20 v2 at the discounted one',async()=>{
 const {h,usdc,v2}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));await h.mine(h.contract.addPaymentToken(v2.target,GOLD,TX));
  await later(h,DELAY-60);
  await refuse(h,await args(h,'early',USDC_GOLD,usdc.target),usdc.target,/PAYMENT_TOKEN_UNAVAILABLE/);
  await later(h,60);
  for(const [t,amount,gold,tag] of [[usdc,USDC_COST,USDC_GOLD,'usdc'],[v2,COST,GOLD,'v2']]){
   const a=await args(h,tag,gold,t.target),first=await h.token.balanceOf(h.a),before=await t.balanceOf(RECIPIENT),payer=await t.balanceOf(h.a);
   const rc=await pay(h,a,t.target);
   assert.equal(await t.balanceOf(RECIPIENT),before+amount);assert.equal(await t.balanceOf(h.a),payer-amount);assert.equal(await h.token.balanceOf(h.a),first);
   // the GOLD book reads these: GenesisMinted.cost is the dollar price in 18 decimals whichever token paid, and
   // PaidOrderConsumed.goldCost is the GOLD price of the token actually paid
   const [minted]=events(h,rc,'GenesisMinted'),[consumed]=events(h,rc,'PaidOrderConsumed');
   assert.equal(minted.args.cost,COST);assert.equal(minted.args.paid,true);assert.equal(consumed.args.orderId,a[3]);assert.equal(consumed.args.goldCost,gold);
  }
  const b=await args(h,'v1'),r=await h.token.balanceOf(RECIPIENT),rc=await pay(h,b,h.token.target);
  assert.equal(await h.token.balanceOf(RECIPIENT),r+COST);assert.equal(events(h,rc,'PaidOrderConsumed')[0].args.goldCost,GOLD);
  assert.equal(await h.contract.totalMinted(),3n);
 }finally{h.close();}
});

test('the discount cannot be moved to another token: an order reserved at one GOLD price is refused in a token with another',async()=>{
 const {h,usdc}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));await later(h,DELAY);
  // reserved at the imdUSD (discounted) price, paid in USDC: refused; reserved at the USDC price, paid in imdUSD: refused
  await refuse(h,await args(h,'cheap'),usdc.target,/GOLD_RESERVATION_AUTHORITY/);
  await refuse(h,await args(h,'dear',USDC_GOLD),h.token.target,/GOLD_RESERVATION_AUTHORITY/);
  // each in its own token is accepted
  await pay(h,await args(h,'ok1',USDC_GOLD,usdc.target),usdc.target);await pay(h,await args(h,'ok2'),h.token.target);
 }finally{h.close();}
});

// Swarm audit 2026-10-29 (job 944905c3 finding 1): two tokens at the same GOLD price (imdUSD v1 and v2) are not
// interchangeable either, so the signer alone decides which listed tokens it still issues orders for.
test('an order signed for one token is refused in another at the same GOLD price, and a USDC price signed for imdUSD is refused',async()=>{
 const {h,usdc,v2}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));await h.mine(h.contract.addPaymentToken(v2.target,GOLD,TX));await later(h,DELAY);
  await refuse(h,await args(h,'for-v2',GOLD,v2.target),h.token.target,/GOLD_RESERVATION_AUTHORITY/);
  await refuse(h,await args(h,'for-v1',GOLD,h.token.target),v2.target,/GOLD_RESERVATION_AUTHORITY/);
  await refuse(h,await args(h,'usdc-price-v1',USDC_GOLD,h.token.target),usdc.target,/GOLD_RESERVATION_AUTHORITY/);
  const a=await args(h,'v2-ok',GOLD,v2.target),before=await v2.balanceOf(RECIPIENT);await pay(h,a,v2.target);
  assert.equal(await v2.balanceOf(RECIPIENT),before+COST);
 }finally{h.close();}
});

test('one order is consumed once whichever token pays; a short balance or a taxed added token is refused',async()=>{
 const {h,usdc}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,GOLD,TX));await later(h,DELAY);
  const a=await args(h,'once',GOLD,usdc.target);await pay(h,a,usdc.target);
  for(const t of [usdc.target,h.token.target])await refuse(h,a,t,/PAID_ORDER_UNAVAILABLE/);
  // a wallet with 19.999999 USDC cannot pay
  await h.mine(usdc.connect(h.alice).transfer(h.b,(await usdc.balanceOf(h.a))-USDC_COST+1n,TX));
  await refuse(h,await args(h,'short',GOLD,usdc.target),usdc.target,/BALANCE_REQUIRED/);
  const fee=await h.deploy('contracts/test/Fixtures.sol:FeeToken',[h.a]);await h.mine(fee.connect(h.alice).approve(h.contract.target,COST,TX));
  await h.mine(h.contract.addPaymentToken(fee.target,GOLD,TX));await later(h,DELAY);
  await refuse(h,await args(h,'fee',GOLD,fee.target),fee.target,/EXACT_PAYMENT_REQUIRED/);
 }finally{h.close();}
});

// Review 2026-10-29: the exact second an added token opens, a hostile added token, a paused mint, a new owner.
async function at(h,t){await h.rpc.request({method:'evm_setNextBlockTimestamp',params:[Number(t)]});}
test('an added token opens at exactly usableAt: refused one second before, accepted at that second',async()=>{
 const {h,usdc}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));const {usableAt}=unpack(await h.contract.paymentTokens(usdc.target));
  await later(h,DELAY-300);
  const a=await args(h,'edge-a',USDC_GOLD,usdc.target),b=await args(h,'edge-b',USDC_GOLD,usdc.target);
  await at(h,usableAt-1n);await assert.rejects(pay(h,a,usdc.target));
  await at(h,usableAt);const rc=await pay(h,b,usdc.target);
  assert.equal(BigInt((await h.provider.getBlock(rc.blockNumber)).timestamp),usableAt);assert.equal(rc.status,1);
 }finally{h.close();}
});
test('a hostile added token cannot re-enter mintPaid, mintFree or settle from its transfer',async()=>{
 const {h}=await setup();try{
  const hook=await h.deploy('contracts/test/R3Fixtures.sol:R3HookToken',[h.a]);await h.mine(hook.connect(h.alice).approve(h.contract.target,COST*10n,TX));
  await h.mine(h.contract.addPaymentToken(hook.target,USDC_GOLD,TX));await later(h,DELAY);
  const guard=ethers.AbiCoder.defaultAbiCoder().encode(['string'],['REENTRANT_CALL']);   // Error(string) 'REENTRANT_CALL'
  for(const [name,inner] of [['mintPaid',[...await args(h,'inner',USDC_GOLD,hook.target),[],hook.target]],
   ['mintFree',[ethers.ZeroHash,0,'',0,'0x',0,[],[]]],['settle',[[]]]]){
   await h.mine(hook.setHook(h.contract.target,h.contract.interface.encodeFunctionData(name,inner),TX));
   const before=await h.contract.totalMinted();await pay(h,await args(h,'outer-'+name.toLowerCase(),USDC_GOLD,hook.target),hook.target);
   assert.equal(await h.contract.totalMinted(),before+1n,name);assert.equal(await hook.hookSucceeded(),false,name);
   const r=await hook.hookResult();assert.equal(r.slice(0,10),'0x08c379a0',name);assert.equal('0x'+r.slice(10),guard,name);
  }
 }finally{h.close();}
});
test('a paused mint refuses an added token too, and a new owner can add a token the old owner did not',async()=>{
 const {h,usdc,v2}=await setup();try{
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));await later(h,DELAY);
  await h.mine(h.contract.setMintPaused(true,TX));
  await refuse(h,await args(h,'paused',USDC_GOLD,usdc.target),usdc.target,/MINT_NOT_READY/);
  await h.mine(h.contract.setMintPaused(false,TX));
  await h.mine(h.contract.transferOwnership(h.b,TX));await h.mine(h.contract.connect(h.bob).acceptOwnership(TX));
  await assert.rejects(h.contract.addPaymentToken.staticCall(v2.target,GOLD),/OwnableUnauthorizedAccount/);
  await h.mine(h.contract.connect(h.bob).addPaymentToken(v2.target,GOLD,TX));
  assert.equal(unpack(await h.contract.paymentTokens(v2.target)).gold,GOLD);
 }finally{h.close();}
});
