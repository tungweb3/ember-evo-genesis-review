import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,COST,TX,REVEAL_CHAIN} from './hardening-harness.mjs';
import {ethers,testAuthority} from '../tools/runtime.mjs';
import {GOLD_TYPES} from '../../service/gold-ledger.mjs';

const BURN='0x000000000000000000000000000000000000dEaD';
const CAPS=[768n,168n,168n,68n,68n,48n];   // R6 deployment caps (owner 2026-10-25), sum 1,288
const coder=ethers.AbiCoder.defaultAbiCoder();
async function mineBlocks(h,n){if(n>0)await h.rpc.request({method:'hardhat_mine',params:['0x'+n.toString(16)]});}
/** Seal (re-arming an expired seed block if needed) and reveal every epoch whose seed is already knowable. */
async function revealReady(h){for(;;){const [exists,,known]=await h.contract.nextRevealEpoch();if(!exists||!known)return;await h.mine(h.contract.settle(TX));}}
async function mintPaid(h,tag,choice,who=h.alice){await revealReady(h);const p=await h.approval(await who.getAddress(),tag,undefined,{choice});const args=await h.paidArgs(p);return h.mine(h.contract.connect(who).mintPaid(...args,TX));}
// h.configure locks the reveal URIs (pending / revealed/) and sets the reveal commitment before opening (2026-10-27)
async function open(h,mints){await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*BigInt(mints),TX));}
/** seed = keccak256(abi.encode(seedBlockHash, secret, epoch, contract)) */
const seedOf=(h,blockHash,secret,ep)=>ethers.keccak256(coder.encode(['bytes32','bytes32','uint256','address'],[blockHash,secret,ep,h.contract.target]));
function events(h,receipt,name){return receipt.logs.map(l=>{try{return h.contract.interface.parseLog(l);}catch{return null;}}).filter(l=>l?.name===name);}
async function sealNow(h,e){const sb=Number(await h.contract.epochSeedBlock(e)),now=Number(await h.provider.getBlockNumber());if(now<=sb)await mineBlocks(h,sb-now+1);return h.mine(h.contract.settle(TX));}
/** Off-chain replica of _reveal, used to check the contract result token by token. */
function draw(seed,id,counts){const rem=CAPS.map((c,i)=>c-counts[i]),total=rem.reduce((a,b)=>a+b,0n);let r=BigInt(ethers.keccak256(coder.encode(['bytes32','uint256'],[seed,id])))%total;let s=0;for(;s<6;s++){if(r<rem[s])break;r-=rem[s];}return s;}

test('R5: four choices only; chosen skins fix the skin at mint; choice above random is rejected',async()=>{
 const h=await harness();try{await open(h,4);
  for(const [i,choice] of [0,1,2].entries()){const rc=await mintPaid(h,'direct-'+i,choice);const ev=events(h,rc,'GenesisMinted')[0];assert.equal(ev.args.choice,BigInt(choice));assert.equal(ev.args.skin,BigInt(choice));const [skin,revealed]=await h.contract.skinOf(i+1);assert.equal(skin,BigInt(choice));assert.equal(revealed,true);}
  for(const bad of [4,5,255]){const p=await h.approval(h.a,'bad-'+bad,'ipfs://LOCAL_ONLY/x',{choice:bad});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/APPEARANCE_INVALID/);}
  assert.deepEqual([0,1,2,3,4,5].map(i=>i),[0,1,2,3,4,5]);
  assert.deepEqual(await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i))),[1n,1n,1n,0n,0n,0n]);
 }finally{await h.close();}
});
test('R5: random mint reveals no skin at mint (event skin = 6, skinOf pending) and needs an empty URI',async()=>{
 const h=await harness();try{await open(h,2);
  const p=await h.approval(h.a,'rnd-uri','ipfs://LOCAL_ONLY/should-be-empty',{choice:3});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/RANDOM_URI_NOT_ALLOWED/);
  const d=await h.approval(h.a,'direct-empty','',{choice:0});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(d)),/METADATA_REQUIRED/);
  const rc=await mintPaid(h,'rnd',3);const ev=events(h,rc,'GenesisMinted')[0];assert.equal(ev.args.skin,6n);
  const [skin,revealed]=await h.contract.skinOf(1);assert.equal(revealed,false);assert.equal(skin,0n);assert.equal(await h.contract.pendingRandom(),1n);
 }finally{await h.close();}
});
test('R5: per-skin caps hold for direct picks; a full skin rejects direct picks with SKIN_SOLD_OUT',async()=>{
 const h=await harness('FixtureToken','SupplyBoundaryHarness');try{await open(h,3);
  await h.mine(h.contract.seedSkinForTest(1,167n,TX));
  await mintPaid(h,'last-ice',1);assert.equal(await h.contract.skinCount(1),168n);
  const p=await h.approval(h.a,'over-ice',undefined,{choice:1});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/SKIN_SOLD_OUT/);
  await mintPaid(h,'still-green',0);assert.equal(await h.contract.skinCount(0),1n);
 }finally{await h.close();}
});
test('R6: looks may repeat: the same look mints again in the same skin, in another skin and as random',async()=>{
 const h=await harness();try{await open(h,6);
  await mintPaid(h,'look-a',0);await mintPaid(h,'look-a',0);await mintPaid(h,'look-a',1);await mintPaid(h,'look-a',3);
  assert.equal(await h.contract.totalMinted(),4n);
  const keys=await Promise.all([1,2,3,4].map(async i=>(await h.contract.tokenLook(i)).lookKey));assert.equal(new Set(keys).size,1);
  const abi=h.contract.interface.fragments.map(f=>f.name??'');assert.equal(abi.some(n=>/^(lookUsedAny|lookSkinUsed|lookLockedByRandom|appearanceUsed)$/.test(n)),false);
 }finally{await h.close();}
});
test('epochs: settle waits for the seed block, mixes its hash with the next committed secret, seals and reveals in one call, cannot repeat; the draw follows the published algorithm',async()=>{
 const h=await harness();try{await open(h,5);
  for(let i=0;i<4;i++)await mintPaid(h,'rnd-'+i,3);
  const ep=(await h.epochOf(1));
  for(let id=2;id<=4;id++)assert.equal((await h.epochOf(id))>=ep,true);
  const sb=Number(await h.contract.epochSeedBlock(ep));
  if(Number(await h.provider.getBlockNumber())<sb)await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(1)]),/NOTHING_TO_SETTLE/);
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  // a wrong secret settles nothing; the right one is the first of the test chain and advances the commitment to it
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(2)]),/NOTHING_TO_SETTLE/);
  const n=Number(await h.contract.epochRandomCount(ep)),counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));
  const rc=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));const sealed=events(h,rc,'EpochSealed')[0];
  const blockHash=(await h.provider.getBlock(sb)).hash;assert.equal(sealed.args.blockHash,blockHash);assert.equal(sealed.args.secret,REVEAL_CHAIN.secret(1));
  assert.equal(sealed.args.seed,seedOf(h,blockHash,REVEAL_CHAIN.secret(1),ep));
  assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(1));assert.equal(await h.contract.revealedSecrets(),1n);
  const expected=[];for(let i=0;i<n;i++){const id=await h.contract.epochRandomToken(ep,i),s=draw(sealed.args.seed,id,counts);counts[s]++;expected.push([id,s]);}
  assert.equal(events(h,rc,'SkinRevealed').length,n);
  for(const [id,s] of expected){const [skin,revealed]=await h.contract.skinOf(id);assert.equal(revealed,true);assert.equal(skin,BigInt(s));}
  assert.equal(await h.contract.pendingRandom(),BigInt(4-n));
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(1)]),/NOTHING_TO_SETTLE/);   // used up
 }finally{await h.close();}
});
test('audit 2026-10-27 finding 5: an expired seed block is never sealed with the secret alone: its secret is used up, the epoch is re-armed, and the next (unpublished) secret decides with a fresh block hash (Cancun: no EIP-2935 history, window 256)',async()=>{
 const h=await harness();try{await open(h,1);await mintPaid(h,'late',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const rc=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));
  assert.equal(events(h,rc,'EpochSealed').length,0);const re=events(h,rc,'EpochRearmed')[0];
  assert.equal(re.args.epoch,BigInt(ep));assert.equal(re.args.expired,true);assert.equal(re.args.newSeedBlock,BigInt(rc.blockNumber+1));
  assert.equal((await h.contract.skinOf(1))[1],false);assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(1));
  assert.equal(await h.contract.chainSecrets(),1n);
  // the used secret cannot seal it again, before or after the new seed block is mined
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(1),REVEAL_CHAIN.secret(2)]),/NOTHING_TO_SETTLE/);
  await mineBlocks(h,2);
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(1)]),/NOTHING_TO_SETTLE/);
  const s=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(2)],TX));const sealed=events(h,s,'EpochSealed')[0];
  const hash=(await h.provider.getBlock(rc.blockNumber+1)).hash;assert.equal(sealed.args.blockHash,hash);
  assert.equal(sealed.args.seed,seedOf(h,hash,REVEAL_CHAIN.secret(2),ep));
  assert.equal((await h.contract.skinOf(1))[1],true);
 }finally{await h.close();}
});
test('review 2026-10-27 (second opinion): an epoch re-armed for an expired seed block is re-armed only once; if the re-armed block expires too, the next secret alone seals it (the secret holder has a bounded number of options)',async()=>{
 const h=await harness();try{await open(h,1);await mintPaid(h,'twice',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const r1=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));assert.equal(events(h,r1,'EpochRearmed')[0].args.expired,true);
  await mineBlocks(h,300);   // the re-armed seed block expires as well
  const r2=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(2)],TX));
  assert.equal(events(h,r2,'EpochRearmed').length,0);const sealed=events(h,r2,'EpochSealed')[0];
  assert.equal(sealed.args.blockHash,ethers.ZeroHash);assert.equal(sealed.args.seedBlock,BigInt(r1.blockNumber+1));
  assert.equal(sealed.args.seed,seedOf(h,ethers.ZeroHash,REVEAL_CHAIN.secret(2),ep));assert.equal((await h.contract.skinOf(1))[1],true);
  assert.equal(await h.contract.revealedSecrets(),2n);
 }finally{await h.close();}
});
test('a mint that does not carry the secret of a ready epoch stops with REVEAL_PENDING; with it, the mint reveals first',async()=>{
 const h=await harness();try{await open(h,3);await mintPaid(h,'rp-1',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  const p=await h.approval(h.a,'rp-direct',undefined,{choice:0}),args=await h.paidArgs(p);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args,[]),/REVEAL_PENDING/);
  // a secret that does not open the commitment is skipped, so the epoch stays unsealed
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args,[REVEAL_CHAIN.secret(2)]),/REVEAL_PENDING/);
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(2)]),/NOTHING_TO_SETTLE/);
  // a stale secret ahead of the right one (a concurrent mint used it) and an extra one after it are both passed over
  const rc=await h.mine(h.contract.connect(h.alice).mintPaid(...args,[REVEAL_CHAIN.anchor,REVEAL_CHAIN.secret(1),REVEAL_CHAIN.secret(2)],TX));
  assert.equal(events(h,rc,'EpochSealed').length,1);assert.equal(await h.contract.revealedSecrets(),1n);assert.equal((await h.contract.skinOf(1))[1],true);
 }finally{await h.close();}
});
test('review 2026-10-27: a random mint goes ahead while an epoch waits for its reveal (it changes no skin count); a chosen mint waits, and the waiting epoch draws from the counts it had when its seed block was mined',async()=>{
 const h=await harness();try{await open(h,3);await mintPaid(h,'wait-1',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  const counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));
  // random, no secret: minted into a later epoch, the ready epoch stays unsealed
  const r=await h.approval(h.a,'wait-rnd',undefined,{choice:3});
  await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(r),[],TX));
  assert.equal(await h.contract.totalMinted(),2n);assert.equal(await h.contract.nextRevealIndex(),0n);assert.equal((await h.contract.skinOf(1))[1],false);
  assert.equal((await h.epochOf(2))>ep,true);
  assert.deepEqual(await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i))),counts);
  // chosen, no secret: still waits
  const c=await h.approval(h.a,'wait-chosen',undefined,{choice:0}),args=await h.paidArgs(c);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args,[]),/REVEAL_PENDING/);
  // with the secret: the epoch is revealed first, from the counts it had at its seed block
  const rc=await h.mine(h.contract.connect(h.alice).mintPaid(...args,[REVEAL_CHAIN.secret(1)],TX));
  const seed=events(h,rc,'EpochSealed')[0].args.seed;
  assert.equal((await h.contract.skinOf(1))[0],BigInt(draw(seed,1n,counts)));assert.equal((await h.contract.skinOf(2))[1],false);
 }finally{await h.close();}
});
test('reveal commitment: set only while paused, with the signer\'s acceptance, never zero or a value held before; replacing it re-arms a ready unsealed epoch to a future block',async()=>{
 const h=await harness();try{await open(h,2);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.keccak256('0x01'))),/PAUSE_REQUIRED/);
  await mintPaid(h,'rc-1',3);const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  await h.mine(h.contract.setMintPaused(true,TX));
  const fresh=ethers.keccak256('0x01');
  await assert.rejects(h.contract.connect(h.alice).setRevealCommit.staticCall(...await h.commitArgs(fresh)),/OwnableUnauthorizedAccount/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.ZeroHash)),/REVEAL_COMMIT_INVALID/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.anchor)),/REVEAL_COMMIT_INVALID/);   // held before
  // review 2026-10-27 (second opinion): keccak(anchor) has a public preimage (the anchor itself), so it is refused too
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.keccak256(REVEAL_CHAIN.anchor))),/REVEAL_COMMIT_INVALID/);
  // audit finding 1: the owner alone cannot set a chain: the acceptance must come from the approval signer, for this
  // commitment, this signer epoch, before its deadline
  const fake=testAuthority(3);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{authority:fake})),/REVEAL_ACCEPTANCE_INVALID/);
  const [,d,acc]=await h.commitArgs(ethers.keccak256('0x02'));
  await assert.rejects(h.contract.setRevealCommit.staticCall(fresh,d,acc),/REVEAL_ACCEPTANCE_INVALID/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{signerEpoch:2n})),/REVEAL_ACCEPTANCE_INVALID/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{deadline:(await h.time())-1})),/REVEAL_ACCEPTANCE_EXPIRED/);
  // a new chain (here: the same test chain one step on, as if x1 were the new anchor): the epoch is ready, so only
  // REARM_COOLDOWN blocks after its seed block (anyone holding a published secret could settle meanwhile)
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(1))),/EPOCH_REARM_COOLDOWN/);
  await mineBlocks(h,sb+7201-Number(await h.provider.getBlockNumber()));
  const rc=await h.commit(REVEAL_CHAIN.secret(1));
  const re=events(h,rc,'EpochRearmed')[0];assert.equal(re.args.epoch,BigInt(ep));assert.equal(re.args.newSeedBlock,BigInt(rc.blockNumber+1));assert.equal(re.args.expired,false);
  assert.equal(await h.contract.epochSeedBlock(ep),BigInt(rc.blockNumber+1));
  await mineBlocks(h,2);const s=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(2)],TX));
  const sealed=events(h,s,'EpochSealed')[0];assert.equal(sealed.args.blockHash,(await h.provider.getBlock(rc.blockNumber+1)).hash);
  // audit finding 6: an opened commitment (its preimage is public) can never be set again
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(1))),/REVEAL_COMMIT_INVALID/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(2))),/REVEAL_COMMIT_INVALID/);
  // ...also once that chain is replaced in turn: its opened values stay refused
  await h.commit(ethers.keccak256('0x03'));
  for(const old of [REVEAL_CHAIN.anchor,REVEAL_CHAIN.secret(1),REVEAL_CHAIN.secret(2),ethers.keccak256('0x03')])
   await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(old)),/REVEAL_COMMIT_INVALID/);
  await h.commit(REVEAL_CHAIN.secret(3));   // an unopened value is fine (here: the test chain one step further)
 }finally{await h.close();}
});
test('audit 2026-10-27 finding 1 (reproduction): a ready epoch is re-armed by a new commitment only REARM_COOLDOWN blocks after its seed block, and then not again until REARM_COOLDOWN blocks after the re-armed one',async()=>{
 const h=await harness();try{await open(h,2);await mintPaid(h,'reroll',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  await h.mine(h.contract.setMintPaused(true,TX));
  const A=ethers.keccak256(ethers.toUtf8Bytes('owner-secret-A')),B=ethers.keccak256(ethers.toUtf8Bytes('owner-secret-B'));
  // the outcome may already be public (the signer hands out the secret 2 blocks after the seed block): no veto now
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.keccak256(coder.encode(['bytes32'],[A])))),/EPOCH_REARM_COOLDOWN/);
  await mineBlocks(h,sb+7201-Number(await h.provider.getBlockNumber()));
  const rc=await h.commit(ethers.keccak256(coder.encode(['bytes32'],[A])));const rearm=rc.blockNumber+1;
  assert.equal(await h.contract.epochSeedBlock(ep),BigInt(rearm));
  await mineBlocks(h,2);   // the re-armed seed block is mined: whoever holds A could now compute the outcome
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.keccak256(coder.encode(['bytes32'],[B])))),/EPOCH_REARM_COOLDOWN/);
  assert.equal(await h.contract.epochSeedBlock(ep),BigInt(rearm),'the epoch keeps its single re-armed seed block');
  assert.equal(await h.contract.REARM_COOLDOWN(),7200n);
  // a genuinely lost chain can still be replaced, a day later (visible: minting is paused and chosen mints wait)
  await mineBlocks(h,rearm+7200-Number(await h.provider.getBlockNumber()));
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(ethers.keccak256(coder.encode(['bytes32'],[B])))),/EPOCH_REARM_COOLDOWN/);
  await mineBlocks(h,1);
  const r2=await h.commit(ethers.keccak256(coder.encode(['bytes32'],[B])));assert.equal(await h.contract.epochSeedBlock(ep),BigInt(r2.blockNumber+1));
 }finally{await h.close();}
});
test('audit 2026-10-27 finding 7: replacing the commitment re-arms any number of pending epochs at a fixed cost',async()=>{
 const gasFor=async n=>{const h=await harness();try{await open(h,n+1);
   const start=Number(await h.contract.startBlock());
   for(let i=0;i<n;i++){const target=start+(i+1)*25+1,now=Number(await h.provider.getBlockNumber());if(target>now+1)await mineBlocks(h,target-now-1);
    const p=await h.approval(h.a,'many-'+i,undefined,{choice:3});await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),[],TX));}
   assert.equal(await h.contract.randomEpochCount(),BigInt(n));
   const lastEpoch=await h.contract.randomEpochAt(n-1);await mineBlocks(h,Number(await h.contract.epochSeedBlock(lastEpoch))-Number(await h.provider.getBlockNumber())+1);
   const first=await h.contract.randomEpochAt(0);await mineBlocks(h,Number(await h.contract.epochSeedBlock(first))+7201-Number(await h.provider.getBlockNumber()));
   await h.mine(h.contract.setMintPaused(true,TX));const rc=await h.commit(ethers.keccak256(ethers.toUtf8Bytes('new chain '+n)));
   const last=await h.contract.randomEpochAt(n-1);assert.equal(await h.contract.epochSeedBlock(last),BigInt(rc.blockNumber+1));
   return rc.gasUsed;}finally{await h.close();}};
 const one=await gasFor(1),twelve=await gasFor(12);
 assert.ok(twelve<=one+2000n,`setRevealCommit gas grew with pending epochs: ${one} -> ${twelve}`);
});
test('audit 2026-10-27 findings 3 and 14 (reproduction): with nine ready epochs a chosen mint carrying every secret, in any order, settles them all and mints',async()=>{
 const h=await harness();try{await open(h,12);
  const start=Number(await h.contract.startBlock());
  for(let e=0;e<9;e++){const target=start+e*25+1,now=Number(await h.provider.getBlockNumber());if(target>now+1)await mineBlocks(h,target-now-1);
   const p=await h.approval(h.a,'nine-'+e,undefined,{choice:3});await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),[],TX));}
  assert.equal(await h.contract.randomEpochCount(),9n);
  const last=await h.contract.randomEpochAt(8);await mineBlocks(h,Number(await h.contract.epochSeedBlock(last))-Number(await h.provider.getBlockNumber())+1);
  const secrets=[];for(let i=1;i<=9;i++)secrets.push(REVEAL_CHAIN.secret(i));secrets.reverse();
  const c=await h.approval(h.a,'nine-chosen',undefined,{choice:0});
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(c),secrets.slice(0,8)),/REVEAL_PENDING/);   // one secret short
  const rc=await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(c),secrets,{gasLimit:12_000_000n}));
  assert.equal(events(h,rc,'EpochSealed').length,9);assert.equal(await h.contract.nextRevealIndex(),9n);
  assert.equal(await h.contract.pendingRandom(),0n);assert.equal(await h.contract.totalMinted(),10n);
 }finally{await h.close();}
});
test('audit 2026-10-27 finding 4: chosen-skin mints are frozen from the seed block itself (a transaction in that block cannot move the counts)',async()=>{
 const h=await harness();try{await open(h,3);await mintPaid(h,'freeze',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  const c=await h.approval(h.a,'freeze-chosen',undefined,{choice:0}),args=await h.paidArgs(c);
  await mineBlocks(h,sb-1-Number(await h.provider.getBlockNumber()));   // the next transaction is mined in block sb
  const tx=await h.contract.connect(h.alice).mintPaid(...args,[],TX);
  await assert.rejects(tx.wait());
  const r=await h.provider.getTransactionReceipt(tx.hash);assert.equal(r.blockNumber,sb);assert.equal(r.status,0);
  assert.equal(await h.contract.totalMinted(),1n);
  // one block later the chosen mint settles the epoch first, then mints
  await h.mine(h.contract.connect(h.alice).mintPaid(...args,TX));assert.equal((await h.contract.skinOf(1))[1],true);
 }finally{await h.close();}
});
test('audit 2026-10-27 finding 9: an Appearance approval names its route: a paid one cannot mint free, a free one cannot mint paid',async()=>{
 const h=await harness();try{const {tree}=await h.configure([h.a]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*2n,TX));
  const p=await h.approval(h.a,'route',undefined,{choice:0});
  const freeArgs=sig=>[p.key,p.choice,p.uri,p.deadline,sig,tree.proof(0),[]];
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(p.paidSignature)),/APPEARANCE_AUTHORITY/);
  const paid=await h.paidArgs(p);paid[4]=p.freeSignature;await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...paid),/APPEARANCE_AUTHORITY/);
  await h.mine(h.contract.connect(h.alice).mintFree(...freeArgs(p.freeSignature),TX));
  await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),TX));assert.equal(await h.contract.totalMinted(),2n);
 }finally{await h.close();}
});
test('R5 option A: after an epoch ends, the next mint seals and reveals it first, with the counts from before that mint',async()=>{
 const h=await harness();try{await open(h,6);await mintPaid(h,'a-r1',3);await mintPaid(h,'a-r2',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  const [,next,known]=await h.contract.nextRevealEpoch();assert.equal(Number(next),ep);assert.equal(known,true);
  const counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));
  const seed=seedOf(h,(await h.provider.getBlock(sb)).hash,REVEAL_CHAIN.secret(Number(await h.contract.revealedSecrets())+1),ep);
  const n=Number(await h.contract.epochRandomCount(ep)),expected=[];for(let i=0;i<n;i++){const id=await h.contract.epochRandomToken(ep,i),s=draw(seed,id,counts);counts[s]++;expected.push([id,s]);}
  // a direct mint by anyone: it must not change the draw, because the reveal runs before its own count change
  const p=await h.approval(h.a,'a-direct',undefined,{choice:0});const rc=await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),TX));
  assert.equal(events(h,rc,'EpochSealed').length,1);assert.equal(events(h,rc,'SkinRevealed').length,n);
  for(const [id,s] of expected){const [skin,revealed]=await h.contract.skinOf(id);assert.equal(revealed,true);assert.equal(skin,BigInt(s));}
 }finally{await h.close();}
});
test('R5 option A: at most 25 random mints per epoch; the 26th in the same epoch is refused, chosen skins are not',async()=>{
 const h=await harness();try{await open(h,40);
  const preps=[];for(let i=0;i<27;i++){const choice=i===26?0:3;const p=await h.approval(h.a,'cap-'+i,undefined,{choice});preps.push(await h.paidArgs(p));}
  await h.rpc.request({method:'evm_setAutomine',params:[false]});
  const sent=[];for(const args of preps)sent.push(await h.contract.connect(h.alice).mintPaid(...args,{gasLimit:900000n}));
  await h.rpc.request({method:'evm_mine',params:[]});await h.rpc.request({method:'evm_setAutomine',params:[true]});
  const status=[];for(const tx of sent){const r=await h.provider.getTransactionReceipt(tx.hash);status.push(r?.status??0);}
  assert.equal(status.slice(0,25).every(x=>x===1),true);assert.equal(status[25],0);assert.equal(status[26],1);
  const ep=(await h.epochOf(1));assert.equal(await h.contract.epochRandomCount(ep),25n);
  // 2026-10-27 gas: the 25 ids are packed 16 bits each (15 in the first word, 10 in the second); all of them reveal
  // exactly as the published draw says, in one call, with one BatchMetadataUpdate
  const ids=[];for(let i=0;i<25;i++)ids.push(await h.contract.epochRandomToken(ep,i));
  assert.deepEqual(ids.map(Number),[...Array(25).keys()].map(i=>i+1));
  await assert.rejects(h.contract.epochRandomToken(ep,25),/INDEX_OUT_OF_RANGE/);
  const counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));
  await mineBlocks(h,Number(await h.contract.epochSeedBlock(ep))-Number(await h.provider.getBlockNumber())+1);
  const rc=await h.mine(h.contract.settle(TX));const seed=events(h,rc,'EpochSealed')[0].args.seed;
  const batch=events(h,rc,'BatchMetadataUpdate');assert.equal(batch.length,1);assert.deepEqual([batch[0].args[0],batch[0].args[1]],[1n,25n]);
  assert.equal(events(h,rc,'SkinRevealed').length,25);
  for(const id of ids){const s=draw(seed,id,counts);counts[s]++;const [skin,revealed]=await h.contract.skinOf(id);assert.equal(revealed,true);assert.equal(skin,BigInt(s));}
  assert.deepEqual(await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i))),counts);assert.equal(await h.contract.pendingRandom(),0n);
  const [,choice26,skin26]=await h.contract.tokenLook(26);assert.deepEqual([choice26,skin26],[0n,1n]);   // the chosen token is untouched
 }finally{await h.close();}
});
test('settle(reveals): one call seals and reveals a ready epoch; nothing ready is refused; an expired seed is settled in one call too',async()=>{
 const h=await harness();try{await open(h,4);
  await assert.rejects(h.contract.settle.staticCall(),/NOTHING_TO_SETTLE/);
  await mintPaid(h,'st-1',3);await mintPaid(h,'st-2',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await assert.rejects(h.contract.settle.staticCall(),/NOTHING_TO_SETTLE/);
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+1);
  const rc=await h.mine(h.contract.settle(TX));assert.equal(events(h,rc,'EpochSealed').length,1);assert.equal(events(h,rc,'SkinRevealed').length,2);
  assert.equal((await h.contract.skinOf(1))[1],true);assert.equal((await h.contract.skinOf(2))[1],true);
  assert.equal((await h.contract.nextRevealEpoch())[0],false);
  await assert.rejects(h.contract.settle.staticCall(),/NOTHING_TO_SETTLE/);
  // expired (older than the block-hash window): settle uses up its secret and re-arms; two blocks later the next
  // secret seals it with a real block hash (audit finding 5). The signer hands out no secret after a nearly expired one.
  await mintPaid(h,'st-3',3);const ep2=(await h.epochOf(3)),sb2=Number(await h.contract.epochSeedBlock(ep2));
  await mineBlocks(h,sb2-Number(await h.provider.getBlockNumber())+300);
  await assert.rejects(h.contract.settle.staticCall([]),/NOTHING_TO_SETTLE/);   // without its secret nothing happens
  assert.equal((await h.reveals()).length,1);
  const r1=await h.mine(h.contract.settle(TX));assert.equal(events(h,r1,'EpochRearmed')[0].args.expired,true);
  assert.equal(events(h,r1,'EpochSealed').length,0);assert.equal((await h.contract.skinOf(3))[1],false);
  await mineBlocks(h,2);const r2=await h.mine(h.contract.settle(TX));
  assert.notEqual(events(h,r2,'EpochSealed')[0].args.blockHash,ethers.ZeroHash);assert.equal(events(h,r2,'SkinRevealed').length,1);
  assert.equal((await h.contract.skinOf(3))[1],true);
 }finally{await h.close();}
});
test('minting cannot open without the snapshot, locked reveal URIs and the reveal commitment; chosen-token URIs can be locked',async()=>{
 const h=await harness();try{
  // review 2026-10-27: an open sale with unlocked reveal URIs or no commitment would stall at its first random epoch
  await assert.rejects(h.contract.setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  const now=await h.time();await h.mine(h.contract.configureSnapshot(ethers.ZeroHash,0,now-1,now+5,TX));
  await assert.rejects(h.contract.setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  await h.mine(h.contract.setRevealURIs('ipfs://LOCAL_ONLY/p','ipfs://LOCAL_ONLY/r/',false,TX));
  await assert.rejects(h.contract.setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  await h.mine(h.contract.setRevealURIs('ipfs://LOCAL_ONLY/p','ipfs://LOCAL_ONLY/r/',true,TX));
  await assert.rejects(h.contract.setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  await h.commit(REVEAL_CHAIN.anchor);
  await h.mine(h.contract.setMintPaused(false,TX));await h.mine(h.contract.approvePaidPrice(TX));
  await h.rpc.request({method:'evm_increaseTime',params:[6]});await h.rpc.request({method:'evm_mine',params:[]});
  await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*3n,TX));
  await mintPaid(h,'f5-direct',0);await mintPaid(h,'f5-rnd',3);const ep=(await h.epochOf(2));await sealNow(h,ep);
  assert.equal((await h.contract.skinOf(2))[1],true);
  await h.mine(h.contract.setTokenURI(1,'ipfs://LOCAL_ONLY/changed',TX));await h.mine(h.contract.lockTokenURIs(TX));
  await assert.rejects(h.contract.setTokenURI.staticCall(1,'ipfs://LOCAL_ONLY/again'),/TOKEN_URIS_LOCKED/);
 }finally{await h.close();}
});
test('R5: end game: with only pink/gold left, randoms fill them exactly; caps and 1288 hold; then sold out',async()=>{
 const h=await harness('FixtureToken','SupplyBoundaryHarness');try{await open(h,4);
  for(const [s,c] of [[0,768n],[1,168n],[2,168n],[3,66n],[4,68n],[5,47n]])await h.mine(h.contract.seedSkinForTest(s,c,TX));
  assert.equal(await h.contract.totalMinted(),1285n);   // 768+168+168+66+68+47 seeded
  for(const choice of [0,1,2]){const p=await h.approval(h.a,'full-'+choice,undefined,{choice});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/SKIN_SOLD_OUT/);}
  for(let i=0;i<3;i++)await mintPaid(h,'end-'+i,3);
  assert.equal(await h.contract.totalMinted(),1288n);
  const p=await h.approval(h.a,'after',undefined,{choice:3});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)));
  for(;;){const [exists,ep]=await h.contract.nextRevealEpoch();if(!exists)break;await sealNow(h,Number(ep));}
  const counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));assert.deepEqual(counts,CAPS);assert.equal(await h.contract.pendingRandom(),0n);
 }finally{await h.close();}
});
test('R5: off-chain replica: 1288 mints in random order never exceed a cap and every random finds a skin',()=>{
 for(let trial=0;trial<5;trial++){const counts=[0n,0n,0n,0n,0n,0n];let pending=0;const seed=ethers.keccak256(ethers.toUtf8Bytes('trial'+trial));
  for(let id=1;id<=1288;id++){const pick=Number(BigInt(ethers.keccak256(coder.encode(['bytes32','uint256'],[seed,id+100000])))%10n);
   const direct=pick<3?pick:-1;if(direct>=0&&counts[direct]<CAPS[direct])counts[direct]++;else pending++;
   if(id%25===0||id===1288){while(pending){const s=draw(seed,BigInt(id*7+pending),counts);assert.ok(counts[s]<CAPS[s]);counts[s]++;pending--;}}}
  assert.deepEqual(counts,CAPS);}
});
test('R5: paid EMBEO goes to the fixed burn address; no recipient setter; R4 v4 approvals are rejected',async()=>{
 const h=await harness();try{await open(h,2);
  assert.equal(await h.contract.BURN_ADDRESS(),BURN);assert.equal(h.contract.interface.getFunction('setPaymentRecipient'),null);
  const before=await h.token.balanceOf(BURN);await mintPaid(h,'burn',0);assert.equal(await h.token.balanceOf(BURN),before+COST);
  const p=await h.approval(h.a,'v4',undefined,{choice:0});
  const v4=await h.approvalSigner.signTypedData({name:'EmberEvoGenesisCandidate',version:'4',chainId:31337,verifyingContract:h.contract.target},{Appearance:[{name:'wallet',type:'address'},{name:'key',type:'bytes32'},{name:'uriHash',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]},{wallet:h.a,key:p.key,uriHash:ethers.keccak256(ethers.toUtf8Bytes(p.uri)),deadline:p.deadline,signerEpoch:1});
  const args=await h.paidArgs(p);args[4]=v4;await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args),/APPEARANCE_AUTHORITY/);
  const wrongRecipient=await h.paidArgs(p,h.a,h.b);await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...wrongRecipient),/PAYMENT_CONTEXT_CHANGED/);
 }finally{await h.close();}
});
test('2026-10-27: a chosen mint stores no URI: it is derived like a revealed random URI; an owner override wins until locked',async()=>{
 const h=await harness();try{await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*2n,TX));
  const p=await h.approval(h.a,'derived',undefined,{choice:1});await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),TX));
  // the reveal URIs are locked before minting opens (h.configure): the chosen token's URI follows the reveal base
  assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/revealed/'+p.key+'/1');
  // the URI sent at mint is still part of the signed approval: a chosen pick without one is refused
  const empty=await h.approval(h.a,'derived-empty','',{choice:0});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(empty)),/METADATA_REQUIRED/);
  await h.mine(h.contract.setTokenURI(1,'ipfs://LOCAL_ONLY/override',TX));assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/override');
  await h.mine(h.contract.lockTokenURIs(TX));await assert.rejects(h.contract.setTokenURI.staticCall(1,'ipfs://LOCAL_ONLY/again'),/TOKEN_URIS_LOCKED/);
 }finally{await h.close();}
});
test('R5: random tokens show the pending URI, then the derived revealed URI; reveal URIs can be locked',async()=>{
 const h=await harness();try{await open(h,1);await mintPaid(h,'uri',3);
  assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/pending');
  await assert.rejects(h.contract.setRevealURIs.staticCall('a','b',false),/REVEAL_URIS_LOCKED/);
  await assert.rejects(h.contract.setTokenURI.staticCall(1,'x'),/RANDOM_URI_IS_DERIVED/);
  const ep=(await h.epochOf(1));await sealNow(h,ep);
  const [skin]=await h.contract.skinOf(1),key=(await h.contract.tokenLook(1)).lookKey;
  assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/revealed/'+key+'/'+skin.toString());
 }finally{await h.close();}
});
