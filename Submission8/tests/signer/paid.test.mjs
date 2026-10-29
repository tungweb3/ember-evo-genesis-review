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
// The book's code (review 2026-10-29): WORLD_BOOK, else the World source that will ship it (feature/genesis-gold), else
// the World copy above. The test-GOLD seed and its migration exist only in the Sepolia copy (WORLD).
const BOOK=new URL([process.env.WORLD_BOOK,'D:/EmberWorld_rebuild/workspace/world-newspaper-2026-10-24/genesis-gold-source'].filter(Boolean)
 .map(p=>'file:///'+p.replaceAll('\\','/').replace(/\/?$/,'/')).find(u=>existsSync(fileURLToPath(new URL('server/genesis-gold.ts',u))))??WORLD.href);
const present=existsSync(fileURLToPath(new URL('server/genesis-gold.ts',WORLD)))&&existsSync(fileURLToPath(new URL('scripts/sepolia-gold-seed.mjs',WORLD)));
const SEPOLIA=11155111,BASE='ipfs://REHEARSAL/looks/';
const look=(o={})=>({body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null,...o});
const code=async(p,c)=>{await assert.rejects(p,e=>{assert.equal(e.code??e.message,c);return true;});};

async function setup(grantGold=3,addedTokens=[]){
 const w=async p=>import(new URL(p,WORLD).href),b=async p=>import(new URL(p,BOOK).href);
 const [{openD1},{buildSeedSql},svc,gg,reader,wg]=await Promise.all([b('tests/d1-sqlite.mjs'),w('scripts/sepolia-gold-seed.mjs'),b('server/genesis-gold-service.ts'),
  b('server/genesis-gold.ts'),b('server/genesis-gold-reader.ts'),b('server/world-gold.ts')]);
 const h=await harness('FixtureToken','EmberEvoGenesisCandidate',SEPOLIA);
 await h.configure([],undefined,{pending:'ipfs://REHEARSAL/pending.json',base:BASE});
 const db=openD1();db.raw.exec(readFileSync(new URL('migrations-sepolia/9001_sepolia_test_gold.sql',WORLD),'utf8'));
 const contract=h.contract.target.toLowerCase();
 const dep={id:'sepolia-r5-rehearsal-1',environment:'sepolia',chainId:SEPOLIA,contract,codeHash:ethers.keccak256(await h.provider.getCode(contract)),
  deployBlock:String(await h.contract.startBlock()),embeoCost:String(await h.contract.paidCost()),paymentToken:h.token.target.toLowerCase(),goldCost:String(await h.contract.paidGoldCost()),signer:h.approvalSigner.address,
  recipient:(await h.contract.paymentRecipient()).toLowerCase(),domainVersion:'7',addedTokens};
 let nowMs=0;const sync=async()=>{nowMs=Number((await h.provider.getBlock('latest')).timestamp)*1000;};await sync();
 db.raw.exec(buildSeedSql({batch:'rehearsal-1',source:'paid route end-to-end test',wallets:[{wallet:h.a,cap:100,note:'test wallet alice'}],grants:[{wallet:h.a,amount:grantGold}]},nowMs));
 const gold=svc.createGenesisGoldService({DB:db},{deployments:[dep],environment:'sepolia'},fetch,()=>nowMs);
 const paid=new PaidApprovalSigner({provider:h.provider,contractAddress:h.contract.target,chainId:SEPOLIA,signer:h.approvalSigner,metadataBase:BASE,
  gold,deploymentId:dep.id,ticketSecret:'rehearsal-ticket-secret-0123456789abcdef'});
 const rpc=(method,params)=>h.rpc.request({method,params});
 const settle=async orderId=>{await sync();return gg.reconcileGenesisGold(db,[dep],'sepolia',(d,hint)=>reader.createGenesisR5Reader(d,rpc,hint),{deploymentId:dep.id,orderId},nowMs);};
 const balance=async()=>{const s=await wg.worldGoldSnapshot(db,h.a.toLowerCase(),nowMs);return [s.book,s.reserved,s.available];};
 const order=async(l,choice,who=h.alice,token=h.token.target)=>{await sync();const p=await paid.prepare({wallet:await who.getAddress(),look:l,choice,token});
  const consentSignature=await who.signTypedData(p.consent.domain,p.consent.types,p.consent.message);return {p,req:{order:p.order,uri:p.uri,ticket:p.ticket,consentSignature}};};
 const mint=async(m,who=h.alice)=>{await h.mine(h.token.connect(who).approve(h.contract.target,await h.contract.paidCost(),TX));
  return h.mine(h.contract.connect(who).mintPaid(m.lookKey,m.choice,m.uri,m.orderId,m.deadline,m.goldSignature,await h.reveals(),m.token,TX));};
 return {h,db,dep,paid,gold,settle,balance,order,mint,sync,close:()=>h.close()};
}

test('paid mint end to end: consent, GOLD held, R5 mint pays the treasury recipient, finalized reconcile spends the GOLD exactly once',{skip:!present&&'World copy not present'},async()=>{
 const f=await setup();try{
  const {p,req}=await order(f,look(),1);
  assert.equal(p.order.goldCost,f.dep.goldCost);assert.equal(p.order.embeoCost,f.dep.embeoCost);assert.equal(p.uri,BASE+p.order.lookKey+'/1');
  const recipient=await f.h.contract.paymentRecipient();assert.equal(p.order.recipient,recipient.toLowerCase());assert.equal(f.dep.recipient,recipient.toLowerCase());
  const a=await f.paid.approve(req);assert.deepEqual(a.gold,{state:'held',book:'3',reserved:'1',available:'2'});
  // one signature, and the transaction carries only the order id and deadline (2026-10-28)
  assert.deepEqual(Object.keys(a.mintPaid).sort(),['choice','deadline','goldSignature','lookKey','orderId','token','uri']);assert.equal(a.mintPaid.token,f.h.token.target);assert.equal(a.mintPaid.orderId,p.order.orderId);assert.equal(a.mintPaid.deadline,p.order.deadline);
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
  await f.h.mine(f.h.contract.setMintPaused(true,TX));await code(f.paid.prepare({wallet:f.h.a,look:look({hat:'HAT_BERET.beret'}),choice:1,token:f.h.token.target}),'MINT_PAUSED');
  const ORIGIN='https://mint.example.test';
  const on=createHandler({approver:async()=>{throw Error('unused');},paidApprover:async()=>f.paid,allowedOrigins:[ORIGIN]});
  const off=createHandler({approver:async()=>{throw Error('unused');},allowedOrigins:[ORIGIN]});
  const post=(fetch,path)=>fetch(new Request('https://signer.example.test'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'{}'}));
  assert.equal((await post(off,'/v1/paid/prepare')).status,501);assert.equal((await post(off,'/v1/approval/paid')).status,501);
  assert.deepEqual(await (await post(on,'/v1/paid/prepare')).json(),{ok:false,error:{code:'REQUEST_FIELDS_INVALID'}});
 }finally{await f.close();}
});
const order=(f,...a)=>f.order(...a);
test('owner 2026-10-29: a paid mint paid in an added token (USDC, 6 decimals) at its own GOLD price is held and settled at that price by the World book',{skip:!present&&'World copy not present'},async()=>{
 // the fixture's imdUSD GOLD price is 1; USDC's is 2 (mainnet: 1,200 and 1,600)
 const f=await setup(3);try{
  const usdc=await f.h.deploy('contracts/test/Fixtures.sol:DecimalsToken',[f.h.a,6]);
  f.dep.addedTokens.push({token:usdc.target.toLowerCase(),goldCost:'2'});   // the registry entry lists USDC at its GOLD price
  assert.equal(await f.h.contract.paidGoldCost(),1n);
  await f.h.mine(f.h.contract.addPaymentToken(usdc.target,2n,TX));
  await f.h.rpc.request({method:'evm_increaseTime',params:[2*24*3600]});await f.h.rpc.request({method:'evm_mine',params:[]});
  const {p,req}=await order(f,look(),1,f.h.alice,usdc.target),a=await f.paid.approve(req),m=a.mintPaid,recipient=await f.h.contract.paymentRecipient();
  const amount=BigInt(p.payment.amount);assert.equal(amount*10n**12n,await f.h.contract.paidCost());assert.equal(p.payment.token,usdc.target.toLowerCase());
  assert.deepEqual([p.order.goldCost,a.gold.reserved,p.order.token,m.token],['2','2',usdc.target.toLowerCase(),usdc.target]);
  await f.h.mine(usdc.connect(f.h.alice).approve(f.h.contract.target,amount,TX));
  const before=await usdc.balanceOf(recipient),imd=await f.h.token.balanceOf(recipient);
  const rc=await f.h.mine(f.h.contract.connect(f.h.alice).mintPaid(m.lookKey,m.choice,m.uri,m.orderId,m.deadline,m.goldSignature,await f.h.reveals(),usdc.target,TX));
  assert.equal(rc.status,1);assert.equal(await usdc.balanceOf(recipient)-before,amount);assert.equal(await f.h.token.balanceOf(recipient),imd);
  const s=await f.settle(p.order.orderId);assert.deepEqual([s.state,s.reconciliation],['consumed','settled'],JSON.stringify(s));
  assert.deepEqual(await f.balance(),['1','0','1']);
 }finally{await f.close();}
});

// Owner 2026-10-29: paying in imdUSD is a GOLD discount (mainnet imdUSD 1,200 GOLD, USDC 1,600). The order's goldCost is the
// chosen token's GOLD price; the GOLD book is a stub here (the World book's own tests cover holding either price).
test('owner 2026-10-29: the order holds the GOLD price of the chosen token, and the signed order pays only in a token with that price',async()=>{
 const h=await harness('FixtureToken','EmberEvoGenesisCandidate',SEPOLIA);
 try{
  await h.configure([],undefined,{pending:'ipfs://REHEARSAL/pending.json',base:BASE});
  const usdc=await h.deploy('contracts/test/Fixtures.sol:DecimalsToken',[h.a,6]),USDC_GOLD=(await h.contract.paidGoldCost())+400n;
  const held=[];const gold={reserve:async r=>{held.push(r.order.goldCost);return {state:'held',book:'0',reserved:r.order.goldCost,available:'0'};}};
  const paid=new PaidApprovalSigner({provider:h.provider,contractAddress:h.contract.target,chainId:SEPOLIA,signer:h.approvalSigner,metadataBase:BASE,
   gold,deploymentId:'stub',ticketSecret:'rehearsal-ticket-secret-0123456789abcdef'});
  const ask=async(token,l)=>{const p=await paid.prepare({wallet:h.a,look:l,choice:1,token});
   const a=await paid.approve({order:p.order,uri:p.uri,ticket:p.ticket,consentSignature:await h.alice.signTypedData(p.consent.domain,p.consent.types,p.consent.message)});return {p,m:a.mintPaid};};
  await code(paid.prepare({wallet:h.a,look:look(),choice:1,token:usdc.target}),'PAYMENT_TOKEN_UNAVAILABLE');   // not added
  await h.mine(h.contract.addPaymentToken(usdc.target,USDC_GOLD,TX));
  await code(paid.prepare({wallet:h.a,look:look(),choice:1,token:usdc.target}),'PAYMENT_TOKEN_UNAVAILABLE');   // not usable yet
  await h.rpc.request({method:'evm_increaseTime',params:[2*24*3600]});await h.rpc.request({method:'evm_mine',params:[]});
  await code(paid.prepare({wallet:h.a,look:look(),choice:1}),'REQUEST_FIELDS_INVALID');   // the token must be named
  // Swarm audit 944905c3: a signer configured for some tokens only refuses the others, though they stay listed on chain
  const imdOnly=new PaidApprovalSigner({provider:h.provider,contractAddress:h.contract.target,chainId:SEPOLIA,signer:h.approvalSigner,metadataBase:BASE,
   gold,deploymentId:'stub',ticketSecret:'rehearsal-ticket-secret-0123456789abcdef',allowedTokens:[h.token.target]});
  await code(imdOnly.prepare({wallet:h.a,look:look(),choice:1,token:usdc.target}),'PAYMENT_TOKEN_UNAVAILABLE');
  assert.equal((await imdOnly.prepare({wallet:h.a,look:look(),choice:1,token:h.token.target})).order.token,h.token.target.toLowerCase());
  // Swarm audit e9fc751f: an order prepared before the token was excluded (same TICKET_SECRET) gets no hold and no
  // signature, a retried approve neither; a malformed PAYMENT_TOKENS entry is a configuration error, not WALLET_INVALID
  const early=await paid.prepare({wallet:h.a,look:look(),choice:1,token:usdc.target});
  const earlyReq={order:early.order,uri:early.uri,ticket:early.ticket,consentSignature:await h.alice.signTypedData(early.consent.domain,early.consent.types,early.consent.message)};
  for(let i=0;i<2;i++)await code(imdOnly.approve(earlyReq),'PAYMENT_TOKEN_UNAVAILABLE');
  assert.deepEqual(held,[]);
  for(const bad of [[h.token.target,'0xabc'],[h.token.target,'0x'+'0'.repeat(40)]])
   assert.throws(()=>new PaidApprovalSigner({provider:h.provider,contractAddress:h.contract.target,chainId:SEPOLIA,signer:h.approvalSigner,metadataBase:BASE,
    gold,deploymentId:'stub',ticketSecret:'rehearsal-ticket-secret-0123456789abcdef',allowedTokens:bad}),e=>e.code==='CONFIG_PAYMENT_TOKENS'&&e.status===500);
  const imd=await ask(h.token.target,look({hat:'HAT_BERET.beret'})),dollar=await ask(usdc.target,look({hat:'HAT_PEAKED.captain'}));
  assert.deepEqual([imd.p.order.goldCost,imd.p.payment.goldCost,imd.p.payment.amount],[String(await h.contract.paidGoldCost()),String(await h.contract.paidGoldCost()),String(await h.contract.paidCost())]);
  assert.deepEqual([dollar.p.order.goldCost,dollar.p.payment.goldCost,dollar.p.payment.amount],[String(USDC_GOLD),String(USDC_GOLD),String((await h.contract.paidCost())/10n**12n)]);
  assert.deepEqual(held,[imd.p.order.goldCost,dollar.p.order.goldCost]);
  for(const t of [h.token,usdc])await h.mine(t.connect(h.alice).approve(h.contract.target,await h.contract.paidCost(),TX));
  const call=async(m,token)=>[m.lookKey,m.choice,m.uri,m.orderId,m.deadline,m.goldSignature,await h.reveals(),token];
  // the discounted imdUSD order cannot be paid in USDC, nor the USDC order in imdUSD
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await call(imd.m,usdc.target)),/GOLD_RESERVATION_AUTHORITY/);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await call(dollar.m,h.token.target)),/GOLD_RESERVATION_AUTHORITY/);
  for(const [x,t] of [[imd,h.token.target],[dollar,usdc.target]]){
   const rc=await h.mine(h.contract.connect(h.alice).mintPaid(...await call(x.m,t),TX));
   const [c]=rc.logs.map(l=>{try{return h.contract.interface.parseLog(l);}catch{return null;}}).filter(l=>l?.name==='PaidOrderConsumed');
   assert.equal(String(c.args.goldCost),x.p.order.goldCost);assert.equal(x.m.token,t);
  }
  // Swarm audit 944905c3 finding 1: a second token at imdUSD's GOLD price (imdUSD v2) does not pay an imdUSD order, nor the reverse
  const v2=await h.deploy('contracts/test/Fixtures.sol:FixtureToken',[h.a]);
  await h.mine(h.contract.addPaymentToken(v2.target,await h.contract.paidGoldCost(),TX));
  await h.rpc.request({method:'evm_increaseTime',params:[2*24*3600]});await h.rpc.request({method:'evm_mine',params:[]});
  await h.mine(v2.connect(h.alice).approve(h.contract.target,await h.contract.paidCost(),TX));await h.mine(h.token.connect(h.alice).approve(h.contract.target,await h.contract.paidCost(),TX));
  const forV2=await ask(v2.target,look({hat:'HAT_BERET.beret'})),forV1=await ask(h.token.target,look({hat:'HAT_PEAKED.captain'}));
  assert.equal(forV2.p.order.goldCost,forV1.p.order.goldCost);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await call(forV2.m,h.token.target)),/GOLD_RESERVATION_AUTHORITY/);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await call(forV1.m,v2.target)),/GOLD_RESERVATION_AUTHORITY/);
  assert.equal((await h.mine(h.contract.connect(h.alice).mintPaid(...await call(forV2.m,forV2.m.token),TX))).status,1);
 }finally{h.close();}
});
