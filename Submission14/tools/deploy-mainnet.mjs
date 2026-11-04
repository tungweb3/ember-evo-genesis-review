// Ethereum mainnet deployment of EmberEvoGenesis (owner 2026-11-01). Everything the deployer key can do alone, in one run:
//   deploy (owner = the deployer, so the setup below needs no multisig round) -> setRevealURIs(pending, base, not locked)
//   -> setRevealCommit (the signer's acceptance names a block 2 below the head; it must land within 256 blocks, which a
//   2-of-3 Safe could miss) -> addPaymentToken(USDC, 1,600 GOLD; usable two days later) -> approvePaidPrice
//   -> transferOwnership(Safe). Minting stays paused: it cannot open without the free-list snapshot and the locked URIs, which
//   the Safe sets later together with the opening (contract/tools/safe-batch.mjs open), after it accepts ownership (safe-batch.mjs accept).
//
//   Dry run on a simulated chain with chainId 1 (stand-in tokens, a stand-in Safe address):  node contract/tools/deploy-mainnet.mjs --dry-run
//   Mainnet (deploy-mainnet.ps1 asks for the secrets and sets): RPC_URL, DEPLOYER_PRIVATE_KEY, SIGNER_KEY_FILE,
//     REVEAL_COMMIT (anchor of the mainnet reveal seed). Every other parameter is fixed below and checked on chain first.
//     PREFLIGHT_ONLY=1 sends nothing and takes RPC_URL, DEPLOYER_ADDRESS and SIGNER_ADDRESS, no key.
//   A run that stopped leaves contract/deployments/partial-1-<time>.json; --resume reads the chain and sends only what is missing.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {ethers,createTestProvider,testAuthority} from './runtime.mjs';
import {reportFailure} from './tool-errors.mjs';
import {revealChain,signRevealCommit} from '../../signer/reveal-chain.mjs';
import {METADATA_BASE_RE} from '../../signer/free-approval.mjs';
import {GENESIS} from './deploy-testnet.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const LOW128=(1n<<128n)-1n,PAYMENT_TOKEN_DELAY=2*86400,REPLACEMENT_GAS=1_000_000n,TIP_CEILING_TIMES=3n,TIP_CEILING_FLOOR=2_000_000_000n;
// a bid a node refused as too low, in the words of geth, reth, Nethermind, Erigon and Besu (Swarm audit 8b5de2de finding 3)
const bidTooLow=e=>e.code==='REPLACEMENT_UNDERPRICED'||/underpriced|insufficient gas price to replace|below .*minimum|fee too low|could not replace/i.test(String(e.message));
// a refused send can mean a bid is already held; a 502 or a rate limit says nothing about bids (Swarm audit 161d71af finding 5)
const mayHoldBid=e=>bidTooLow(e)||e.code==='TIMEOUT'||/already known|known transaction|already imported|same hash/i.test(String(e.message));
// a node answered no to this transaction: it holds no such thing. Any other error can come after the node took it
const refusedSend=e=>bidTooLow(e)||e.code==='NONCE_EXPIRED'||e.code==='INSUFFICIENT_FUNDS';
const STEP_NAMES=Object.freeze(['deploy EmberEvoGenesis','setRevealURIs (not locked)','setRevealCommit','addPaymentToken(USDC, 1600 GOLD)','approvePaidPrice','transferOwnership(Safe)']);
const sha256=hex=>createHash('sha256').update(Buffer.from(hex.replace(/^0x/,''),'hex')).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const MAINNET=Object.freeze({
 chainId:1,
 imdUSD:'0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25',   // imdUSD v1, 18 decimals (Etherscan-verified plain ERC-20)
 usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',     // Circle USDC, 6 decimals
 safe:'0x29e7c208481f648795f677b55F6ECb2bADc2F01E',     // EmberEvo Treasury, Safe v1.5.0, 2 of 3: payment recipient and owner
 safeOwners:['0x30E3E579E7EAe086E6D53999f95FAC5933e4D0AA','0x634Dd0f0EE2f73dB1a3D18af76deFaC7e47bCe73','0x1C651928150DADDDA9C2C040a9D4901d862f8eC4'],
 safeThreshold:2n,
 paidCost:20n*10n**18n,goldCost:1200n,usdcGoldCost:1600n,
 symbol:'EGEN',name:'Ember Evo Genesis',
 metadataBase:'https://genesis.imdember.com/meta/',
 pendingURI:'https://genesis.imdember.com/meta/pending.json',
 // the build published as Genesis Submission 11 (build/build-receipt.json), pinned here so a re-compile cannot move it. It differs
 // from the build Swarm audited as Submission 10 only in the 32 metadata-hash bytes: the @notice comment changed (audit 90ae2f92 finding 8).
 reviewed:Object.freeze({
  initcodeSha256:'388bfd2effddf5feccc0591cadd5c961f89d3222793a26f82ee365937a39e3d2',
  runtimeSha256:'5f6b7f0e5f4f9cc395cb291aa6cc82f03d5c6acb5a3455d18bb4c06490f67ff9',
  abiSha256:'91a76770538dc4e0fc7b2e47d7fb316ff00e2a569569a92abf5fb4be1835f035',
  extraTokenCountSlot:11,   // extraPaymentTokenCount in the storage layout of this build: a new build changes the hashes and this together
  runtimeBytes:24427}),
});
export const localBuild=()=>artifacts[GENESIS];
/** ethers answers a repeated read from a 250 ms cache by default: every read here must reach the RPC. */
export const mainnetProvider=url=>new ethers.JsonRpcProvider(url,undefined,{cacheTimeout:-1});
/** A stopped run is resumed and a finished one stays finished: neither may deploy a second contract. Returns the partial record to resume. */
export function runGuard(dir,resuming){
 let names=[];try{names=readdirSync(dir);}catch{}
 const partials=names.filter(n=>/^partial-1-\d+\.json$/.test(n)).sort(),finished=names.filter(n=>/^1-\d+\.json$/.test(n)).sort();
 if(resuming){if(partials.length!==1)throw Error('RESUME needs exactly one partial record, found '+partials.length);return join(dir,partials[0]);}
 if(partials.length)throw Error('UNFINISHED_RUN '+partials.join(',')+': resume it, do not deploy a second contract');
 if(finished.length)throw Error('FINISHED_RUN '+finished.join(',')+': a mainnet deployment is already recorded, do not deploy a second contract. For the Safe file run safe-batch.mjs accept with that record');
 return null;
}
/** Gas the deployer must be able to pay: the deployment is nearly all of it. */
export const gasToFund=(resume,deployed=false)=>deployed||resume?.steps?.some(x=>x.name==='deploy EmberEvoGenesis')?10_000_000n:45_000_000n;

/** Stops before anything is sent when the local artifact is not the reviewed build (Swarm audit 90ae2f92 finding 1). */
export function verifyBuild(build,cfg=MAINNET){
 const r=cfg.reviewed,bad=[];
 if(sha256(build.bytecode)!==r.initcodeSha256)bad.push('initcode');
 if(sha256(build.runtimeBytecode)!==r.runtimeSha256)bad.push('runtime');
 if(createHash('sha256').update(JSON.stringify(build.abi)).digest('hex')!==r.abiSha256)bad.push('abi');
 if((build.runtimeBytecode.length-2)/2!==r.runtimeBytes)bad.push('runtimeBytes');
 if(bad.length)throw Error('BUILD_NOT_REVIEWED '+bad.join(','));
}
/** The deployed code against the compiler's runtime: only immutables may differ, and those are 32 zero bytes in the template. */
export function runtimeMatches(template,code){
 const t=ethers.getBytes(template),c=ethers.getBytes(code);
 if(t.length!==c.length)return {ok:false,immutableRuns:0};
 let runs=0;
 for(let i=0;i<t.length;i++){
  if(t[i]===c[i])continue;
  if(t[i]!==0)return {ok:false,immutableRuns:runs};
  let s=i,e=i;while(s>0&&t[s-1]===0)s--;while(e<t.length&&t[e]===0)e++;
  if(e-s<32)return {ok:false,immutableRuns:runs};
  runs++;i=e-1;
 }
 return {ok:true,immutableRuns:runs};
}
/** The strings are stored as given: a wrong base breaks every token URI (Swarm audit 90ae2f92 finding 5). */
export function validateUris(cfg){
 if(typeof cfg.metadataBase!=='string'||!METADATA_BASE_RE.test(cfg.metadataBase))throw Error('METADATA_BASE_INVALID');
 if(typeof cfg.pendingURI!=='string'||!cfg.pendingURI.startsWith(cfg.metadataBase)||/\s/.test(cfg.pendingURI))throw Error('PENDING_URI_INVALID');
}

/** The deployer-only part of the mainnet setup; returns the record (every value read back from the chain).
 *  Each transaction has a fixed nonce, so a resend can only replace it, never add a second one. A load-balanced RPC can
 *  answer from a node behind the others (2026-10-29 rehearsal; Swarm audit 90ae2f92 finding 2), so nothing below trusts one read.
 *  checkpoint(state) is called before each send; resume is such a state: what the chain already shows is not sent again. */
export async function deployMainnet({deployer,revealSigner,revealCommit,cfg=MAINNET,build=localBuild(),log=()=>{},checkpoint=()=>{},resume=null,
 timing:{pollMs=2000,stepTimeoutMs=5*60_000,attempts=8,visibleReads=3,visibleTries=90}={}}){
 const provider=deployer.provider,{chainId}=await provider.getNetwork();
 if(chainId!==BigInt(cfg.chainId))throw Error('WRONG_CHAIN '+chainId);
 if(!/^0x[0-9a-fA-F]{64}$/.test(revealCommit??'')||BigInt(revealCommit)===0n)throw Error('REVEAL_COMMIT_INVALID');
 if(!revealSigner)throw Error('REVEAL_SIGNER_REQUIRED');
 const signerAddress=ethers.getAddress(await revealSigner.getAddress()),owner=await deployer.getAddress();
 if(signerAddress===owner)throw Error('SIGNER_IS_DEPLOYER');   // separate secrets (audit README section 7)
 verifyBuild(build,cfg);validateUris(cfg);
 const retry=async(read,tries=visibleTries)=>{
  let last;
  for(let i=0;i<tries;i++){try{return await read();}catch(e){last=e;await sleep(pollMs);}}
  throw last;
 };
 const stableNonce=async()=>{
  for(let i=0;i<visibleTries;i++){
   const a=await provider.getTransactionCount(owner,'latest').catch(()=>null),b=a===null?null:await provider.getTransactionCount(owner,'latest').catch(()=>null);
   if(a!==null&&a===b)return a;
   await sleep(pollMs);
  }
  throw Error('NONCE_NOT_STABLE');
 };
 let nonce,contract,planNonce;
 if(resume){
  if(ethers.getAddress(resume.deployer)!==owner)throw Error('RESUME_OTHER_DEPLOYER');
  if(resume.revealCommit!==revealCommit)throw Error('RESUME_OTHER_REVEAL_COMMIT');
  if(ethers.getAddress(resume.signer)!==signerAddress)throw Error('RESUME_OTHER_SIGNER');
  contract=ethers.getAddress(resume.contract);planNonce=resume.planNonce;
 }else{nonce=await stableNonce();planNonce=nonce;contract=ethers.getCreateAddress({from:owner,nonce});}
 const steps=[...(resume?.steps??[])],failed=[...(resume?.failed??[])];   // failed: transactions that reverted. Each spent a nonce and burned gas
 let seed=resume?.pending??null;   // a transaction a stopped run left waiting: it may still land, and a replacement must outbid it
 // waiting transactions of later steps, when a nonce under them came free and is filled first. The record keeps them until they are reached (Swarm audit 8b5de2de finding 4)
 const later=[...(resume?.queued??[])];
 if(!seed)seed=later.shift()??null;
 const nextSeed=()=>{seed=later.shift()??null;};
 const trimSeed=()=>{while(seed&&seed.nonce<nonce)nextSeed();};
 const state=extra=>{
  const queued=[...(seed?[seed]:[]),...later].filter(s=>s.hashes.length&&s.nonce>=nonce&&!(s.name===extra?.pending?.name&&s.nonce===extra.pending.nonce));
  return {deployer:owner,signer:signerAddress,revealCommit,contract,planNonce,steps,failed,...(queued.length?{queued}:{}),...extra};
 };
 const record=(name,rc,hashes)=>{(rc.status===1?steps:failed).push({name,hash:rc.hash,hashes:[...hashes],gasUsed:rc.gasUsed.toString(),blockNumber:rc.blockNumber,blockHash:rc.blockHash});};
 const feeText=f=>f?.maxFeePerGas==null?null:{maxFeePerGas:String(f.maxFeePerGas),maxPriorityFeePerGas:String(f.maxPriorityFeePerGas)};
 const feeOf=f=>({maxFeePerGas:BigInt(f.maxFeePerGas),maxPriorityFeePerGas:BigInt(f.maxPriorityFeePerGas)});

 const fees=async last=>{
  const f=await provider.getFeeData();
  if(f.maxFeePerGas==null)return {};
  const up=(v,prev,percent=125n)=>{const bumped=prev==null?0n:prev*percent/100n+1n;return v>bumped?v:bumped;};
  const tip=f.maxPriorityFeePerGas??0n,bid={maxFeePerGas:up(f.maxFeePerGas,last?.maxFeePerGas),maxPriorityFeePerGas:up(tip,last?.maxPriorityFeePerGas)};
  // the tip is paid in full: bids stop at a multiple of today's tip, also across resumes. A waiting transaction above it is only waited for
  const ceiling=tip*TIP_CEILING_TIMES>TIP_CEILING_FLOOR?tip*TIP_CEILING_TIMES:TIP_CEILING_FLOOR;
  if(bid.maxPriorityFeePerGas<=ceiling)return bid;
  // a node takes a replacement 10% above: the last bid is the ceiling itself, if that is enough (Swarm audit 8b5de2de finding 5)
  if(up(0n,last?.maxPriorityFeePerGas,110n)>ceiling)throw Object.assign(Error('TIP_CEILING the next bid passes '+ceiling+' wei of tip: check the deployer on Etherscan and resume later'),{code:'TIP_CEILING'});
  const cap=up(f.maxFeePerGas,last?.maxFeePerGas,110n);
  return {maxFeePerGas:cap>ceiling?cap:ceiling,maxPriorityFeePerGas:ceiling};
 };
 const firstReceipt=async(hashes,ms)=>{
  const end=Date.now()+ms;
  do{for(const h of hashes){const rc=await provider.getTransactionReceipt(h).catch(()=>null);if(rc)return rc;}await sleep(pollMs);}while(Date.now()<end);
  return null;
 };
 const settled=async rc=>{   // the block must be visible over several reads before the next step reads state from it
  for(let i=0,seen=0;i<visibleTries;i++){
   const n=await provider.getBlockNumber().catch(()=>-1),r=await provider.getTransactionReceipt(rc.hash).catch(()=>null);
   if(n>=rc.blockNumber&&r){if(++seen>=visibleReads)return;}else seen=0;
   await sleep(pollMs);
  }
  throw Error('RECEIPT_NOT_VISIBLE '+rc.hash);
 };
 // The receipt of a recorded transaction or of a replacement of it. null only when a node shows, in one answer, another block at that
 // height without any of them: a reorg took it out. Two requests can reach two nodes, so a missing receipt and a head past the block
 // prove nothing. Anything else stops the run instead (Swarm audit 161d71af finding 2, 8b5de2de finding 1).
 const recordedReceipt=async top=>{
  const hashes=top.hashes??[top.hash];let empty=0;
  for(let i=0;i<visibleTries;i++){
   for(const h of hashes){
    const r=await provider.getTransactionReceipt(h).catch(()=>null);
    if(r)return r;
   }
   const b=await provider.send('eth_getBlockByNumber',[ethers.toQuantity(top.blockNumber),true]).catch(()=>null);
   empty=b&&b.hash!==top.blockHash&&!b.transactions.some(t=>hashes.includes(t.hash??t))?empty+1:0;
   if(empty>=visibleReads)return null;
   await sleep(pollMs);
  }
  throw Error('RECEIPT_NOT_VISIBLE '+top.hash);
 };
 // A resume reads nothing before the chain shows what the record knows: its last transaction, then the one the stopped run left
 // waiting, and only then the nonce, which the record also bounds from below (Swarm audit 358f7f40 findings 1 and 2). An entry the
 // chain no longer shows leaves the record, so the gates and the read-back decide about that step from the chain.
 if(resume){
  const top=[...steps,...failed].reduce((a,b)=>!a||b.blockNumber>=a.blockNumber?b:a,null);
  let topLeft=false;
  if(top){
   const rc=await recordedReceipt(top),list=steps.includes(top)?steps:failed;
   if(rc)await settled(rc);
   list.splice(list.indexOf(top),1);
   if(rc)record(top.name,rc,top.hashes??[top.hash]);else{topLeft=true;log(top.name,'not on the chain any more: reading the chain instead of the record');}
  }
  // only a landed transaction bounds the nonce. One still waiting may sit above a nonce that came free, in a record that no longer holds the step below it, and
  // cannot land before that nonce is filled. A stale low read then sends at a spent nonce, which a node refuses (NONCE_MOVED) (Swarm audit 8b5de2de review)
  let floor=0;
  const open=[];
  for(const s of [...(seed?[seed]:[]),...later]){
   let rc=s.hashes.length?await firstReceipt(s.hashes,pollMs*5):null;
   if(!rc&&s.hashes.length&&await stableNonce()>s.nonce)rc=await firstReceipt(s.hashes,stepTimeoutMs);   // its nonce is spent: the receipt should come
   if(rc){await settled(rc);floor=Math.max(floor,s.nonce+1);record(s.name,rc,s.hashes);}else open.push(s);
  }
  seed=open.shift()??null;later.splice(0,later.length,...open);
  nonce=Math.max(await stableNonce(),floor,planNonce+steps.length+failed.length);
  trimSeed();
 }
 // a gate saw the waiting transaction land after the first look above: record it and move past its nonce (Swarm audit 161d71af finding 4)
 const seedLanded=async()=>{
  const rc=seed.hashes.length?await firstReceipt(seed.hashes,stepTimeoutMs):null;
  if(rc){await settled(rc);record(seed.name,rc,seed.hashes);nonce=Math.max(nonce,seed.nonce+1);}
  else{
   // it landed under another hash, normally at this nonce. A node can only read the count too low, so the highest read counts and what the
   // run knows stays. A count that stays at this nonce: the step landed below it and a resend no node holds took the record here, so it is free (Swarm audit 8b5de2de finding 6)
   let n=nonce;
   for(let i=0;i<visibleTries&&n<=seed.nonce;i++){
    n=Math.max(n,await provider.getTransactionCount(owner,'latest').catch(()=>0));
    if(n<=seed.nonce)await sleep(pollMs);
   }
   nonce=Math.max(n,planNonce+steps.length+failed.length);
  }
  nextSeed();
  checkpoint(state());
 };
 // a node that has not seen the contract estimates a plain transfer: the floor keeps such an estimate from running out of gas
 const gasLimit=async request=>{const g=await deployer.estimateGas(request)*12n/10n;return g>300_000n?g:300_000n;};
 /** One step at its nonce. A send that fails or waits too long is rebuilt and resent, with a higher fee, at the same nonce. */
 async function send(name,request,{revertRetries=0}={}){
  // last: the bid to beat, a placed one or one a node refused as too low; placed: the fee of a transaction a node took, which goes in the record;
  // knownLimit: the gas limit the step last went out on (Swarm audit 161d71af finding 9)
  let hashes=[],last=null,placed=null,lastError=null,knownLimit=null;
  const waiting=()=>({pending:{name,nonce,hashes,fee:feeText(placed),gasLimit:knownLimit===null?null:knownLimit.toString()}});
  // A waiting transaction of another step at this nonce: normally this step's read was stale, and sending it would replace that transaction. No
  // node holding it, or this step's own last try having reverted, is the real thing: at most one of them lands, and a held one must be outbid
  const meetSeed=async()=>{
   trimSeed();
   if(!seed?.hashes.length||seed.nonce!==nonce||seed.name===name)return;
   if(!(await Promise.all(seed.hashes.map(h=>provider.getTransaction(h).catch(()=>true)))).some(Boolean))return;
   if(!failed.some(f=>f.name===name))throw Error('RESUME_OUT_OF_ORDER '+name+' at the nonce of '+seed.name+' ('+seed.hashes.join(',')+'): run the resume again');
   if(seed.fee)last=feeOf(seed.fee);
  };
  await meetSeed();
  if(seed&&seed.name===name&&seed.nonce===nonce){hashes=[...seed.hashes];if(seed.gasLimit)knownLimit=BigInt(seed.gasLimit);if(seed.fee)last=placed=feeOf(seed.fee);}
  for(let a=0;a<attempts;a++){
   let sent=false,fee=null,own=null,fresh=false;
   try{
    const bid=await fees(last);
    // a node may estimate on top of the waiting transaction, and a step cannot run twice. A replacement holds the same nonce, so
    // at most one of them lands: it goes out on the limit the step already used, or a fixed one a record without it fits in
    const req=await request(),limit=await gasLimit(req).catch(e=>{if(placed&&req.to)return knownLimit??REPLACEMENT_GAS;throw e;});
    fee=bid;
    // signed here, so the record holds the hash before a reply can get lost on the way back (Swarm audit 8b5de2de finding 2)
    const signed=await deployer.signTransaction(await deployer.populateTransaction({...req,gasLimit:limit,nonce,...fee}));
    own=ethers.Transaction.from(signed).hash;fresh=!hashes.includes(own);
    if(fresh)hashes.push(own);
    knownLimit=limit;
    checkpoint(state(waiting()));
    await provider.broadcastTransaction(signed);
    last=placed=fee;sent=true;lastError=null;log(name,own);
    checkpoint(state(waiting()));
   }catch(e){
    lastError=e;
    if(fresh&&refusedSend(e))hashes.splice(hashes.indexOf(own),1);
    if(e.code==='TIP_CEILING'){
     // no higher bid: what remains is to wait for the one placed. A transaction no node holds any more has no bid to beat
     const held=(await Promise.all(hashes.map(h=>provider.getTransaction(h).catch(()=>true)))).some(Boolean);
     if(hashes.length&&last===placed&&!held)last=null;else sent=true;
    }else if(fee&&mayHoldBid(e))last=fee;   // the next attempt must beat it, or it would be refused the same way
    // no hash of this step explains a spent nonce: it went out under a lost hash, or the read was stale. A step never moves to a
    // new nonce unread (a deploy would be a second contract): a resume reads the chain first.
    if(e.code==='NONCE_EXPIRED'&&!hashes.length&&await stableNonce()>nonce){checkpoint(state());throw Error('NONCE_MOVED '+name+': the chain is past nonce '+nonce+'. Run the resume again');}
   }
   const rc=hashes.length?await firstReceipt(hashes,sent?stepTimeoutMs:pollMs*3):(await sleep(pollMs*3),null);
   if(!rc)continue;
   await settled(rc);nonce++;
   record(name,rc,hashes);checkpoint(state());
   if(rc.status!==1){
    if(revertRetries-->0){hashes=[];last=placed=null;await meetSeed();continue;}
    throw Error('TX_FAILED '+name);
   }
   return rc;
  }
  checkpoint(state(waiting()));
  throw lastError&&!hashes.length?lastError:Error('STEP_STUCK '+name+(lastError?.code==='TIP_CEILING'?': '+lastError.message:lastError?.code?': '+lastError.code+(lastError.error?.message?' ('+lastError.error.message+')':''):''));
 }
 // a block 2 below the head, read from one head and twice the same hash (a lagging or forked node cannot name it)
 async function recentBlock(){
  for(let i=0;i<visibleTries;i++){
   const head=await provider.getBlock('latest').catch(()=>null);
   if(head&&head.number>=2){const a=await provider.getBlock(head.number-2).catch(()=>null),b=a&&await provider.getBlock(head.number-2).catch(()=>null);if(a&&b&&a.hash===b.hash)return a;}
   await sleep(pollMs);
  }
  throw Error('COMMIT_BLOCK_NOT_VISIBLE');
 }
 const stepBlock=name=>steps.find(s=>s.name===name)?.blockNumber;
 // a step the record shows landed does not go out again. A lagging node answers with an old value, which can only say "not done":
 // on a resume every read must say so first (Swarm audit 358f7f40 finding 2). The read-back below has the last word on the values.
 const notDone=async(name,isDone)=>{
  trimSeed();
  if(stepBlock(name)!==undefined)return false;
  for(let i=0;i<(resume?visibleReads:1);i++){
   if(i)await sleep(pollMs);
   if(await retry(isDone)){if(seed?.name===name)await seedLanded();return false;}
  }
  return true;
 };

 const genesisArgs=[owner,ethers.getAddress(cfg.imdUSD),signerAddress,ethers.getAddress(cfg.safe),cfg.paidCost,cfg.goldCost,cfg.symbol];
 const factory=new ethers.ContractFactory(build.abi,build.bytecode,deployer);
 const genesis=new ethers.Contract(contract,build.abi,deployer);
 const hasCode=()=>provider.getCode(contract).then(c=>c!=='0x').catch(()=>false);
 // a load-balanced RPC can answer from a node that has not seen the block yet
 async function codeVisible(){
  for(let i=0,seen=0;i<visibleTries;i++){if(await hasCode()){if(++seen>=visibleReads)return;}else seen=0;await sleep(pollMs);}
  throw Error('CODE_NOT_VISIBLE '+contract);
 }
 // an RPC error is not "no code", and on a resume one empty answer may be a lagging node
 const codeAbsent=async()=>{for(let i=0;i<(resume?10:1);i++){if(await retry(()=>provider.getCode(contract))!=='0x')return false;if(resume)await sleep(pollMs);}return true;};
 checkpoint(state(seed?.nonce===nonce?{pending:seed}:{}));   // above the nonce it is queued: a stop here must not make the next resume start from its nonce
 if(await codeAbsent()){
  if(nonce!==planNonce)throw Error('PLANNED_NONCE_USED no code at '+contract+' but the deployer has sent transactions since the plan. Open the deployer on Etherscan: if the contract exists, wait and resume; if the deploy reverted or another transaction took its nonce, archive this partial record by hand and start again');
  const rc=await send('deploy EmberEvoGenesis',()=>factory.getDeployTransaction(...genesisArgs));
  if(rc.contractAddress&&ethers.getAddress(rc.contractAddress)!==contract)throw Error('DEPLOYED_ELSEWHERE '+rc.contractAddress);
 }else if(seed?.name==='deploy EmberEvoGenesis')await seedLanded();
 await codeVisible();
 if(resume){   // the record says this deployer set the contract up; the chain has the last word
  await retry(async()=>{if(!runtimeMatches(build.runtimeBytecode,await provider.getCode(contract)).ok)throw Error('RESUME_CODE_NOT_REVIEWED');});
  const o=await retry(()=>genesis.owner());if(ethers.getAddress(o)!==owner)throw Error('RESUME_NOT_OWNER '+o);
 }
 if(await notDone('setRevealURIs (not locked)',async()=>await genesis.revealBaseURI()===cfg.metadataBase&&await genesis.pendingURI()===cfg.pendingURI))
  await send('setRevealURIs (not locked)',()=>genesis.setRevealURIs.populateTransaction(cfg.pendingURI,cfg.metadataBase,false));
 if(await notDone('setRevealCommit',async()=>(await genesis.revealCommit()).toLowerCase()===revealCommit.toLowerCase()))
  // the acceptance is valid only while blockhash() knows its block: every resend signs a fresh one
  await send('setRevealCommit',async()=>{
   const block=await recentBlock();
   const acceptance=await signRevealCommit({signer:revealSigner,chainId,contractAddress:contract,commit:revealCommit,previous:await genesis.revealCommit(),signerEpoch:await genesis.signerEpoch(),block});
   return genesis.setRevealCommit.populateTransaction(revealCommit,block.number,acceptance);
  },{revertRetries:2});
 if(await notDone('addPaymentToken(USDC, 1600 GOLD)',async()=>await genesis.paymentTokens(ethers.getAddress(cfg.usdc))!==0n))
  await send('addPaymentToken(USDC, 1600 GOLD)',()=>genesis.addPaymentToken.populateTransaction(ethers.getAddress(cfg.usdc),cfg.usdcGoldCost));
 if(await notDone('approvePaidPrice',()=>genesis.paidPriceApproved()))
  await send('approvePaidPrice',()=>genesis.approvePaidPrice.populateTransaction());
 if(await notDone('transferOwnership(Safe)',async()=>ethers.getAddress(await genesis.pendingOwner())===ethers.getAddress(cfg.safe)))
  await send('transferOwnership(Safe)',()=>genesis.transferOwnership.populateTransaction(ethers.getAddress(cfg.safe)));

 // read back everything the next steps (Safe, signer Worker, World GOLD book, Etherscan) depend on
 const deployBlock=stepBlock('deploy EmberEvoGenesis')??Number(await retry(()=>genesis.startBlock()));
 const addBlock=stepBlock('addPaymentToken(USDC, 1600 GOLD)');
 const blockTime=n=>retry(async()=>{const b=await provider.getBlock(n);if(!b)throw Error('BLOCK_NOT_VISIBLE '+n);return b.timestamp;});
 const usdcUsableAt=addBlock!==undefined?await blockTime(addBlock)+PAYMENT_TOKEN_DELAY:null;
 // a step the chain shows and the record lost has no block to read: usableAt must still fall between the deploy and now (Swarm audit 8b5de2de finding 7)
 const usableFrom=usdcUsableAt===null?await blockTime(deployBlock)+PAYMENT_TOKEN_DELAY:null;
 const read=f=>retry(()=>genesis[f](),5);   // one read a lagging node cannot answer must not cost the whole pass below
 const readToken=async t=>{const p=await retry(()=>genesis.paymentTokens(t),5);return {token:ethers.getAddress(t),amount:(p&LOW128).toString(),goldCost:((p>>128n)&((1n<<88n)-1n)).toString(),usableAt:Number(p>>216n)};};
 const expect={name:cfg.name,symbol:cfg.symbol,owner,pendingOwner:ethers.getAddress(cfg.safe),recipient:ethers.getAddress(cfg.safe),signer:signerAddress,
  paidCost:cfg.paidCost.toString(),goldCost:cfg.goldCost.toString(),mintPaused:true,paidPriceApproved:true,revealURIsLocked:false,revealCommit,
  pendingURI:cfg.pendingURI,metadataBase:cfg.metadataBase,maxSupply:'1688',snapshotConfigured:false,domainVersion:'7',domainName:'EmberEvoGenesisCandidate',
  domainChainId:String(chainId),domainContract:contract,signerEpoch:'1',startBlock:String(deployBlock),runtimeBytes:String(cfg.reviewed.runtimeBytes)};
 let got,paymentTokens,code,codeCheck,mismatch,readError,now;
 for(let i=0;i<10;i++){   // a mismatch from a lagging node clears; a real one stays and is returned
  try{
   const domain=await read('eip712Domain');
   if(usableFrom!==null)now=await blockTime('latest');
   paymentTokens=[await readToken(cfg.imdUSD),await readToken(cfg.usdc)];code=await retry(()=>provider.getCode(contract),5);codeCheck=runtimeMatches(build.runtimeBytecode,code);
   got={name:await read('name'),symbol:await read('symbol'),owner:await read('owner'),pendingOwner:await read('pendingOwner'),
    recipient:await read('paymentRecipient'),signer:await read('appearanceSigner'),paidCost:(await read('paidCost')).toString(),goldCost:(await read('paidGoldCost')).toString(),
    mintPaused:await read('mintPaused'),paidPriceApproved:await read('paidPriceApproved'),revealURIsLocked:await read('revealURIsLocked'),
    revealCommit:await read('revealCommit'),pendingURI:await read('pendingURI'),metadataBase:await read('revealBaseURI'),maxSupply:(await read('maxSupply')).toString(),
    snapshotConfigured:await read('snapshotConfigured'),domainVersion:domain[2],domainName:domain[1],domainChainId:domain[3].toString(),domainContract:domain[4],
    signerEpoch:(await read('signerEpoch')).toString(),startBlock:(await read('startBlock')).toString(),runtimeBytes:String((code.length-2)/2)};
  }catch(e){readError=e;await sleep(pollMs);continue;}
  mismatch=Object.keys(expect).filter(k=>String(got[k]).toLowerCase()!==String(expect[k]).toLowerCase());
  if(!codeCheck.ok)mismatch.push('runtime');
  if(paymentTokens[0].amount!==cfg.paidCost.toString()||paymentTokens[0].goldCost!==cfg.goldCost.toString())mismatch.push('paymentTokens(imdUSD)');
  if(paymentTokens[1].amount!==(cfg.paidCost/10n**12n).toString()||paymentTokens[1].goldCost!==cfg.usdcGoldCost.toString())mismatch.push('paymentTokens(USDC)');
  if(usdcUsableAt!==null&&paymentTokens[1].usableAt!==usdcUsableAt)mismatch.push('paymentTokens(USDC).usableAt');
  if(usableFrom!==null&&(paymentTokens[1].usableAt<usableFrom||paymentTokens[1].usableAt>now+PAYMENT_TOKEN_DELAY))mismatch.push('paymentTokens(USDC).usableAt');
  if(!mismatch.length)break;
  await sleep(pollMs);
 }
 if(!got)throw readError;
 const codeHash=ethers.keccak256(code);
 return {chainId:Number(chainId),contract,deployBlock,startBlock:Number(got.startBlock),owner:got.owner,pendingOwner:got.pendingOwner,
  safe:ethers.getAddress(cfg.safe),token:ethers.getAddress(cfg.imdUSD),usdc:ethers.getAddress(cfg.usdc),paymentTokens,recipient:got.recipient,signer:signerAddress,
  symbol:got.symbol,name:got.name,pendingURI:got.pendingURI,metadataBase:got.metadataBase,revealURIsLocked:got.revealURIsLocked,revealCommit,paidCost:got.paidCost,goldCost:got.goldCost,
  domainVersion:got.domainVersion,maxSupply:got.maxSupply,mintPaused:got.mintPaused,snapshotConfigured:false,codeHash,runtimeBytes:(code.length-2)/2,
  reviewedBuild:{initcodeSha256:cfg.reviewed.initcodeSha256,runtimeSha256:cfg.reviewed.runtimeSha256,immutableRuns:codeCheck.immutableRuns},
  readBackMismatch:mismatch,steps,failed,totalGas:[...steps,...failed].reduce((a,s)=>a+BigInt(s.gasUsed),0n).toString(),
  // on the chain, by the gates, but with no hash in the record: their gas is not in totalGas
  notInRecord:STEP_NAMES.filter(n=>stepBlock(n)===undefined),
  etherscan:{contractName:GENESIS,compiler:'v0.8.38+commit.1835d247',constructorArgsHex:factory.interface.encodeDeploy(genesisArgs).slice(2)}};
}

/** The World GOLD book registry entry (server/genesis-deployments.ts, World 7d09bda format), from the read-backs. */
export function mainnetGoldBookEntry(d){
 const [base,usdc]=d.paymentTokens;
 return {id:'mainnet-genesis-'+d.contract.slice(2,10).toLowerCase(),environment:'production',chainId:d.chainId,contract:d.contract.toLowerCase(),codeHash:d.codeHash,
  deployBlock:String(d.startBlock),embeoCost:d.paidCost,paymentToken:base.token.toLowerCase(),goldCost:base.goldCost,paymentAmount:base.amount,
  addedTokens:[{token:usdc.token.toLowerCase(),goldCost:usdc.goldCost,amount:usdc.amount}],signer:d.signer.toLowerCase(),
  domainVersion:d.domainVersion,recipient:d.recipient.toLowerCase()};
}

/** Checks the fixed mainnet parameters against the chain before anything is sent. */
export async function preflight(provider,deployerAddress,signerAddress,cfg=MAINNET,build=localBuild(),resume=null,{allowUsedDeployer=false}={}){
 const E=['function symbol() view returns (string)','function decimals() view returns (uint8)'];
 const S=['function getOwners() view returns (address[])','function getThreshold() view returns (uint256)','function VERSION() view returns (string)'];
 const out={};
 verifyBuild(build,cfg);validateUris(cfg);
 out.reviewedBuild=cfg.reviewed.runtimeSha256;
 if((await provider.getNetwork()).chainId!==1n)throw Error('RPC_URL is not Ethereum mainnet');
 const im=new ethers.Contract(cfg.imdUSD,E,provider),us=new ethers.Contract(cfg.usdc,E,provider);
 if(await im.symbol()!=='imdUSD'||await im.decimals()!==18n)throw Error('imdUSD check failed');
 if(await us.symbol()!=='USDC'||await us.decimals()!==6n)throw Error('USDC check failed');
 const safe=new ethers.Contract(cfg.safe,S,provider);
 const owners=(await safe.getOwners()).map(a=>ethers.getAddress(a)).sort(),want=cfg.safeOwners.map(a=>ethers.getAddress(a)).sort();
 if(JSON.stringify(owners)!==JSON.stringify(want)||await safe.getThreshold()!==cfg.safeThreshold)throw Error('Safe owners/threshold changed: stopped');
 out.safe=`${cfg.safe} v${await safe.VERSION()} ${cfg.safeThreshold} of ${owners.length}`;
 if(ethers.getAddress(signerAddress)===ethers.getAddress(deployerAddress))throw Error('the approval signer must not be the deployer');
 if(want.includes(ethers.getAddress(signerAddress)))throw Error('the approval signer must not be a Safe owner');
 if(want.includes(ethers.getAddress(deployerAddress)))throw Error('the deployer must be a fresh wallet, not a Safe owner');
 const bal=await provider.getBalance(deployerAddress),fee=await provider.getFeeData();
 out.deployerEth=ethers.formatEther(bal);out.maxFeeGwei=ethers.formatUnits(fee.maxFeePerGas??fee.gasPrice??0n,'gwei');
 out.deployerNonce=await provider.getTransactionCount(deployerAddress,'latest');
 // the local records can be lost with a drive: the chain still shows this wallet has sent transactions, maybe a whole deployment
 if(!resume&&out.deployerNonce!==0&&!allowUsedDeployer)throw Error(`DEPLOYER_NOT_FRESH this wallet has already sent ${out.deployerNonce} transactions. Check it on Etherscan: if it deployed this contract, restore contract/deployments and resume, do not deploy a second contract. Otherwise use a fresh wallet, or set ALLOW_USED_DEPLOYER=1`);
 // about 6.3M gas for the six transactions today (Osaka pricing; ~40M if EIP-8037 is live): refuse a wallet that cannot pay 45M at maxFee
 const deployed=resume?.contract?await provider.getCode(resume.contract)!=='0x':false;
 const need=gasToFund(resume,deployed)*(fee.maxFeePerGas??fee.gasPrice??0n);
 out.needEth=ethers.formatEther(need);
 if(bal<need)throw Error(`deployer has ${out.deployerEth} ETH, needs about ${out.needEth}`);
 return out;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run'),resuming=process.argv.includes('--resume');
 const dir=process.env.DEPLOYMENTS_DIR??fileURLToPath(new URL('../deployments/',import.meta.url));
 const writeAtomic=(file,text)=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',text);renameSync(file+'.tmp',file);};
 let lastStep='none',partialFile=null,close=()=>{};
 try{
  let deployer,revealSigner,revealCommit,cfg=MAINNET,resume=null;
  if(dry){
   const rpc=await createTestProvider(1),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});
   deployer=testAuthority(0).connect(provider);close=()=>rpc.disconnect();revealSigner=testAuthority(1);
   revealCommit=revealChain(ethers.keccak256(ethers.toUtf8Bytes('ember-evo-genesis MAINNET DRY RUN reveal chain'))).anchor;
   // local fixtures (the Sepolia test tokens refuse chainId 1): 18 decimals for imdUSD, 6 for USDC
   const dep=async(k,...a)=>{const c=await new ethers.ContractFactory(artifacts[k].abi,artifacts[k].bytecode,deployer).deploy(await deployer.getAddress(),...a);await c.waitForDeployment();return c.getAddress();};
   cfg={...MAINNET,imdUSD:await dep('contracts/test/Fixtures.sol:FixtureToken'),usdc:await dep('contracts/test/Fixtures.sol:DecimalsToken',6),safe:testAuthority(4).address};
  }else{
   const need=k=>{const v=process.env[k];if(!v)throw Error('missing env '+k);return v.trim();};
   partialFile=runGuard(dir,resuming);
   if(partialFile)resume=JSON.parse(readFileSync(partialFile,'utf8'));
   const provider=mainnetProvider(need('RPC_URL')),only=process.env.PREFLIGHT_ONLY==='1';
   // a check that sends nothing needs the addresses, not the keys (Swarm audit 358f7f40 finding 7)
   if(!only){
    deployer=new ethers.Wallet(need('DEPLOYER_PRIVATE_KEY'),provider);
    revealSigner=new ethers.Wallet(readFileSync(need('SIGNER_KEY_FILE'),'utf8').trim());
    revealCommit=need('REVEAL_COMMIT');
   }
   const deployerAddress=only?ethers.getAddress(need('DEPLOYER_ADDRESS')):await deployer.getAddress(),signerAddress=only?ethers.getAddress(need('SIGNER_ADDRESS')):revealSigner.address;
   console.log(JSON.stringify(await preflight(provider,deployerAddress,signerAddress,MAINNET,localBuild(),resume,{allowUsedDeployer:process.env.ALLOW_USED_DEPLOYER==='1'}),null,1));
  }
  if(dry||process.env.PREFLIGHT_ONLY!=='1'){
   partialFile??=dry?null:join(dir,`partial-1-${Date.now()}.json`);
   const d=await deployMainnet({deployer,revealSigner,revealCommit,cfg,resume,timing:dry?{pollMs:10}:undefined,log:(n,h)=>{lastStep=n;console.log('  ',n,h);},
    checkpoint:partialFile?s=>writeAtomic(partialFile,JSON.stringify(s,null,1)):()=>{}});
   const file=join(dir,`${dry?'dryrun-':''}${d.chainId}-${Date.now()}.json`);
   writeAtomic(file,JSON.stringify({...d,followUp:{goldBookRegistry:mainnetGoldBookEntry(d),
    workerVars:{CHAIN_ID:String(d.chainId),CONTRACT_ADDRESS:d.contract,METADATA_BASE:d.metadataBase,PAYMENT_TOKENS:d.paymentTokens.map(t=>t.token).join(',')}}},null,1));
   if(partialFile&&!d.readBackMismatch.length)rmSync(partialFile,{force:true});   // a mismatch stays open: a resume reads it back again
   console.log(JSON.stringify({contract:d.contract,owner:d.owner,pendingOwner:d.pendingOwner,paymentTokens:d.paymentTokens,readBackMismatch:d.readBackMismatch,totalGas:d.totalGas,notInRecord:d.notInRecord,file},null,1));
   if(d.readBackMismatch.length)process.exitCode=2;
  }
 }catch(e){reportFailure(e,{lastStep,partialRecord:partialFile});}
 finally{await close();}
}
