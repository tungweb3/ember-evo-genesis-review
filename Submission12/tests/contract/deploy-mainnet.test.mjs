import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ethers,createTestProvider,testAuthority} from '../tools/runtime.mjs';
import {GENESIS,SEPOLIA} from '../tools/deploy-testnet.mjs';
const FIXTURE_18='contracts/test/Fixtures.sol:FixtureToken',FIXTURE_DEC='contracts/test/Fixtures.sol:DecimalsToken';
import {deployMainnet,mainnetGoldBookEntry,MAINNET,verifyBuild,runtimeMatches,validateUris,localBuild,mainnetProvider,runGuard,gasToFund} from '../tools/deploy-mainnet.mjs';
import {acceptBatch,openBatch,calldataOf,batchChecksum,unix,chainState,checkAccept,checkOpen,checkRecord,checkWorkerList,checkPendingServed,checkSampleServed,contractWallets,holds,stableHead,recordBlock} from '../tools/safe-batch.mjs';
import {redact,failureSummary} from '../tools/tool-errors.mjs';
import {FreeApprovalSigner,snapshotTree} from '../../signer/free-approval.mjs';
import {PaidApprovalSigner} from '../../signer/paid-approval.mjs';
import {revealChain,readyReveals} from '../../signer/reveal-chain.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const look={body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null};
const FAST={pollMs:1,visibleTries:40,stepTimeoutMs:5};
async function chain(id){const rpc=await createTestProvider(id),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});return {rpc,provider};}
const now=async p=>(await p.getBlock('latest')).timestamp;
// Stand-ins on the simulated chain (the Sepolia test tokens refuse chainId 1): local fixtures with 18 decimals for imdUSD
// and 6 for USDC, test account 4 for the Safe.
export async function standIns(deployer){
 const dep=async(k,...args)=>{const c=await new ethers.ContractFactory(artifacts[k].abi,artifacts[k].bytecode,deployer).deploy(await deployer.getAddress(),...args);await c.waitForDeployment();return c.getAddress();};
 return {...MAINNET,imdUSD:await dep(FIXTURE_18),usdc:await dep(FIXTURE_DEC,6),safe:testAuthority(4).address};
}
// The Safe's transactions from a Transaction Builder file, sent by the stand-in Safe account.
async function execute(provider,file,safe){for(const t of file.transactions)await (await safe.sendTransaction({to:t.to,data:calldataOf(t),value:0n})).wait();}

test('mainnet deploy on a simulated chainId 1: deployer setup, Safe accepts ownership, then the Safe sets the free list and opens',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),alice=await provider.getSigner(1),bob=await provider.getSigner(2),key=testAuthority(1);
  const cfg=await standIns(deployer),rc=revealChain(ethers.keccak256(ethers.toUtf8Bytes('mainnet deploy test reveal chain')),64);
  // the signer key must not be the deployer's (separate secrets)
  await assert.rejects(deployMainnet({deployer,revealSigner:deployer,revealCommit:rc.anchor,cfg}),/SIGNER_IS_DEPLOYER/);
  const d=await deployMainnet({deployer,revealSigner:key,revealCommit:rc.anchor,cfg,timing:FAST});
  assert.deepEqual(d.readBackMismatch,[]);
  assert.equal(d.revealURIsLocked,false);assert.ok(d.reviewedBuild.immutableRuns>0);assert.equal(d.deployBlock,d.startBlock);
  assert.equal(d.chainId,1);assert.equal(d.owner,await deployer.getAddress());assert.equal(d.pendingOwner,cfg.safe);assert.equal(d.recipient,cfg.safe);
  assert.equal(d.symbol,'EGEN');assert.equal(d.metadataBase,'https://genesis.imdember.com/meta/');assert.equal(d.mintPaused,true);
  assert.equal(d.paymentTokens[0].amount,'20000000000000000000');assert.equal(d.paymentTokens[0].goldCost,'1200');
  assert.equal(d.paymentTokens[1].amount,'20000000');assert.equal(d.paymentTokens[1].goldCost,'1600');
  assert.ok(d.paymentTokens[1].usableAt>=await now(provider)+2*86400-60);
  assert.equal(d.runtimeBytes,24427);
  const reg=mainnetGoldBookEntry(d);
  assert.equal(reg.environment,'production');assert.equal(reg.paymentAmount,'20000000000000000000');assert.deepEqual(reg.addedTokens,[{token:cfg.usdc.toLowerCase(),goldCost:'1600',amount:'20000000'}]);
  const g=new ethers.Contract(d.contract,artifacts[GENESIS].abi,provider);
  // nobody can open before the Safe sets the free list; the deployer can still act as owner until the Safe accepts
  await assert.rejects(g.connect(deployer).setMintPaused.staticCall(false),/OPEN_NOT_READY/);
  assert.equal(await g.revealURIsLocked(),false);
  const safe=new ethers.Wallet(testAuthority(4).privateKey,provider);
  await execute(provider,acceptBatch(d),safe);
  assert.equal(await g.owner(),cfg.safe);assert.equal(await g.pendingOwner(),ethers.ZeroAddress);
  await assert.rejects(g.connect(deployer).approvePaidPrice.staticCall(),/OwnableUnauthorizedAccount/);
  // the opening batch: free list (with a duplicate, removed) + unpause; opening 7 hours later
  const wallets=[await alice.getAddress(),await bob.getAddress(),(await alice.getAddress()).toLowerCase()],t=await now(provider);
  assert.throws(()=>openBatch(d,wallets,t-60,t+3600,t),/at least 6 hours/);
  assert.throws(()=>openBatch(d,wallets,t+60,t+7*3600,t),/in the past/);
  const o=openBatch(d,wallets,t-60,t+7*3600,t);
  assert.equal(o.tree.count,2);assert.equal(o.file.transactions.length,3);assert.equal(o.file.transactions[0].contractMethod.name,'setRevealURIs');assert.equal(o.file.transactions[0].contractInputsValues.lock,'true');assert.equal(o.file.chainId,'1');assert.equal(o.file.meta.createdFromSafeAddress,cfg.safe);
  await execute(provider,o.file,safe);
  assert.equal(await g.snapshotConfigured(),true);assert.equal(await g.mintPaused(),false);assert.equal(await g.revealURIsLocked(),true);assert.equal(await g.eligibleWalletCount(),2n);
  const signer=new FreeApprovalSigner({provider,contractAddress:d.contract,chainId:1,signer:key,metadataBase:d.metadataBase,snapshotWallets:wallets});
  // a Worker bundling another free list stops selling paid mints too (audit 90ae2f92 finding 7)
  const paid=root=>new PaidApprovalSigner({provider,contractAddress:d.contract,chainId:1,signer:key,metadataBase:d.metadataBase,gold:{reserve(){}},deploymentId:'test',ticketSecret:'s'.repeat(32),snapshotRoot:root});
  const order={wallet:await alice.getAddress(),look,choice:1,token:cfg.imdUSD};
  await assert.rejects(paid('0x'+'1'.repeat(64)).prepare(order),{code:'SNAPSHOT_MISMATCH'});
  await assert.rejects(paid(o.tree.root).prepare(order),{code:'PAID_NOT_AVAILABLE'});   // past the check: not open yet
  await assert.rejects(signer.approve({wallet:await alice.getAddress(),look,choice:0}),{code:'SALE_NOT_STARTED'});
  await rpc.request({method:'evm_increaseTime',params:[7*3600+1]});await rpc.request({method:'evm_mine',params:[]});
  const m=(await signer.approve({wallet:await alice.getAddress(),look,choice:1})).mintFree;
  const reveals=(await readyReveals({provider,contractAddress:d.contract,chain:rc})).reveals;
  await (await g.connect(alice).mintFree(m.lookKey,m.choice,m.uri,m.deadline,m.signature,m.index,m.proof,reveals)).wait();
  assert.equal(await g.ownerOf(1),await alice.getAddress());
  assert.equal(await g.tokenURI(1),'https://genesis.imdember.com/meta/'+m.lookKey+'/1');
  // the Safe can set the free list only once
  await assert.rejects(g.connect(safe).configureSnapshot.staticCall(o.tree.root,2,t-60,t+8*3600),/SNAPSHOT_ALREADY_FIXED/);
 }finally{await rpc.disconnect();}
});

test('the mainnet tool refuses another chain',async()=>{
 const {rpc,provider}=await chain(SEPOLIA);try{
  const deployer=await provider.getSigner(0);
  await assert.rejects(deployMainnet({deployer,revealSigner:testAuthority(1),revealCommit:'0x'+'1'.repeat(64)}),/WRONG_CHAIN/);
 }finally{await rpc.disconnect();}
});

// Swarm audit 90ae2f92: what the mainnet tools do when the local build, the RPC, a step or the owner's input goes wrong.
const COMMIT=()=>revealChain(ethers.keccak256(ethers.toUtf8Bytes('mainnet tool failure tests')),64).anchor;
// The same deployer behind an RPC that lags: every read below can answer as a node a block or more behind would.
function laggingDeployer(deployer,share=0.3){
 let seed=7;const lag=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff<share;};
 const provider=new Proxy(deployer.provider,{get(t,k){
  const v=t[k];
  if(k==='getBlockNumber')return async()=>{const b=await t.getBlockNumber();return lag()?b-1:b;};
  if(k==='getBlock')return async b=>lag()?null:t.getBlock(b);
  if(k==='getCode')return async a=>lag()?'0x':t.getCode(a);
  if(k==='getTransactionReceipt')return async h=>lag()?null:t.getTransactionReceipt(h);
  return typeof v==='function'?v.bind(t):v;}});
 const sent=[];
 return {sent,signer:new Proxy(deployer,{get(t,k){
  if(k==='provider')return provider;
  if(k==='sendTransaction')return async tx=>{sent.push(tx);return t.sendTransaction(tx);};
  const v=t[k];return typeof v==='function'?v.bind(t):v;}})};
}

test('the local build must be the reviewed one: refused before anything is sent',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),build=localBuild();
  assert.doesNotThrow(()=>verifyBuild(build));
  const receipt=JSON.parse(readFileSync(new URL('../artifacts/build-receipt.private.json',import.meta.url),'utf8')).artifacts[GENESIS];
  assert.equal(MAINNET.reviewed.initcodeSha256,receipt.creationBytecodeSha256);assert.equal(MAINNET.reviewed.runtimeSha256,receipt.runtimeTemplateSha256);assert.equal(MAINNET.reviewed.abiSha256,receipt.abiSha256);
  const flip=h=>h.slice(0,-1)+(h.endsWith('0')?'1':'0');
  const before=await provider.getTransactionCount(await deployer.getAddress());
  for(const bad of [{...build,bytecode:flip(build.bytecode)},{...build,runtimeBytecode:flip(build.runtimeBytecode)},{...build,abi:build.abi.slice(1)},artifacts['contracts/test/Fixtures.sol:SupplyBoundaryHarness']])
   await assert.rejects(deployMainnet({deployer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,build:bad,timing:FAST}),/BUILD_NOT_REVIEWED/);
  assert.equal(await provider.getTransactionCount(await deployer.getAddress()),before);
 }finally{await rpc.disconnect();}
});

test('deployed code: only immutable slots may differ from the reviewed runtime',()=>{
 const zero='00'.repeat(32),t='0x6001'+zero+'6002',filled='0x6001'+'00'.repeat(12)+'ab'.repeat(20)+'6002';
 assert.deepEqual(runtimeMatches(t,filled),{ok:true,immutableRuns:1});
 assert.equal(runtimeMatches(t,'0x6009'+zero+'6002').ok,false);          // code outside a slot changed
 assert.equal(runtimeMatches('0x6001'+'00'.repeat(5)+'6002','0x6001'+'ab'.repeat(5)+'6002').ok,false);   // zeros too short to be a slot
 assert.equal(runtimeMatches(t,t+'00').ok,false);                        // another length
});

test('metadata strings are checked before they are stored',()=>{
 assert.doesNotThrow(()=>validateUris(MAINNET));
 assert.throws(()=>validateUris({...MAINNET,metadataBase:'https://genesis.imdember.com/meta'}),/METADATA_BASE_INVALID/);
 assert.throws(()=>validateUris({...MAINNET,metadataBase:'http://genesis.imdember.com/meta/'}),/METADATA_BASE_INVALID/);
 assert.throws(()=>validateUris({...MAINNET,pendingURI:'https://other.example/pending.json'}),/PENDING_URI_INVALID/);
});

test('a lagging RPC: fixed consecutive nonces, the run completes and reads back clean',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),{signer,sent}=laggingDeployer(deployer);
  const start=await provider.getTransactionCount(await deployer.getAddress());
  const d=await deployMainnet({deployer:signer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:{pollMs:1,visibleTries:200,visibleReads:2,stepTimeoutMs:2000}});
  assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.steps.length,6);
  assert.deepEqual(sent.map(t=>t.nonce),[0,1,2,3,4,5].map(i=>start+i));
 }finally{await rpc.disconnect();}
});

test('a transaction that never lands is resent at the same nonce with a higher fee and a fresh acceptance',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),calls=[];let dropped=false;
  const signer=new Proxy(deployer,{get(t,k){
   if(k==='sendTransaction')return async tx=>{calls.push(tx);
    if(!dropped&&calls.length===3){dropped=true;return {hash:'0x'+'ab'.repeat(32)};}   // the third step: accepted by one node, then lost
    return t.sendTransaction(tx);};
   const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const d=await deployMainnet({deployer:signer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:{pollMs:1,stepTimeoutMs:5,visibleTries:40}});
  assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.steps.length,6);
  assert.equal(calls[2].nonce,calls[3].nonce);assert.ok(calls[3].maxFeePerGas>=calls[2].maxFeePerGas*125n/100n);
 }finally{await rpc.disconnect();}
});

test('a run that stops halfway resumes from the chain: same contract, nothing sent twice, other keys refused',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),key=testAuthority(1),commit=COMMIT();
  let saved=null,count=0;
  const failing=new Proxy(deployer,{get(t,k){
   if(k==='sendTransaction')return async tx=>{if(++count>=4)throw Object.assign(Error('rpc down'),{code:'SERVER_ERROR'});return t.sendTransaction(tx);};
   const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  await assert.rejects(deployMainnet({deployer:failing,revealSigner:key,revealCommit:commit,cfg,checkpoint:s=>{saved=JSON.parse(JSON.stringify(s));},timing:{pollMs:1,attempts:2,stepTimeoutMs:5,visibleTries:40}}),/rpc down/);
  assert.equal(saved.steps.length,3);assert.ok(await provider.getCode(saved.contract)!=='0x');
  const g=new ethers.Contract(saved.contract,artifacts[GENESIS].abi,provider);
  assert.equal(await g.paidPriceApproved(),false);
  await assert.rejects(deployMainnet({deployer,revealSigner:key,revealCommit:'0x'+'1'.repeat(64),cfg,resume:saved,timing:FAST}),/RESUME_OTHER_REVEAL_COMMIT/);
  await assert.rejects(deployMainnet({deployer,revealSigner:testAuthority(2),revealCommit:commit,cfg,resume:saved,timing:FAST}),/RESUME_OTHER_SIGNER/);
  await assert.rejects(deployMainnet({deployer:await provider.getSigner(3),revealSigner:key,revealCommit:commit,cfg,resume:saved,timing:FAST}),/RESUME_OTHER_DEPLOYER/);
  const before=await provider.getTransactionCount(await deployer.getAddress());
  const d=await deployMainnet({deployer,revealSigner:key,revealCommit:commit,cfg,resume:saved,timing:FAST});
  assert.equal(d.contract,saved.contract);assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.steps.length,6);
  assert.equal(await provider.getTransactionCount(await deployer.getAddress()),before+3);
  // once finished a second resume sends nothing
  const again=await deployMainnet({deployer,revealSigner:key,revealCommit:commit,cfg,resume:{...saved,steps:d.steps},timing:FAST});
  assert.deepEqual(again.readBackMismatch,[]);assert.equal(await provider.getTransactionCount(await deployer.getAddress()),before+3);
 }finally{await rpc.disconnect();}
});

test('a run stopped before the deploy landed resumes at the planned address; a used nonce stops it',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),key=testAuthority(1),commit=COMMIT(),owner=await deployer.getAddress();
  const nonce=await provider.getTransactionCount(owner),plan={deployer:owner,signer:key.address,revealCommit:commit,contract:ethers.getCreateAddress({from:owner,nonce}),planNonce:nonce,steps:[]};
  const d=await deployMainnet({deployer,revealSigner:key,revealCommit:commit,cfg,resume:plan,timing:FAST});
  assert.equal(d.contract,plan.contract);assert.deepEqual(d.readBackMismatch,[]);
  const n2=await provider.getTransactionCount(owner),lost={...plan,contract:ethers.getCreateAddress({from:owner,nonce:n2}),planNonce:n2};
  await (await deployer.sendTransaction({to:owner,value:0n,nonce:n2})).wait();
  await assert.rejects(deployMainnet({deployer,revealSigner:key,revealCommit:commit,cfg,resume:lost,timing:FAST}),/PLANNED_NONCE_USED/);
 }finally{await rpc.disconnect();}
});

// A step whose gas is cut runs out and is mined with status 0: what a reverted transaction really looks like.
const cutGas=(deployer,fn,times=Infinity)=>{const sel=ethers.id(fn).slice(0,10);let left=times;return new Proxy(deployer,{get(t,k){
 if(k==='sendTransaction')return tx=>t.sendTransaction(tx.data?.startsWith(sel)&&left-->0?{...tx,gasLimit:BigInt(ethers.getBytes(tx.data).length*16+21100)}:tx);
 const v=t[k];return typeof v==='function'?v.bind(t):v;}});};
test('a reverted step is never recorded as done, and the reveal commitment gets a fresh try',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer);let last;
  await assert.rejects(deployMainnet({deployer:cutGas(deployer,'approvePaidPrice()'),revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST,checkpoint:s=>{last=s;}}),/TX_FAILED approvePaidPrice/);
  assert.deepEqual(last.steps.map(x=>x.name),['deploy EmberEvoGenesis','setRevealURIs (not locked)','setRevealCommit','addPaymentToken(USDC, 1600 GOLD)']);
  const again=await deployMainnet({deployer:cutGas(deployer,'setRevealCommit(bytes32,uint256,bytes)',1),revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST});
  assert.deepEqual(again.readBackMismatch,[]);assert.equal(again.steps.length,6);
 }finally{await rpc.disconnect();}
});
test('read-backs the next steps depend on are compared: a wrong answer from the chain shows up',async()=>{
 const abi=new ethers.Interface(artifacts[GENESIS].abi);
 const cases=[['signerEpoch',()=>abi.encodeFunctionResult('signerEpoch',[2n]),'signerEpoch'],['startBlock',()=>abi.encodeFunctionResult('startBlock',[1n]),'startBlock'],
  ['eip712Domain',r=>{const v=[...abi.decodeFunctionResult('eip712Domain',r)];v[3]=5n;return abi.encodeFunctionResult('eip712Domain',v);},'domainChainId'],
  ['eip712Domain',r=>{const v=[...abi.decodeFunctionResult('eip712Domain',r)];v[4]=testAuthority(2).address;return abi.encodeFunctionResult('eip712Domain',v);},'domainContract'],
  ['paymentTokens',(r,tx,cfg)=>tx.data.toLowerCase().includes(cfg.usdc.slice(2).toLowerCase())?abi.encodeFunctionResult('paymentTokens',[abi.decodeFunctionResult('paymentTokens',r)[0]^(1n<<216n)]):r,'paymentTokens(USDC).usableAt']];
 for(const [fn,tamper,field] of cases){
  const {rpc,provider}=await chain(1);try{
   const deployer=await provider.getSigner(0),cfg=await standIns(deployer),sel=abi.getFunction(fn).selector;let done=false;
   const signer=new Proxy(deployer,{get(t,k){if(k==='call')return async tx=>{const r=await t.call(tx);return done&&tx.data.startsWith(sel)?tamper(r,tx,cfg):r;};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
   const d=await deployMainnet({deployer:signer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST,checkpoint:s=>{if(s.steps.length===6)done=true;}});
   assert.ok(d.readBackMismatch.includes(field),field+': '+d.readBackMismatch);
  }finally{await rpc.disconnect();}
 }
});
test('the paid signer reads the free-list root with the rest of its state, as the free signer does',()=>{
 assert.match(readFileSync(new URL('../../signer/paid-approval.mjs',import.meta.url),'utf8'),/Promise\.all\(\[\s*c\.appearanceSigner\(\)[^\]]*c\.snapshotRoot\(\)/);
});
test('the Worker gives the paid signer the bundled list root',()=>{
 assert.match(readFileSync(new URL('../../signer/worker-entry.mjs',import.meta.url),'utf8'),/new PaidApprovalSigner\(\{[^}]*snapshotRoot:tree\.root/);
});

test('a real read-back mismatch is reported',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg={...await standIns(deployer),name:'Another Name'};
  const d=await deployMainnet({deployer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST});
  assert.deepEqual(d.readBackMismatch,['name']);
 }finally{await rpc.disconnect();}
});

test('errors never carry the RPC URL: mainnet entry point against an RPC answering 401',async()=>{
 const {createServer}=await import('node:http'),{spawn}=await import('node:child_process'),{mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const server=createServer((q,r)=>{r.writeHead(401,{'content-type':'application/json'});r.end('{"error":"Must be authenticated!"}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/v2/SECRETKEY123`,dir=mkdtempSync(join(tmpdir(),'deploy-mainnet-test-'));
 try{
  const keyFile=join(dir,'signer.key');writeFileSync(keyFile,testAuthority(1).privateKey);
  const out=await new Promise((done,fail)=>{
   const p=spawn(process.execPath,[...process.execArgv.filter(a=>!a.startsWith('--test')),fileURLToPath(new URL('../tools/deploy-mainnet.mjs',import.meta.url))],
    {env:{...process.env,RPC_URL:url,DEPLOYER_ADDRESS:testAuthority(2).address,SIGNER_ADDRESS:testAuthority(1).address,PREFLIGHT_ONLY:'1',DEPLOYMENTS_DIR:dir}});
   let text='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>text+=b);
   const timer=setTimeout(()=>{p.kill();fail(Error('tool did not stop: '+text.slice(0,300)));},30000);
   p.on('close',code=>{clearTimeout(timer);done({code,text});});
  });
  assert.equal(out.code,1);assert.ok(!out.text.includes('SECRETKEY123'),out.text);assert.ok(!out.text.includes(url),out.text);assert.match(out.text,/SERVER_ERROR|401/);
 }finally{server.close();rmSync(dir,{recursive:true,force:true});}
 assert.equal(redact('see https://eth-mainnet.g.alchemy.com/v2/abc?x=1 now'),'see <URL> now');
 const s=failureSummary(Object.assign(Error('server response 401 (info={ "requestUrl": "https://x.example/v2/KEY" })'),{code:'SERVER_ERROR',info:{requestUrl:'https://x.example/v2/KEY',responseStatus:'401 Unauthorized'}}));
 assert.ok(!JSON.stringify(s).includes('KEY'));assert.equal(s.status,'401 Unauthorized');
});

test('opening time: unix typos and far dates are refused; the once-only batch names its date',()=>{
 const d={chainId:1,contract:testAuthority(5).address,safe:testAuthority(4).address,maxSupply:'1688',pendingURI:MAINNET.pendingURI,metadataBase:MAINNET.metadataBase};
 const wallets=[testAuthority(6).address],t=1_790_000_000;
 assert.throws(()=>unix('17630000000'),/unix time or an ISO date/);assert.throws(()=>unix('176300000'),/unix time or an ISO date/);assert.equal(unix('1763000000'),1763000000);
 assert.equal(unix('2026-11-20T20:00:00+08:00'),Date.UTC(2026,10,20,12)/1000);
 assert.throws(()=>openBatch(d,wallets,t-60,t+61*86400,t),/60 days/);
 assert.throws(()=>openBatch(d,wallets,t-61*86400,t+7*3600,t),/60 days/);
 assert.equal(openBatch(d,wallets,t-60,t+61*86400,t,{farOpening:true}).file.transactions.length,3);
 assert.equal(openBatch(d,wallets,t-60,t+7*3600,t,{lockUris:false}).file.transactions.length,2);
 assert.ok(openBatch(d,wallets,t-60,t+7*3600,t).file.meta.description.includes('Opening '+new Date((t+7*3600)*1000).toISOString()));
 assert.throws(()=>openBatch(d,[ethers.ZeroAddress],t-60,t+7*3600,t),/WALLET_INVALID/);
 assert.throws(()=>openBatch(d,['0x12'],t-60,t+7*3600,t),/WALLET_INVALID/);
 // a year the ISO parser takes but the contract cannot hold (Swarm audit 358f7f40 finding 4)
 assert.throws(()=>unix('+040000-01-01T00:00:00Z'),/bad date/);assert.equal(unix('2286-11-20T17:46:39Z'),9999999999);
 assert.throws(()=>openBatch(d,wallets,t-60,1200110860800,t,{farOpening:true}),/does not fit uint40/);
});

test('Safe files: decoded calls, the Transaction Builder checksum, and the calldata the contract expects',()=>{
 const d={chainId:1,contract:testAuthority(5).address,safe:testAuthority(4).address,maxSupply:'1688',pendingURI:MAINNET.pendingURI,metadataBase:MAINNET.metadataBase};
 const t=1_790_000_000,wallets=[testAuthority(6).address],o=openBatch(d,wallets,t-60,t+7*3600,t),I=new ethers.Interface(artifacts[GENESIS].abi);
 // apps/tx-builder/src/lib/checksum.ts, as validateChecksum runs it on the parsed file
 const ser=j=>{if(Array.isArray(j))return `[${j.map(ser).join(',')}]`;if(typeof j==='object'&&j!==null){let a='';const k=Object.keys(j).sort();a+=`{${JSON.stringify(k)}`;for(const x of k)a+=`${ser(j[x])},`;return a+'}';}return JSON.stringify(j);};
 const validate=file=>{const f=JSON.parse(JSON.stringify(file)),c=f.meta.checksum;delete f.meta.checksum;return ethers.keccak256(ethers.toUtf8Bytes(ser({...f,meta:{...f.meta,name:null}})))===c;};
 for(const file of [o.file,acceptBatch(d)]){
  assert.equal(validate(file),true);assert.match(file.meta.checksum,/^0x[0-9a-f]{64}$/);
  for(const tx of file.transactions){assert.equal(tx.data,null);assert.equal(tx.contractMethod.payable,false);assert.ok(I.getFunction(calldataOf(tx).slice(0,10)),'selector exists in the ABI');}
  const {checksum,...meta}=file.meta;assert.equal(batchChecksum({...file,meta}),checksum);
 }
 const tampered=JSON.parse(JSON.stringify(o.file));tampered.transactions[1].contractInputsValues.start='9999999999';assert.equal(validate(tampered),false);
 const [uris,snap,open]=o.file.transactions.map(calldataOf);
 assert.deepEqual([...I.decodeFunctionData('setRevealURIs',uris)],[MAINNET.pendingURI,MAINNET.metadataBase,true]);
 assert.deepEqual([...I.decodeFunctionData('configureSnapshot',snap)].slice(1).map(String),['1',String(t-60),String(t+7*3600)]);
 assert.equal(I.decodeFunctionData('setMintPaused',open)[0],false);
});

test('the Safe files are refused when the chain no longer matches the record',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),other=testAuthority(7).address;
  const d=await deployMainnet({deployer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST});
  const g=new ethers.Contract(d.contract,artifacts[GENESIS].abi,deployer),safe=new ethers.Wallet(testAuthority(4).privateKey,provider),state=()=>chainState(provider,d);
  checkAccept(await state(),d);
  assert.throws(()=>checkOpen(await0(d),d),/NOT_OWNER/);
  // the deployer key re-targets the hand-over: accept is refused, nobody signs a batch that would revert
  await (await g.transferOwnership(other)).wait();
  assert.throws(()=>checkAccept({owner:d.owner,pendingOwner:other},d),/NOT_PENDING_SAFE/);
  await assert.rejects(async()=>checkAccept(await state(),d),/NOT_PENDING_SAFE/);
  await (await g.transferOwnership(d.safe)).wait();
  await (await safe.sendTransaction({to:d.contract,data:calldataOf(acceptBatch(d).transactions[0])})).wait();
  const s=await state();assert.equal(s.owner,d.safe);assert.equal(checkOpen(s,d),true);assert.throws(()=>checkAccept(s,d),/ALREADY_ACCEPTED/);
  assert.equal(checkOpen({...s,revealURIsLocked:true},d),false);
  assert.throws(()=>checkOpen({...s,snapshotConfigured:true},d),/SNAPSHOT_ALREADY_SET/);
  assert.throws(()=>checkOpen({...s,mintPaused:false},d),/ALREADY_OPEN/);
  assert.throws(()=>checkOpen({...s,revealBaseURI:'https://x.example/'},d),/URIS_CHANGED/);
  assert.doesNotThrow(()=>checkRecord(s,d));
  for(const [k,v] of [['revealCommit','0x'+'2'.repeat(64)],['signer',other],['pendingSigner',other],['maxSupply','1000'],['skinCaps','1,1,1,1,1,1'],['extraTokens','2'],['paidPriceApproved',false],['tokenURIsLocked',true],['supplyLocked',true]])
   assert.throws(()=>checkOpen({...s,[k]:v},d),new RegExp('CHAIN_DIFFERS_FROM_RECORD '+k));
  // a listed contract is warned about; a plain wallet and an EIP-7702 wallet are not
  assert.deepEqual(await contractWallets(provider,[other,cfg.usdc]),[cfg.usdc]);
  assert.deepEqual(await contractWallets({getCode:async()=>'0xef0100'+'11'.repeat(20)},[other]),[]);
  const safeOwned={...s,owner:d.owner,pendingOwner:d.safe};
  for(const change of [{snapshotConfigured:true},{mintPaused:false},{pendingURI:'x'},{revealBaseURI:'x'}])assert.throws(()=>checkAccept({...safeOwned,...change},d),/CHAIN_DIFFERS_FROM_RECORD/);
  assert.equal(s.tokenURIsLocked,false);assert.equal(s.supplyLocked,false);assert.equal(s.extraTokens,'1');
  // an RPC that refuses the log range: nothing is written unless the owner says the count was made elsewhere (Swarm audit 358f7f40 finding 5)
  provider.getLogs=async()=>{throw Error('range refused');};
  const unread=await state();assert.equal(unread.extraTokens,null);
  assert.throws(()=>checkRecord(unread,d),/LOGS_UNAVAILABLE/);assert.throws(()=>checkOpen(unread,d),/LOGS_UNAVAILABLE/);
  assert.doesNotThrow(()=>checkRecord(unread,d,{logsChecked:true}));assert.equal(checkOpen(unread,d,{logsChecked:true}),true);
 }finally{await rpc.disconnect();}
});
test('Safe file checks: one stale read cannot pass a check, and one pass reads one block',async()=>{
 const ms={passMs:0,refusedMs:0},seq=list=>{let i=0;return async()=>list[Math.min(i++,list.length-1)];},check=x=>{if(x==='refuse')throw Error('REFUSED');return x;};
 assert.equal(await holds(seq(['ok','ok','ok']),check,ms),'ok');
 assert.equal(await holds(seq(['refuse','ok','ok','ok']),check,ms),'ok');               // a refusal may be a lagging node
 await assert.rejects(holds(seq(['refuse','ok','refuse','ok','refuse','ok','refuse','ok','refuse','ok']),check,ms),/REFUSED|STATE_NOT_STABLE/);   // the audit's case
 await assert.rejects(holds(seq(['a','b','a','b','a','b','a','b','a','b']),check,ms),/STATE_NOT_STABLE/);
 let reads=0;await assert.rejects(holds(async()=>{reads++;return 1;},()=>{throw Error('LOGS_UNAVAILABLE x');},ms),/LOGS_UNAVAILABLE/);assert.equal(reads,1);
 let answers=[5,5];
 await assert.rejects(stableHead({getBlockNumber:async()=>answers.shift()??5},6,{tries:2,ms:0}),/HEAD_BEHIND_RECORD/);
 answers=[7,8,8,8];assert.equal(await stableHead({getBlockNumber:async()=>answers.shift()},0,{ms:0}),8);
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer);
  const d=await deployMainnet({deployer,revealSigner:testAuthority(1),revealCommit:COMMIT(),cfg,timing:FAST});
  assert.equal(recordBlock(d),d.steps.at(-1).blockNumber);
  const head=await provider.getBlockNumber(),g=new ethers.Contract(d.contract,artifacts[GENESIS].abi,deployer);
  await (await g.lockTokenURIs()).wait();
  assert.equal((await chainState(provider,d,head)).tokenURIsLocked,false);               // every read of the pass is at the block asked for
  const s=await chainState(provider,d);assert.equal(s.tokenURIsLocked,true);assert.throws(()=>checkAccept(s,d),/CHAIN_DIFFERS_FROM_RECORD tokenURIsLocked/);
 }finally{await rpc.disconnect();}
});
const await0=d=>({owner:d.owner,pendingOwner:d.safe,snapshotConfigured:false,mintPaused:true,pendingURI:d.pendingURI,revealBaseURI:d.metadataBase});

test('the opening refuses a free list the Worker does not bundle, and a metadata host that does not answer',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'safe-batch-test-'));try{
  const a=testAuthority(6).address,b=testAuthority(7).address,tree=snapshotTree([a,b]),f=join(dir,'list.json');
  writeFileSync(f,JSON.stringify([b.toLowerCase(),a.toLowerCase()]));assert.doesNotThrow(()=>checkWorkerList(tree,f));
  writeFileSync(f,JSON.stringify([a]));assert.throws(()=>checkWorkerList(tree,f),/WORKER_LIST_DIFFERS/);
 }finally{rmSync(dir,{recursive:true,force:true});}
 const uri=MAINNET.pendingURI;
 await assert.doesNotReject(checkPendingServed(uri,async()=>({ok:true,json:async()=>({name:'x'})})));
 await assert.rejects(checkPendingServed(uri,async()=>({ok:false,status:404})),/NOT_SERVED/);
 await assert.rejects(checkPendingServed(uri,async()=>{throw Error('down');}),/NOT_SERVED/);
 await assert.rejects(checkPendingServed(uri,async()=>({ok:true,json:async()=>{throw Error('html');}})),/NOT_JSON/);
 // the derived URI too: a look the host should serve, before the base locks for good
 let asked;await assert.doesNotReject(checkSampleServed('https://h.example/meta/','0xabc/1',async u=>{asked=u;return {ok:true,json:async()=>({})};}));assert.equal(asked,'https://h.example/meta/0xabc/1');
 for(const bad of [undefined,'','0xabc','0xabc/1?x=1','/1'])await assert.rejects(checkSampleServed('https://h.example/meta/',bad,async()=>({ok:true,json:async()=>({})})),/SAMPLE_LOOK_REQUIRED/);
 await assert.rejects(checkSampleServed('https://h.example/meta/','0xabc/1',async()=>({ok:false,status:404})),/SAMPLE_LOOK_NOT_SERVED/);
 await assert.rejects(checkSampleServed('https://h.example/meta/','0xabc/1',async()=>({ok:true,json:async()=>{throw Error('html');}})),/SAMPLE_LOOK_NOT_JSON/);
});

test('neither a stopped nor a finished run can deploy a second contract',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'deploy-guard-test-'));try{
  assert.equal(runGuard(join(dir,'missing'),false),null);
  writeFileSync(join(dir,'dryrun-1-5.json'),'{}');writeFileSync(join(dir,'11155111-5.json'),'{}');assert.equal(runGuard(dir,false),null);   // dry runs and Sepolia do not count
  assert.throws(()=>runGuard(dir,true),/RESUME needs exactly one/);
  writeFileSync(join(dir,'1-7.json'),'{}');assert.throws(()=>runGuard(dir,false),/FINISHED_RUN 1-7\.json/);
  writeFileSync(join(dir,'partial-1-8.json'),'{}');assert.throws(()=>runGuard(dir,false),/UNFINISHED_RUN partial-1-8\.json/);
  assert.equal(runGuard(dir,true),join(dir,'partial-1-8.json'));   // a mismatch leaves both: it can be read back again
  writeFileSync(join(dir,'partial-1-9.json'),'{}');assert.throws(()=>runGuard(dir,true),/exactly one/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('every read reaches the RPC: no answer from the provider cache',async()=>{
 const {createServer}=await import('node:http');let counted=0;
 const server=createServer((q,r)=>{let b='';q.on('data',x=>b+=x);q.on('end',()=>{
  const one=m=>{if(m.method==='eth_getTransactionCount')counted++;return {jsonrpc:'2.0',id:m.id,result:m.method==='eth_chainId'?'0x1':'0x5'};};
  const j=JSON.parse(b);r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(Array.isArray(j)?j.map(one):one(j)));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const p=mainnetProvider(`http://127.0.0.1:${server.address().port}/`);
 try{
  const a=testAuthority(1).address;
  assert.equal(await p.getTransactionCount(a,'latest'),5);assert.equal(await p.getTransactionCount(a,'latest'),5);
  assert.equal(counted,2);
 }finally{p.destroy();server.close();}
});

test('a resume funds only what is left',()=>{
 assert.equal(gasToFund(null),45_000_000n);
 assert.equal(gasToFund({steps:[]}),45_000_000n);
 assert.equal(gasToFund({steps:[{name:'deploy EmberEvoGenesis'}]}),10_000_000n);
 assert.equal(gasToFund({steps:[]},true),10_000_000n);   // the record lost the step, the chain shows the code
});

test('a resume outbids the transaction a stopped run left waiting, and survives a lagging RPC',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),key=testAuthority(1),commit=COMMIT();
  let saved=null,count=0;const fake='0x'+'cd'.repeat(32);
  const stuck=new Proxy(deployer,{get(t,k){
   if(k==='sendTransaction')return async tx=>{if(++count>=3)return {hash:fake};return t.sendTransaction(tx);};   // from the third step on nothing lands
   const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  await assert.rejects(deployMainnet({deployer:stuck,revealSigner:key,revealCommit:commit,cfg,checkpoint:s=>{saved=JSON.parse(JSON.stringify(s));},timing:{pollMs:1,attempts:2,stepTimeoutMs:3,visibleTries:40}}),/STEP_STUCK setRevealCommit/);
  assert.equal(saved.steps.length,2);assert.equal(saved.pending.name,'setRevealCommit');assert.ok(saved.pending.fee.maxFeePerGas);assert.equal(saved.pending.hashes[0],fake);
  const {signer,sent}=laggingDeployer(deployer);
  const d=await deployMainnet({deployer:signer,revealSigner:key,revealCommit:commit,cfg,resume:saved,timing:{pollMs:1,visibleTries:200,visibleReads:2,stepTimeoutMs:2000}});
  assert.equal(d.contract,saved.contract);assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.steps.length,6);
  assert.ok(sent[0].maxFeePerGas>=BigInt(saved.pending.fee.maxFeePerGas)*125n/100n);assert.equal(sent[0].nonce,saved.pending.nonce);
 }finally{await rpc.disconnect();}
});

test('an RPC error while resuming is not "no code": the mined deploy is not taken for missing',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),cfg=await standIns(deployer),key=testAuthority(1),commit=COMMIT();
  let saved=null,count=0;
  const failing=new Proxy(deployer,{get(t,k){
   if(k==='sendTransaction')return async tx=>{if(++count>=2)throw Object.assign(Error('rpc down'),{code:'SERVER_ERROR'});return t.sendTransaction(tx);};
   const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  await assert.rejects(deployMainnet({deployer:failing,revealSigner:key,revealCommit:commit,cfg,checkpoint:s=>{saved=JSON.parse(JSON.stringify(s));},timing:{pollMs:1,attempts:1,stepTimeoutMs:3,visibleTries:40}}),/rpc down/);
  let errors=3;
  const flaky=new Proxy(deployer.provider,{get(t,k){if(k==='getCode')return async a=>{if(errors-->0)throw Error('429');return t.getCode(a);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const signer=new Proxy(deployer,{get(t,k){if(k==='provider')return flaky;const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const d=await deployMainnet({deployer:signer,revealSigner:key,revealCommit:commit,cfg,resume:saved,timing:FAST});
  assert.equal(d.contract,saved.contract);assert.deepEqual(d.readBackMismatch,[]);
 }finally{await rpc.disconnect();}
});
