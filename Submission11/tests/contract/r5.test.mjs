import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,COST,TX,REVEAL_CHAIN,artifacts} from './hardening-harness.mjs';
import {ethers,testAuthority} from '../tools/runtime.mjs';
import {GOLD_TYPES} from '../../service/gold-ledger.mjs';
import {readyReveals} from '../../signer/reveal-chain.mjs';
import config from '../config/genesis.json' with {type:'json'};

const RECIPIENT=ethers.getAddress(config.receivingAddress);   // the treasury Safe (owner 2026-10-28; was the burn address)
const CAPS=[1068n,218n,218n,68n,68n,48n];   // R6 deployment caps (owner 2026-10-28), sum 1,688
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
  await h.mine(h.contract.seedForTest(1,217n,TX));
  await mintPaid(h,'last-ice',1);assert.equal(await h.contract.skinCount(1),218n);
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
  assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(1));assert.equal(await h.contract.chainSecrets(),1n);
  const expected=[];for(let i=0;i<n;i++){const id=await h.contract.epochRandomToken(ep,i),s=draw(sealed.args.seed,id,counts);counts[s]++;expected.push([id,s]);}
  assert.equal(events(h,rc,'SkinRevealed').length,n);
  for(const [id,s] of expected){const [skin,revealed]=await h.contract.skinOf(id);assert.equal(revealed,true);assert.equal(skin,BigInt(s));}
  assert.equal(await h.contract.pendingRandom(),BigInt(4-n));
  await assert.rejects(h.contract.settle.staticCall([REVEAL_CHAIN.secret(1)]),/NOTHING_TO_SETTLE/);   // used up
 }finally{await h.close();}
});
test('audit 388b71cb findings 1 and 2: an expired seed block keeps the secret supplied for it (now public) and re-arms to the next block, whose hash seals the epoch with no secret supplied; it never seals with a secret alone (Cancun: no EIP-2935 history, window 256)',async()=>{
 const h=await harness();try{await open(h,2);await mintPaid(h,'late',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const rc=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));
  assert.equal(events(h,rc,'EpochSealed').length,0);const re=events(h,rc,'EpochRearmed')[0];
  assert.equal(re.args.epoch,BigInt(ep));assert.equal(re.args.expired,true);assert.equal(re.args.newSeedBlock,BigInt(rc.blockNumber+1));
  assert.equal((await h.contract.skinOf(1))[1],false);assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(1));
  assert.equal(await h.contract.chainSecrets(),1n);assert.equal(await h.contract.epochSecretOpened(ep),true);
  await mineBlocks(h,2);
  // the signer hands out nothing for it, and anyone settles it with no secret at all
  assert.deepEqual(await h.reveals(),[]);
  const s=await h.mine(h.contract.settle([],TX));const sealed=events(h,s,'EpochSealed')[0];
  const hash=(await h.provider.getBlock(rc.blockNumber+1)).hash;assert.equal(sealed.args.blockHash,hash);
  assert.equal(sealed.args.secret,REVEAL_CHAIN.secret(1));assert.equal(sealed.args.seed,seedOf(h,hash,REVEAL_CHAIN.secret(1),ep));
  assert.equal((await h.contract.skinOf(1))[1],true);assert.equal(await h.contract.chainSecrets(),1n);
  // the next epoch still uses the next secret of the chain (nothing shifted)
  await mintPaid(h,'after',3);const ep2=(await h.epochOf(2));await sealNow(h,ep2);
  assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(2));assert.equal((await h.contract.skinOf(2))[1],true);
 }finally{await h.close();}
});
test('audit 388b71cb finding 1 (reproduction): if the re-armed block expires too, the epoch is re-armed again with the same public secret, never sealed by the secret alone (no outcome is fixed when the chain is made)',async()=>{
 const h=await harness();try{await open(h,1);await mintPaid(h,'twice',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const r1=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));assert.equal(events(h,r1,'EpochRearmed')[0].args.expired,true);
  await mineBlocks(h,300);   // the re-armed seed block expires as well; withholding the next secret changes nothing
  const r2=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(2)],TX));
  assert.equal(events(h,r2,'EpochSealed').length,0);const re=events(h,r2,'EpochRearmed')[0];
  assert.equal(re.args.expired,true);assert.equal(re.args.newSeedBlock,BigInt(r2.blockNumber+1));
  assert.equal(await h.contract.revealCommit(),REVEAL_CHAIN.secret(1));assert.equal(await h.contract.chainSecrets(),1n);   // x2 not used
  await mineBlocks(h,1);const r3=await h.mine(h.contract.settle([],TX));const sealed=events(h,r3,'EpochSealed')[0];
  const hash=(await h.provider.getBlock(r2.blockNumber+1)).hash;
  assert.notEqual(sealed.args.blockHash,ethers.ZeroHash);assert.equal(sealed.args.blockHash,hash);
  assert.equal(sealed.args.seed,seedOf(h,hash,REVEAL_CHAIN.secret(1),ep));assert.equal((await h.contract.skinOf(1))[1],true);
 }finally{await h.close();}
});
test('audit 388b71cb finding 2 (reproduction): in the block of an expiry re-arm, a new commitment is refused (the cooldown counts from the pending re-armed block)',async()=>{
 const h=await harness();try{await open(h,1);await mintPaid(h,'inside',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  await h.mine(h.contract.setMintPaused(true,TX));   // settle works while paused
  await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const B=ethers.keccak256(ethers.toUtf8Bytes('chain B made after the epoch closed'));const args=await h.commitArgs(B);
  await h.rpc.request({method:'evm_setAutomine',params:[false]});
  let settleTx,commitTx;
  try{settleTx=await h.contract.settle([REVEAL_CHAIN.secret(1)],TX);commitTx=await h.contract.setRevealCommit(...args,TX);await h.rpc.request({method:'evm_mine',params:[]});}
  finally{await h.rpc.request({method:'evm_setAutomine',params:[true]});}
  const s=await h.provider.getTransactionReceipt(settleTx.hash),c=await h.provider.getTransactionReceipt(commitTx.hash);
  assert.equal(s.blockNumber,c.blockNumber);assert.equal(s.status,1);assert.equal(c.status,0,'replacement inside the re-arm block must revert');
  assert.equal(events(h,s,'EpochRearmed')[0].args.expired,true);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(B)),/EPOCH_REARM_COOLDOWN/);
  // anyone settles the re-armed epoch first; a day after the re-armed block a lost chain could still be replaced
  await mineBlocks(h,1);await h.mine(h.contract.settle([],TX));assert.equal((await h.contract.skinOf(1))[1],true);
 }finally{await h.close();}
});
test('audit 388b71cb finding 3 (reproduction): an expiry re-arm does not lift the chosen-skin freeze, even for the chosen mint that triggers it',async()=>{
 const h=await harness();try{await open(h,3);await mintPaid(h,'shape',3);
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));await mineBlocks(h,sb-Number(await h.provider.getBlockNumber())+300);
  const c=await h.approval(h.a,'shape-chosen',undefined,{choice:0}),args=await h.paidArgs(c);
  // the mint's own secret re-arms the epoch (block + 1): the old rule then let the chosen mint through in this block
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args,[REVEAL_CHAIN.secret(1)]),/REVEAL_PENDING/);
  await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args,[]),/REVEAL_PENDING/);
  assert.equal(await h.contract.skinCount(0),0n);
  // once the re-armed block is mined, the chosen mint settles the epoch first (no secret needed), then mints
  await mineBlocks(h,1);await h.mine(h.contract.connect(h.alice).mintPaid(...args,[],TX));
  assert.equal((await h.contract.skinOf(1))[1],true);assert.equal(await h.contract.totalMinted(),2n);
 }finally{await h.close();}
});
test('audit 388b71cb finding 4 (reproduction): new commitments re-arm the same epoch at most MAX_COMMIT_REARMS (2) times, and an expiry re-arm in between neither resets that count nor makes the epoch sealable by a secret alone',async()=>{
 const h=await harness();try{await open(h,2);await mintPaid(h,'limit',3);
  assert.equal(await h.contract.MAX_COMMIT_REARMS(),2n);
  const ep=(await h.epochOf(1));await h.mine(h.contract.setMintPaused(true,TX));
  const wait=async()=>mineBlocks(h,Number(await h.contract.epochSeedBlock(ep))+7201-Number(await h.provider.getBlockNumber()));
  await wait();const r1=await h.commit(REVEAL_CHAIN.secret(5));assert.equal(events(h,r1,'EpochRearmed')[0].args.expired,false);
  // the new chain's first secret is withheld until its re-armed block expires: re-armed again, count kept
  await mineBlocks(h,300);const e1=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(6)],TX));assert.equal(events(h,e1,'EpochRearmed')[0].args.expired,true);
  await wait();await h.commit(REVEAL_CHAIN.secret(10));
  await wait();await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(15))),/EPOCH_REARM_LIMIT/);
  // the epoch is still settled with the chain it has
  const s=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(11)],TX));
  assert.equal(events(h,s,'EpochRearmed')[0].args.expired,true);   // that re-armed block is long gone: one more re-arm
  await mineBlocks(h,1);const s2=await h.mine(h.contract.settle([],TX));
  assert.notEqual(events(h,s2,'EpochSealed')[0].args.blockHash,ethers.ZeroHash);assert.equal((await h.contract.skinOf(1))[1],true);
  // the next epoch starts with a fresh count
  await h.mine(h.contract.setMintPaused(false,TX));await mintPaid(h,'limit-2',3);const ep2=(await h.epochOf(2));
  await h.mine(h.contract.setMintPaused(true,TX));
  await mineBlocks(h,Number(await h.contract.epochSeedBlock(ep2))+7201-Number(await h.provider.getBlockNumber()));
  await h.commit(REVEAL_CHAIN.secret(20));
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
  assert.equal(events(h,rc,'EpochSealed').length,1);assert.equal(await h.contract.chainSecrets(),1n);assert.equal((await h.contract.skinOf(1))[1],true);
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
  // review 2026-10-27 (second opinion): keccak(anchor) has a public preimage (the anchor itself), so it is refused too;
  // audit 388b71cb finding 5: so do keccak^2(anchor) and every hash up to 32 above it
  const above=[REVEAL_CHAIN.anchor];for(let i=1;i<=33;i++)above.push(ethers.keccak256(above[i-1]));
  for(const m of [1,2,3,32])await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(above[m])),/REVEAL_COMMIT_INVALID/,`keccak^${m}(anchor)`);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(above[33])),/EPOCH_REARM_COOLDOWN/);   // past the margin: only the cooldown stops it here
  // audit finding 1: the owner alone cannot set a chain: the acceptance must come from the approval signer, for this
  // commitment, this signer epoch, before its deadline
  const fake=testAuthority(3);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{authority:fake})),/REVEAL_ACCEPTANCE_INVALID/);
  const [,d,acc]=await h.commitArgs(ethers.keccak256('0x02'));
  await assert.rejects(h.contract.setRevealCommit.staticCall(fresh,d,acc),/REVEAL_ACCEPTANCE_INVALID/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{signerEpoch:2n})),/REVEAL_ACCEPTANCE_INVALID/);
  // audit b0b1d96a finding 1 (d726b1cd finding 4): an acceptance signs a recent block's number and hash. A future block
  // has no hash yet, so it cannot be signed in advance; a wrong hash fails the signature; one signed 257 blocks ago (a
  // spare kept for later) is refused, whatever deadline a signer would have chosen.
  const head=await h.provider.getBlockNumber(),signedAt=await h.provider.getBlock(head-2);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{block:{number:head+5,hash:ethers.keccak256('0x06')}})),/REVEAL_ACCEPTANCE_EXPIRED/);
  await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(fresh,{block:{number:signedAt.number,hash:ethers.keccak256('0x07')}})),/REVEAL_ACCEPTANCE_INVALID/);
  const spare=await h.commitArgs(fresh,{block:signedAt});
  await mineBlocks(h,254-(Number(await h.provider.getBlockNumber())-signedAt.number));   // head signedAt + 254: still known
  await assert.rejects(h.contract.setRevealCommit.staticCall(...spare),/EPOCH_REARM_COOLDOWN/);   // the acceptance passed
  await mineBlocks(h,3);   // head signedAt + 257: blockhash() has forgotten it
  await assert.rejects(h.contract.setRevealCommit.staticCall(...spare),/REVEAL_ACCEPTANCE_EXPIRED/);
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
  // pre-deployment review 2026-10-27 (L-2): an acceptance names the commitment it replaces, so a spare one signed
  // earlier cannot be used later by the owner alone
  const spareA=await h.commitArgs(ethers.keccak256('0x04')),spareB=await h.commitArgs(ethers.keccak256('0x05'));
  await h.mine(h.contract.setRevealCommit(...spareB,TX));
  await assert.rejects(h.contract.setRevealCommit.staticCall(...spareA),/REVEAL_ACCEPTANCE_INVALID/);
  await h.commit(ethers.keccak256('0x04'));   // signed again against the current commitment, it is fine
 }finally{await h.close();}
});
test('pre-deployment review 2026-10-27 (L-1): an epoch waiting behind a re-armed one shares its re-arm count, so it cannot be re-rolled MAX_COMMIT_REARMS more times once that one is revealed',async()=>{
 const h=await harness();try{await open(h,3);
  const start=Number(await h.contract.startBlock());
  for(let e=0;e<2;e++){const target=start+e*25+1,now=Number(await h.provider.getBlockNumber());if(target>now+1)await mineBlocks(h,target-now-1);
   const p=await h.approval(h.a,'backlog-'+e,undefined,{choice:3});await h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),[],TX));}
  const [e1,e2]=[await h.contract.randomEpochAt(0),await h.contract.randomEpochAt(1)];
  await mineBlocks(h,Number(await h.contract.epochSeedBlock(e2))-Number(await h.provider.getBlockNumber())+1);   // both closed
  await h.mine(h.contract.setMintPaused(true,TX));
  const wait=async e=>mineBlocks(h,Number(await h.contract.epochSeedBlock(e))+7201-Number(await h.provider.getBlockNumber()));
  await wait(e1);await h.commit(REVEAL_CHAIN.secret(5));await wait(e1);const r2=await h.commit(REVEAL_CHAIN.secret(10));
  assert.equal(await h.contract.epochSeedBlock(e2),BigInt(r2.blockNumber+1));   // each re-arm drew the waiting epoch again
  await mineBlocks(h,2);const s=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(11)],TX));   // only e1's secret
  assert.equal(events(h,s,'EpochSealed').length,1);assert.equal(await h.contract.nextRevealIndex(),1n);
  await wait(e2);await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(15))),/EPOCH_REARM_LIMIT/);
  const s2=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(12)],TX));   // settled with the chain it has (expired: re-armed)
  assert.equal(events(h,s2,'EpochRearmed')[0].args.expired,true);
  await wait(e2);await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(15))),/EPOCH_REARM_LIMIT/);   // the expiry re-arm keeps it
  const s3=await h.mine(h.contract.settle([],TX));assert.equal(events(h,s3,'EpochRearmed')[0].args.expired,true);   // waited past the window again
  await mineBlocks(h,1);const s4=await h.mine(h.contract.settle([],TX));assert.equal(events(h,s4,'EpochSealed').length,1);
 }finally{await h.close();}
});
/** A random mint that carries no secrets (so it settles nothing), for building backlogs. */
async function mintRandomBare(h,tag){const p=await h.approval(h.a,tag,undefined,{choice:3});return h.mine(h.contract.connect(h.alice).mintPaid(...await h.paidArgs(p),[],TX));}
/** Random mints in consecutive epochs (one each), from the epoch after the current one. */
async function backlog(h,n,tag){const start=Number(await h.contract.startBlock()),first=Number(await h.contract.currentEpoch())+1;
 for(let e=0;e<n;e++){const target=start+(first+e)*25+1,now=Number(await h.provider.getBlockNumber());if(target>now+1)await mineBlocks(h,target-now-1);await mintRandomBare(h,tag+'-'+e);}
 return Promise.all([...Array(n).keys()].map(async i=>Number(await h.contract.randomEpochAt(Number(await h.contract.randomEpochCount())-n+i))));}
const naturalOf=async(h,e)=>Number(await h.contract.startBlock())+(e+1)*25;
const rearmWait=h=>async e=>mineBlocks(h,Number(await h.contract.epochSeedBlock(e))+7201-Number(await h.provider.getBlockNumber()));
test('audit d726b1cd finding 1 (reproduction, instance a): an epoch that closed after two commitment re-arms of the one before it, and was then passed by that one\'s expiry re-arm, starts with no commitment re-arms',async()=>{
 const h=await harness();try{await open(h,3);const wait=rearmWait(h);
  const [eA]=await backlog(h,1,'f1a');await mineBlocks(h,await naturalOf(h,eA)-Number(await h.provider.getBlockNumber())+1);
  await h.mine(h.contract.setMintPaused(true,TX));
  await wait(eA);await h.commit(REVEAL_CHAIN.secret(5));await wait(eA);const r2=await h.commit(REVEAL_CHAIN.secret(10));   // eA: 2 commitment re-arms
  await h.mine(h.contract.setMintPaused(false,TX));await mintRandomBare(h,'f1a-late');const eB=Number(await h.contract.randomEpochAt(1));
  assert.ok(await naturalOf(h,eB)>r2.blockNumber+1,'eB closes after both re-arms');
  // eA's re-armed block expires; its secret is supplied and kept: eA alone moves (finding 2), eB keeps its own block
  await mineBlocks(h,r2.blockNumber+1+257-Number(await h.provider.getBlockNumber()));
  const x=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(11)],TX));const re=events(h,x,'EpochRearmed')[0];
  assert.equal(re.args.expired,true);assert.equal(re.args.epoch,BigInt(eA));
  assert.equal(await h.contract.epochSeedBlock(eB),BigInt(await naturalOf(h,eB)));assert.equal(await h.contract.epochSecretOpened(eB),false);
  await mineBlocks(h,1);await h.mine(h.contract.settle([],TX));assert.equal(await h.contract.nextRevealIndex(),1n);
  // a lost chain for eB: the replacements README 5 / 8.2 promise are both there
  await h.mine(h.contract.setMintPaused(true,TX));
  await wait(eB);const c1=await h.commit(REVEAL_CHAIN.secret(15));const e1=events(h,c1,'EpochRearmed')[0];
  assert.equal(e1.args.epoch,BigInt(eB));assert.equal(e1.args.expired,false);
  await wait(eB);await h.commit(REVEAL_CHAIN.secret(20));
  await wait(eB);await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(25))),/EPOCH_REARM_LIMIT/);   // and no more
 }finally{await h.close();}
});
test('audit d726b1cd finding 1 (reproduction, instance b): a commitment re-arm of an earlier epoch that came before this one closed is not counted against it',async()=>{
 const h=await harness();try{await open(h,4);const wait=rearmWait(h);
  const [e0,e1]=await backlog(h,2,'f1b');await mineBlocks(h,await naturalOf(h,e1)-Number(await h.provider.getBlockNumber())+1);
  await h.mine(h.contract.setMintPaused(true,TX));
  await wait(e0);const R1=(await h.commit(REVEAL_CHAIN.secret(5))).blockNumber+1;   // moves e0 and e1
  assert.equal(await h.contract.epochSeedBlock(e1),BigInt(R1));
  await mineBlocks(h,2);const s=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(6)],TX));assert.equal(events(h,s,'EpochSealed').length,1);   // e0 only
  await h.mine(h.contract.setMintPaused(false,TX));await mintRandomBare(h,'f1b-late');const e2=Number(await h.contract.randomEpochAt(2));
  assert.ok(await naturalOf(h,e2)>R1,'e2 closes after the first re-arm');
  await h.mine(h.contract.setMintPaused(true,TX));
  await wait(e1);const R2=(await h.commit(REVEAL_CHAIN.secret(10))).blockNumber+1;   // e1's second (shared with e0), e2's first
  assert.equal(await h.contract.epochSeedBlock(e1),BigInt(R2));assert.equal(await h.contract.epochSeedBlock(e2),BigInt(R2));
  await mineBlocks(h,2);await h.mine(h.contract.settle([REVEAL_CHAIN.secret(11)],TX));assert.equal(await h.contract.nextRevealIndex(),2n);
  await wait(e2);const c=await h.commit(REVEAL_CHAIN.secret(15));assert.equal(events(h,c,'EpochRearmed')[0].args.epoch,BigInt(e2));
  await wait(e2);await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(20))),/EPOCH_REARM_LIMIT/);   // its second was its last
 }finally{await h.close();}
});
test('audit d726b1cd finding 2 (reproduction): an expiry re-arm moves only its own epoch; a later closed epoch keeps its own seed block and, if that expired too, goes through its own expiry (one fresh draw per withheld secret)',async()=>{
 const h=await harness();try{await open(h,3);
  const [e0,e1]=await backlog(h,2,'f2');const n1=await naturalOf(h,e1);
  await mineBlocks(h,await naturalOf(h,e0)+300-Number(await h.provider.getBlockNumber()));
  const x=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(1)],TX));
  assert.equal(events(h,x,'EpochRearmed')[0].args.epoch,BigInt(e0));
  assert.equal(await h.contract.epochSeedBlock(e0),BigInt(x.blockNumber+1));
  assert.equal(await h.contract.epochSeedBlock(e1),BigInt(n1),'e1 is not moved by e0\'s expiry');
  assert.equal(await h.contract.epochSecretOpened(e0),true);assert.equal(await h.contract.epochSecretOpened(e1),false);
  await mineBlocks(h,1);const s=await h.mine(h.contract.settle([],TX));assert.equal(events(h,s,'EpochSealed').length,1);   // e0; e1 needs its secret
  // e1's own block is out of reach by now: its secret re-arms e1 alone, and from then on anyone seals it
  const y=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(2)],TX));const ry=events(h,y,'EpochRearmed')[0];
  assert.equal(ry.args.epoch,BigInt(e1));assert.equal(ry.args.expired,true);assert.equal(await h.contract.epochSecretOpened(e1),true);
  await mineBlocks(h,1);const s2=await h.mine(h.contract.settle([],TX));const sealed=events(h,s2,'EpochSealed')[0];
  assert.equal(sealed.args.seedBlock,BigInt(y.blockNumber+1));assert.equal(sealed.args.secret,REVEAL_CHAIN.secret(2));
 }finally{await h.close();}
});
test('audit d726b1cd finding 2 (no regression): after a commitment re-arm moved a later epoch, an expiry of the earlier one leaves the later one on the commitment block, never back on its own (public before the new chain was set)',async()=>{
 const h=await harness();try{await open(h,3);const wait=rearmWait(h);
  const [e0,e1]=await backlog(h,2,'f2r');await mineBlocks(h,await naturalOf(h,e1)-Number(await h.provider.getBlockNumber())+1);
  await h.mine(h.contract.setMintPaused(true,TX));
  await wait(e0);const R=(await h.commit(REVEAL_CHAIN.secret(5))).blockNumber+1;assert.equal(await h.contract.epochSeedBlock(e1),BigInt(R));
  await mineBlocks(h,300);const x=await h.mine(h.contract.settle([REVEAL_CHAIN.secret(6)],TX));
  assert.equal(events(h,x,'EpochRearmed')[0].args.epoch,BigInt(e0));
  assert.equal(await h.contract.epochSeedBlock(e1),BigInt(R),'e1 stays on the commitment re-arm block');
  // a new commitment then clears the expiry record: e0's chain is replaced, so its secret is no longer the opened one
  await wait(e0);const c=await h.commit(REVEAL_CHAIN.secret(10));
  assert.equal(await h.contract.epochSecretOpened(e0),false);assert.equal(await h.contract.epochSeedBlock(e0),BigInt(c.blockNumber+1));
  assert.equal(await h.contract.epochSeedBlock(e1),BigInt(c.blockNumber+1));
  await wait(e0);await assert.rejects(h.contract.setRevealCommit.staticCall(...await h.commitArgs(REVEAL_CHAIN.secret(15))),/EPOCH_REARM_LIMIT/);   // the expiry did not count, the two commitments do
  const s=await h.mine(h.contract.settle(TX));assert.equal(events(h,s,'EpochRearmed')[0].args.expired,true);   // secret 11 (handed out), its block long gone
 }finally{await h.close();}
});
test('audit d726b1cd finding 5: readyReveals pins every contract read to the block it reports',async()=>{
 const h=await harness();try{await open(h,2);await mintPaid(h,'pin',3);
  const ep=(await h.epochOf(1));await mineBlocks(h,Number(await h.contract.epochSeedBlock(ep))-Number(await h.provider.getBlockNumber())+3);
  const calls=[];const p=new ethers.BrowserProvider({request:async a=>{calls.push(a);return h.rpc.request(a);}},undefined,{cacheTimeout:-1});
  const r=await readyReveals({provider:p,contractAddress:h.contract.target,chain:REVEAL_CHAIN,hashWindow:256});
  assert.deepEqual(r.reveals,[REVEAL_CHAIN.secret(1)]);
  const ethCalls=calls.filter(c=>c.method==='eth_call');assert.ok(ethCalls.length>=5);
  for(const c of ethCalls)assert.equal(c.params[1],ethers.toQuantity(r.block),'eth_call at '+c.params[1]);
  // a node one block behind ("header not found") once: retried from a fresh block number, same answer
  let failed=0;const flaky=new ethers.BrowserProvider({request:async a=>{if(a.method==='eth_call'&&failed===0){failed++;throw Object.assign(new Error('header not found'),{code:-32000});}return h.rpc.request(a);}},undefined,{cacheTimeout:-1});
  const r2=await readyReveals({provider:flaky,contractAddress:h.contract.target,chain:REVEAL_CHAIN,hashWindow:256});
  assert.equal(failed,1);assert.deepEqual(r2.reveals,[REVEAL_CHAIN.secret(1)]);
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
  // gas review 2026-10-27: the list packs 8 epochs per word; the ninth is the first entry of the second word
  for(let i=0;i<9;i++)assert.equal(await h.contract.randomEpochAt(i),BigInt(i));
  await assert.rejects(h.contract.randomEpochAt(9),/INDEX_OUT_OF_RANGE/);
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
test('audit 2026-10-27 finding 9: an approval names its route: a paid one cannot mint free, a free one cannot mint paid (since 2026-10-28 the paid route takes only a PaidAuthorization)',async()=>{
 const h=await harness();try{const {tree}=await h.configure([h.a]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*2n,TX));
  const p=await h.approval(h.a,'route',undefined,{choice:0});
  const freeArgs=sig=>[p.key,p.choice,p.uri,p.deadline,sig,0,tree.proof(0),[]];
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(p.paidSignature)),/APPEARANCE_AUTHORITY/);
  const paid=await h.paidArgs(p);
  for(const sig of [p.freeSignature,p.paidSignature]){paid[5]=sig;await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...paid),/GOLD_RESERVATION_AUTHORITY/);}
  // and a PaidAuthorization cannot mint free
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs((await h.paidArgs(p))[5])),/APPEARANCE_AUTHORITY/);
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
  const seed=seedOf(h,(await h.provider.getBlock(sb)).hash,REVEAL_CHAIN.secret(Number(await h.contract.chainSecrets())+1),ep);
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
  // expired (older than the block-hash window): settle opens its secret and re-arms; two blocks later anyone seals it
  // with a real block hash and that same secret, no secret needed (audit 388b71cb). The signer hands out no secret after
  // a nearly expired one.
  await mintPaid(h,'st-3',3);const ep2=(await h.epochOf(3)),sb2=Number(await h.contract.epochSeedBlock(ep2));
  await mineBlocks(h,sb2-Number(await h.provider.getBlockNumber())+300);
  await assert.rejects(h.contract.settle.staticCall([]),/NOTHING_TO_SETTLE/);   // without its secret nothing happens
  assert.equal((await h.reveals()).length,1);
  const r1=await h.mine(h.contract.settle(TX));assert.equal(events(h,r1,'EpochRearmed')[0].args.expired,true);
  assert.equal(events(h,r1,'EpochSealed').length,0);assert.equal((await h.contract.skinOf(3))[1],false);
  await mineBlocks(h,2);assert.deepEqual(await h.reveals(),[]);const r2=await h.mine(h.contract.settle(TX));
  assert.notEqual(events(h,r2,'EpochSealed')[0].args.blockHash,ethers.ZeroHash);assert.equal(events(h,r2,'SkinRevealed').length,1);
  assert.equal((await h.contract.skinOf(3))[1],true);
 }finally{await h.close();}
});
test('minting cannot open without the snapshot, locked reveal URIs and the reveal commitment; chosen-token URIs can be locked',async()=>{
 const h=await harness();try{
  // review 2026-10-27: an open sale with unlocked reveal URIs or no commitment would stall at its first random epoch
  await assert.rejects(h.contract.setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  const now=await h.time();
  // gas review 2026-10-27: freeStartAt is stored in 40 bits next to the signer; a larger start is refused, not cut
  await assert.rejects(h.contract.configureSnapshot.staticCall(ethers.ZeroHash,0,now-1,2n**40n),/SNAPSHOT_TIME/);
  await h.mine(h.contract.configureSnapshot(ethers.ZeroHash,0,now-1,now+5,TX));
  assert.equal(await h.contract.signerEpoch(),1n);assert.equal(await h.contract.mintPaused(),true);   // packed slot defaults
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
test('R5: end game: with only pink/gold left, randoms fill them exactly; caps and 1688 hold; then sold out',async()=>{
 const h=await harness('FixtureToken','SupplyBoundaryHarness');try{await open(h,4);
  for(const [s,c] of [[0,1068n],[1,218n],[2,218n],[3,66n],[4,68n],[5,47n]])await h.mine(h.contract.seedForTest(s,c,TX));
  assert.equal(await h.contract.totalMinted(),1685n);   // 1068+218+218+66+68+47 seeded
  for(const choice of [0,1,2]){const p=await h.approval(h.a,'full-'+choice,undefined,{choice});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)),/SKIN_SOLD_OUT/);}
  for(let i=0;i<3;i++)await mintPaid(h,'end-'+i,3);
  assert.equal(await h.contract.totalMinted(),1688n);
  const p=await h.approval(h.a,'after',undefined,{choice:3});await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...await h.paidArgs(p)));
  for(;;){const [exists,ep]=await h.contract.nextRevealEpoch();if(!exists)break;await sealNow(h,Number(ep));}
  const counts=await Promise.all([0,1,2,3,4,5].map(i=>h.contract.skinCount(i)));assert.deepEqual(counts,CAPS);assert.equal(await h.contract.pendingRandom(),0n);
 }finally{await h.close();}
});
test('R5: off-chain replica: 1688 mints in random order never exceed a cap and every random finds a skin',()=>{
 for(let trial=0;trial<5;trial++){const counts=[0n,0n,0n,0n,0n,0n];let pending=0;const seed=ethers.keccak256(ethers.toUtf8Bytes('trial'+trial));
  for(let id=1;id<=1688;id++){const pick=Number(BigInt(ethers.keccak256(coder.encode(['bytes32','uint256'],[seed,id+100000])))%10n);
   const direct=pick<3?pick:-1;if(direct>=0&&counts[direct]<CAPS[direct])counts[direct]++;else pending++;
   if(id%25===0||id===1688){while(pending){const s=draw(seed,BigInt(id*7+pending),counts);assert.ok(counts[s]<CAPS[s]);counts[s]++;pending--;}}}
  assert.deepEqual(counts,CAPS);}
});
test('owner 2026-10-28: the payment goes to paymentRecipient (the treasury Safe), fixed at deployment with no setter; R4 v4 approvals are rejected',async()=>{
 const h=await harness();try{await open(h,2);
  assert.equal(await h.contract.paymentRecipient(),RECIPIENT);
  for(const name of ['setPaymentRecipient','BURN_ADDRESS'])assert.equal(h.contract.interface.getFunction(name),null);
  const before=await h.token.balanceOf(RECIPIENT),payer=await h.token.balanceOf(h.a);await mintPaid(h,'treasury',0);
  assert.equal(await h.token.balanceOf(RECIPIENT),before+COST);assert.equal(await h.token.balanceOf(h.a),payer-COST);
  // an order the signer signed for another recipient, or another amount, is refused: the contract checks the signature
  // against its own recipient and price
  const q=await h.approval(h.a,'order-recipient',undefined,{choice:0});
  for(const bad of [await h.paidArgs(q,h.a,h.b),await h.paidArgs(q,h.a,RECIPIENT,COST-1n)])
   await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...bad),/GOLD_RESERVATION_AUTHORITY/);
  // a PaidAuthorization signed under the old v4 domain is refused
  const p=await h.approval(h.a,'v4',undefined,{choice:0}),args=await h.paidArgs(p);
  args[5]=await h.approvalSigner.signTypedData({name:'EmberEvoGenesisCandidate',version:'4',chainId:31337,verifyingContract:h.contract.target},GOLD_TYPES,args.auth);
  await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args),/GOLD_RESERVATION_AUTHORITY/);
 }finally{await h.close();}
});
test('owner 2026-10-28: ERC-2981 royalty of 2.5% to the treasury, fixed, for every token; the interface is announced',async()=>{
 const h=await harness();try{
  assert.equal(ethers.id('royaltyInfo(uint256,uint256)').slice(0,10),'0x2a55205a');   // the ERC-2981 interface id
  assert.equal(await h.contract.supportsInterface('0x2a55205a'),true);assert.equal(await h.contract.supportsInterface('0x49064906'),true);
  assert.equal(await h.contract.supportsInterface('0x80ac58cd'),true);assert.equal(await h.contract.supportsInterface('0xffffffff'),false);
  assert.equal(await h.contract.ROYALTY_BPS(),250n);
  for(const [id,price,fee] of [[1n,10n**18n,25n*10n**15n],[999n,10000n,250n],[5n,39n,0n],[0n,0n,0n]]){
   const [to,amount]=await h.contract.royaltyInfo(id,price);assert.equal(to,RECIPIENT);assert.equal(amount,fee);}
  for(const name of ['setRoyalty','setDefaultRoyalty','setTokenRoyalty'])assert.equal(h.contract.interface.getFunction(name),null);
 }finally{await h.close();}
});
test('gas review 2026-10-28: free claims are one bit per free-list index; the index is bound to its wallet, each is used once, and indices on both sides of a 256-bit word work',async()=>{
 const h=await harness();try{
  const fill=n=>Array.from({length:n},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
  const wallets=[...fill(255),h.a,h.b];   // alice at index 255 (word 0), bob at 256 (word 1)
  const {tree}=await h.configure(wallets);
  const args=(p,index,proofIndex=index)=>[p.key,p.choice,p.uri,p.deadline,p.signature,index,tree.proof(proofIndex),[]];
  const pa=await h.approval(h.a,'bit-a',undefined,{choice:0}),pb=await h.approval(h.b,'bit-b',undefined,{choice:0});
  // another wallet's index (with its proof) never verifies for the caller
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...args(pa,256)),/NOT_IN_SNAPSHOT/);
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...args(pa,256,255)),/NOT_IN_SNAPSHOT/);
  assert.equal(await h.contract.freeClaimed(255),false);
  await h.mine(h.contract.connect(h.alice).mintFree(...args(pa,255),TX));
  assert.equal(await h.contract.freeClaimed(255),true);assert.equal(await h.contract.freeClaimed(256),false);assert.equal(await h.contract.freeClaimed(254),false);
  const again=await h.approval(h.a,'bit-a2',undefined,{choice:0});
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...args(again,255)),/FREE_ALREADY_CLAIMED/);
  await h.mine(h.contract.connect(h.bob).mintFree(...args(pb,256),TX));
  assert.equal(await h.contract.freeClaimed(256),true);assert.equal(await h.contract.freeMinted(),2n);
 }finally{await h.close();}
});
test('owner 2026-10-28: deployment refuses a zero recipient or the payment token as recipient; the contract fits the 24,576-byte limit',async()=>{
 const h=await harness();try{
  const art=artifacts['contracts/EmberEvoGenesisCandidate.sol:EmberEvoGenesisCandidate'],f=new ethers.ContractFactory(art.abi,art.bytecode,h.admin);
  const args=r=>[h.a,h.token.target,h.a,r,COST,1n,'LOCAL'];
  for(const r of [ethers.ZeroAddress,h.token.target])await assert.rejects(h.provider.call(await f.getDeployTransaction(...args(r))),/INVALID_ROLE/);
  await h.provider.call(await f.getDeployTransaction(...args(RECIPIENT)));   // a plain address is fine
  const size=(art.runtimeBytecode.length-2)/2;assert.ok(size<=24576,'runtime '+size);
  assert.equal((await h.provider.getCode(h.contract.target)).length,art.runtimeBytecode.length);   // deployed with the limit enforced
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
