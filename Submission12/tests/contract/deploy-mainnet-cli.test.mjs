// The mainnet tools as the owner runs them: separate processes, a real private key and JSON-RPC over HTTP through a load-balanced
// RPC that lags. A local chain with chainId 1 stands behind it, with the token code at the mainnet addresses; the few mainnet
// answers a fixture cannot give (symbols, the Safe's owners) come from the RPC stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ethers,createTestProvider,testAuthority} from '../tools/runtime.mjs';
import {GENESIS} from '../tools/deploy-testnet.mjs';
import {MAINNET,mainnetGoldBookEntry,mainnetProvider,deployMainnet} from '../tools/deploy-mainnet.mjs';
import {calldataOf} from '../tools/safe-batch.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const tool=name=>fileURLToPath(new URL('../tools/'+name,import.meta.url));
const RPC_SECRET='v2/SECRETKEY123',coder=ethers.AbiCoder.defaultAbiCoder();
const lower=a=>a.toLowerCase();
const SELECTOR=fn=>ethers.id(fn).slice(0,10);

function answers(){
 const t={[lower(MAINNET.imdUSD)]:'imdUSD',[lower(MAINNET.usdc)]:'USDC'},safe=lower(MAINNET.safe);
 return m=>{
  if(m.method!=='eth_call')return undefined;
  const {to,data}=m.params[0],sel=data?.slice(0,10),a=lower(to??'');
  if(t[a]&&sel===SELECTOR('symbol()'))return coder.encode(['string'],[t[a]]);
  if(a===safe&&sel===SELECTOR('getOwners()'))return coder.encode(['address[]'],[MAINNET.safeOwners]);
  if(a===safe&&sel===SELECTOR('getThreshold()'))return coder.encode(['uint256'],[MAINNET.safeThreshold]);
  if(a===safe&&sel===SELECTOR('VERSION()'))return coder.encode(['string'],['1.5.0']);
  return undefined;
 };
}
// A node behind the others: no new block, no receipt, no contract code yet, and calls and estimates against the state one block
// back (a well-formed old answer; a block it has not seen is an error). Seeded, so a failure repeats.
function lagger(rpc,share){
 let seed=11;const lag=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff<share;};
 const known=new Set(Object.values(MAINNET).filter(v=>typeof v==='string').map(lower));
 const isNew=a=>!known.has(lower(a??''));
 const older=async(m,by)=>{const n=BigInt(await rpc.request({method:m.method,params:m.params}));return ethers.toQuantity(n>by?n-by:0n);};
 return async m=>{
  if(!lag())return undefined;
  if(m.method==='eth_getTransactionReceipt')return null;
  if(m.method==='eth_getBlockByNumber'&&/^0x/.test(m.params[0]))return null;
  if(m.method==='eth_blockNumber')return older(m,2n);
  if(m.method==='eth_getTransactionCount')return older(m,1n);
  if(m.method==='eth_getCode'&&isNew(m.params[0]))return '0x';
  if((m.method==='eth_call'||m.method==='eth_estimateGas')&&isNew(m.params[0].to??'')&&m.params[0].to){
   const head=BigInt(await rpc.request({method:'eth_blockNumber',params:[]})),tag=m.params[1]??'latest';
   if(/^0x/.test(tag)&&BigInt(tag)>=head)throw Error('header not found');
   return rpc.request({method:m.method,params:[m.params[0],ethers.toQuantity(head-1n)]});
  }
  return undefined;
 };
}
async function rpcServer(rpc,{lag=0}={}){
 const fixed=answers(),behind=lagger(rpc,lag),state={rawSends:0,onRawSend:null,requests:0,script:null,sent:[]};
 const one=async m=>{
  state.requests++;
  const f=fixed(m);if(f!==undefined)return {jsonrpc:'2.0',id:m.id,result:f};
  const s=await state.script?.(m);if(s!==undefined)return {jsonrpc:'2.0',id:m.id,result:s};
  try{
   const b=lag?await behind(m):undefined;if(b!==undefined)return {jsonrpc:'2.0',id:m.id,result:b};
   const result=await rpc.request({method:m.method,params:m.params??[]});
   if(m.method==='eth_sendRawTransaction'){state.rawSends++;state.sent.push(ethers.Transaction.from(m.params[0]));await state.onRawSend?.(state.rawSends);}
   return {jsonrpc:'2.0',id:m.id,result};
  }catch(e){return {jsonrpc:'2.0',id:m.id,error:{code:-32000,message:String(e.message)}};}
 };
 const server=createServer((q,r)=>{let b='';q.on('data',x=>b+=x);q.on('end',async()=>{
  if(!q.url.endsWith(RPC_SECRET)){r.writeHead(401);r.end('{}');return;}
  const j=JSON.parse(b),out=Array.isArray(j)?await Promise.all(j.map(one)):await one(j);
  r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(out));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {state,url:`http://127.0.0.1:${server.address().port}/${RPC_SECRET}`,close:()=>{server.closeAllConnections();server.close();}};
}
function run(file,args,env,{input,onSpawn}={}){
 return new Promise((done,fail)=>{
  const p=spawn(process.execPath,[...process.execArgv.filter(a=>!a.startsWith('--test')),...(env.EXTRA_IMPORT?['--import',env.EXTRA_IMPORT]:[]),file,...args],{env:{...process.env,...env}});
  let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);
  if(input!==undefined){p.stdin.write(input);p.stdin.end();}
  onSpawn?.(p);
  const timer=setTimeout(()=>{p.kill();fail(Error('tool did not stop: '+out.slice(-800)));},280000);
  p.on('close',(code,signal)=>{clearTimeout(timer);done({code,signal,out});});
 });
}
async function standInChain(){
 const rpc=await createTestProvider(1),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1}),funder=await provider.getSigner(0);
 const deployFixture=async(k,...a)=>{const c=await new ethers.ContractFactory(artifacts[k].abi,artifacts[k].bytecode,funder).deploy(await funder.getAddress(),...a);await c.waitForDeployment();return provider.getCode(await c.getAddress());};
 await rpc.request({method:'hardhat_setCode',params:[MAINNET.imdUSD,await deployFixture('contracts/test/Fixtures.sol:FixtureToken')]});
 await rpc.request({method:'hardhat_setCode',params:[MAINNET.usdc,await deployFixture('contracts/test/Fixtures.sol:DecimalsToken',6)]});
 return {rpc,provider};
}
async function asSafe(rpc,file){
 await rpc.request({method:'hardhat_impersonateAccount',params:[MAINNET.safe]});
 await rpc.request({method:'hardhat_setBalance',params:[MAINNET.safe,'0x56BC75E2D63100000']});
 for(const t of file.transactions)await rpc.request({method:'eth_sendTransaction',params:[{from:MAINNET.safe,to:t.to,data:calldataOf(t)}]});
}
const secretFree=(text,keys)=>{for(const k of keys)assert.ok(!text.includes(k),'a secret reached the output or a file');};

test('the whole run through a lagging RPC: killed mid-run, resumed, refused a second deployment, then the Safe files open minting',{timeout:900000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mainnet-cli-'));
 const {rpc,provider}=await standInChain(),srv=await rpcServer(rpc,{lag:0.12});
 const deployerKey=testAuthority(3),signerKey=testAuthority(1),keyFile=join(dir,'signer.key');
 writeFileSync(keyFile,signerKey.privateKey);
 const revealCommit=ethers.id('cli test reveal commit');
 const env={RPC_URL:srv.url,DEPLOYER_PRIVATE_KEY:deployerKey.privateKey,SIGNER_KEY_FILE:keyFile,REVEAL_COMMIT:revealCommit,DEPLOYMENTS_DIR:dir};
 const secrets=[RPC_SECRET,deployerKey.privateKey,deployerKey.privateKey.slice(2),signerKey.privateKey.slice(2)];
 try{
  const noKey=await run(tool('deploy-mainnet.mjs'),[],{...env,PREFLIGHT_ONLY:'1',DEPLOYER_PRIVATE_KEY:'',SIGNER_KEY_FILE:'',DEPLOYER_ADDRESS:''});
  assert.equal(noKey.code,1);assert.match(noKey.out,/missing env DEPLOYER_ADDRESS/);
  // the check that sends nothing runs on addresses alone (Swarm audit 358f7f40 finding 7)
  const pre=await run(tool('deploy-mainnet.mjs'),[],{...env,PREFLIGHT_ONLY:'1',DEPLOYER_PRIVATE_KEY:'',SIGNER_KEY_FILE:'',DEPLOYER_ADDRESS:deployerKey.address,SIGNER_ADDRESS:signerKey.address});
  assert.equal(pre.code,0,pre.out);assert.equal(srv.state.rawSends,0);assert.match(pre.out,/"deployerNonce": 0/);secretFree(pre.out,secrets);

  // killed right after the fourth transaction went out: the tool never saw its receipt
  let child;srv.state.onRawSend=n=>{if(n===4)child.kill();};
  const killed=await run(tool('deploy-mainnet.mjs'),[],env,{onSpawn:p=>{child=p;}});
  srv.state.onRawSend=null;
  assert.notEqual(killed.code,0);assert.equal(srv.state.rawSends,4);
  let names=readdirSync(dir).filter(n=>/^partial-1-\d+\.json$/.test(n));assert.equal(names.length,1);
  const partial=JSON.parse(readFileSync(join(dir,names[0]),'utf8'));
  secretFree(killed.out+JSON.stringify(partial),secrets);
  assert.equal(await provider.getCode(partial.contract)!=='0x',true);

  // a fresh run is refused before anything is sent, also when only checking
  const again=await run(tool('deploy-mainnet.mjs'),[],env);
  assert.equal(again.code,1);assert.match(again.out,/UNFINISHED_RUN/);assert.equal(srv.state.rawSends,4);secretFree(again.out,secrets);

  const resumed=await run(tool('deploy-mainnet.mjs'),['--resume'],env);
  assert.equal(resumed.code,0,resumed.out);assert.equal(srv.state.rawSends,6,'only the two missing transactions were sent');secretFree(resumed.out,secrets);
  assert.equal(await provider.getTransactionCount(deployerKey.address),6);
  names=readdirSync(dir);assert.deepEqual(names.filter(n=>n.startsWith('partial-')),[]);
  const recordName=names.find(n=>/^1-\d+\.json$/.test(n)),recordFile=join(dir,recordName),d=JSON.parse(readFileSync(recordFile,'utf8'));
  assert.equal(d.contract,partial.contract);assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.owner,deployerKey.address);assert.equal(d.pendingOwner,MAINNET.safe);
  assert.equal(d.revealURIsLocked,false);assert.equal(d.runtimeBytes,MAINNET.reviewed.runtimeBytes);assert.equal(d.reviewedBuild.runtimeSha256,MAINNET.reviewed.runtimeSha256);
  assert.deepEqual(d.followUp.goldBookRegistry,mainnetGoldBookEntry(d));
  secretFree(readFileSync(recordFile,'utf8'),secrets);

  const twice=await run(tool('deploy-mainnet.mjs'),[],env);
  assert.equal(twice.code,1);assert.match(twice.out,/FINISHED_RUN/);assert.equal(srv.state.rawSends,6);secretFree(twice.out,secrets);

  // the local records lost: the chain still shows this wallet has deployed, so a fresh run is refused before anything is sent
  const lostDir=mkdtempSync(join(tmpdir(),'mainnet-cli-lost-'));
  const lost=await run(tool('deploy-mainnet.mjs'),[],{...env,DEPLOYMENTS_DIR:lostDir});
  rmSync(lostDir,{recursive:true,force:true});
  assert.equal(lost.code,1);assert.match(lost.out,/DEPLOYER_NOT_FRESH/);assert.equal(srv.state.rawSends,6);secretFree(lost.out,secrets);

  // the Safe files, reading the chain through READ_RPC_URL
  const read={READ_RPC_URL:srv.url},noEnv={RPC_URL:'',DEPLOYER_PRIVATE_KEY:'',SIGNER_KEY_FILE:'',REVEAL_COMMIT:''};
  const status=await run(tool('safe-batch.mjs'),['status',recordFile],{...noEnv,...read});
  assert.equal(status.code,0,status.out);assert.match(status.out,/"ownerIsSafe": false/);secretFree(status.out,secrets);
  const badRecord=join(dir,'bad-record.json');writeFileSync(badRecord,JSON.stringify({...d,readBackMismatch:['recipient']}));
  const refused=await run(tool('safe-batch.mjs'),['accept',badRecord],{...noEnv,...read});
  assert.equal(refused.code,1);assert.match(refused.out,/RECORD_HAS_MISMATCH/);rmSync(badRecord);
  const acc=await run(tool('safe-batch.mjs'),['accept',recordFile],{...noEnv,...read});
  assert.equal(acc.code,0,acc.out);
  const accept=JSON.parse(readFileSync(recordFile.replace(/\.json$/,'.safe-accept.json'),'utf8'));
  assert.equal(accept.transactions[0].contractMethod.name,'acceptOwnership');
  const taken=String((await provider.getBlock('latest')).timestamp-60),start=String((await provider.getBlock('latest')).timestamp+7*3600);
  const list=JSON.parse(readFileSync(new URL('../../signer/snapshot-wallets.json',import.meta.url),'utf8'));
  const listFile=join(dir,'wallets.json');writeFileSync(listFile,JSON.stringify(list));
  const early=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start],{...noEnv,...read});
  assert.equal(early.code,1);assert.match(early.out,/NOT_OWNER/);
  await asSafe(rpc,accept);
  const after=await run(tool('safe-batch.mjs'),['status',recordFile],{...noEnv,...read});
  assert.match(after.out,/"ownerIsSafe": true/);

  const fetchStub=join(dir,'fetch-stub.mjs');
  writeFileSync(fetchStub,"const real=globalThis.fetch;globalThis.fetch=(u,o)=>String(u?.url??u).includes('genesis.imdember.com')?Promise.resolve({ok:true,status:200,json:async()=>({name:'pending'})}):real(u,o);\n");
  const hooked={...noEnv,...read,EXTRA_IMPORT:'file:///'+fetchStub.replaceAll('\\','/')};
  const otherList=join(dir,'other.json');writeFileSync(otherList,JSON.stringify([testAuthority(2).address]));
  const wrongList=await run(tool('safe-batch.mjs'),['open',recordFile,otherList,taken,start],hooked);
  assert.equal(wrongList.code,1);assert.match(wrongList.out,/WORKER_LIST_DIFFERS/);
  const openFile=recordFile.replace(/\.json$/,'.safe-open.json');
  const typo=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start+'0'],hooked);
  assert.equal(typo.code,1);assert.match(typo.out,/unix time or an ISO date/);assert.equal(existsSync(openFile),false);
  const noSample=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start],hooked);
  assert.equal(noSample.code,1);assert.match(noSample.out,/SAMPLE_LOOK_REQUIRED/);assert.equal(existsSync(openFile),false);
  const sample='--sample-look=0xabc/1',iso=new Date(Number(start)*1000).toISOString().slice(0,16);
  for(const wrong of ['2099-01-01T00:00 2',iso,iso+' 3']){
   const r=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start,sample],hooked,{input:wrong+'\n'});
   assert.equal(r.code,1);assert.match(r.out,/do not match/);assert.equal(existsSync(openFile),false);
  }
  const opened=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start,sample],hooked,{input:iso+' 2\n'});
  assert.equal(opened.code,0,opened.out);secretFree(opened.out,secrets);
  const batch=JSON.parse(readFileSync(openFile,'utf8'));
  assert.deepEqual(batch.transactions.map(t=>t.contractMethod.name),['setRevealURIs','configureSnapshot','setMintPaused']);
  await asSafe(rpc,batch);
  const g=new ethers.Contract(d.contract,artifacts[GENESIS].abi,provider);
  assert.equal(await g.owner(),MAINNET.safe);assert.equal(await g.mintPaused(),false);assert.equal(await g.revealURIsLocked(),true);assert.equal(await g.snapshotConfigured(),true);
  assert.equal(await g.freeStartAt(),BigInt(start));
  assert.deepEqual(JSON.parse(readFileSync(recordFile.replace(/\.json$/,`.snapshot-wallets-${(await g.snapshotRoot()).slice(2,10)}.json`),'utf8')),list.map(w=>w.toLowerCase()).sort());
  const noRe=await run(tool('safe-batch.mjs'),['open',recordFile,listFile,taken,start],hooked);
  assert.equal(noRe.code,1);assert.match(noRe.out,/SNAPSHOT_ALREADY_SET/);
  for(const n of readdirSync(dir))if(!n.endsWith('.key'))secretFree(readFileSync(join(dir,n),'utf8'),secrets);
 }finally{srv.close();await rpc.disconnect();rmSync(dir,{recursive:true,force:true});}
});

// Swarm audit 358f7f40: a resume through an RPC answering with well-formed old values, over real JSON-RPC, so ethers maps the node's own errors.
const USDC_GOLD='addPaymentToken(USDC, 1600 GOLD)',GATE=ethers.id('paymentTokens(address)').slice(0,10);
const COUNT='eth_getTransactionCount';
const FAST_HTTP={pollMs:5,visibleTries:60,visibleReads:3,stepTimeoutMs:60,attempts:8};
async function stoppedRun(rpc,srv,{stopBefore,mined}){
 const provider=mainnetProvider(srv.url),key=testAuthority(3),deployer=new ethers.Wallet(key.privateKey,provider);
 const input={deployer,revealSigner:testAuthority(1),revealCommit:ethers.id('stale test reveal commit'),cfg:MAINNET,timing:FAST_HTTP};
 let saved=null;
 const sendsBefore=srv.state.rawSends;
 const realSend=deployer.sendTransaction.bind(deployer);let count=0;
 deployer.sendTransaction=async tx=>{
  if(++count===stopBefore&&!mined)await rpc.request({method:'evm_setAutomine',params:[false]});
  if(count>stopBefore)throw Object.assign(Error('stopped by the test'),{code:'SERVER_ERROR'});
  return realSend(tx);};
 await assert.rejects(deployMainnet({...input,timing:{...FAST_HTTP,attempts:1},checkpoint:s=>{saved=JSON.parse(JSON.stringify(s));}}));
 delete deployer.sendTransaction;
 srv.state.onRawSend=null;srv.state.sent=[];
 assert.ok(srv.state.rawSends-sendsBefore>=stopBefore);
 return {input,saved,provider,key};
}
const mineAfterEachSend=rpc=>async()=>{await rpc.request({method:'evm_mine',params:[]});};

for(const estimates of ['the latest block','the pending block'])test('finding 1: two stale nonce reads on a resume do not send at a spent nonce, and the waiting transaction is outbid, on a node estimating on '+estimates,{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved,provider}=await stoppedRun(rpc,srv,{stopBefore:4,mined:false});
  assert.equal(saved.pending.name,USDC_GOLD);assert.equal(saved.pending.hashes.length,1);assert.equal(saved.steps.length,3);assert.ok(saved.pending.fee.maxFeePerGas);
  const n=saved.pending.nonce;let stale=2;
  srv.state.script=m=>{
   if(m.method===COUNT&&stale-->0)return ethers.toQuantity(n-1);
   if(m.method==='eth_estimateGas'&&estimates==='the latest block')return '0x30000';
  };
  srv.state.onRawSend=mineAfterEachSend(rpc);
  const d=await deployMainnet({...input,resume:saved});
  assert.deepEqual(d.readBackMismatch,[]);assert.equal(d.steps.length,6);
  assert.deepEqual(srv.state.sent.map(t=>t.nonce),[n,n+1,n+2]);
  assert.ok(srv.state.sent[0].maxFeePerGas>=BigInt(saved.pending.fee.maxFeePerGas)*125n/100n);
  assert.ok(srv.state.sent[0].maxPriorityFeePerGas>=BigInt(saved.pending.fee.maxPriorityFeePerGas)*125n/100n);
  assert.equal(await provider.getTransactionCount(testAuthority(3).address),n+3);
 }finally{srv.close();await rpc.disconnect();}
});

test('finding 1: a record that lost the fee still gets past the waiting transaction: every refused attempt bids higher',{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved}=await stoppedRun(rpc,srv,{stopBefore:4,mined:false});
  const n=saved.pending.nonce,thin={...saved,pending:{name:saved.pending.name,nonce:n,hashes:[],fee:null}};
  const fees=[];
  srv.state.onRawSend=mineAfterEachSend(rpc);
  srv.state.script=m=>{
   if(m.method==='eth_estimateGas')return '0x30000';   // this node estimates on the latest block, not on top of the waiting transaction
   if(m.method==='eth_sendRawTransaction'){const t=ethers.Transaction.from(m.params[0]);if(t.nonce===n)fees.push(t.maxPriorityFeePerGas);}
  };
  const d=await deployMainnet({...input,resume:thin});
  assert.deepEqual(d.readBackMismatch,[]);
  assert.ok(fees.length>1,'the first bid at the market fee is refused: '+fees.length);
  for(let i=1;i<fees.length;i++)assert.ok(fees[i]>fees[i-1],'attempt '+i+' did not bid higher');
 }finally{srv.close();await rpc.disconnect();}
});

test('finding 1: a failed resume keeps what the record knows about the waiting transaction',{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved}=await stoppedRun(rpc,srv,{stopBefore:4,mined:false});
  let last=null;
  const failing=new Proxy(input.deployer,{get(t,k){if(k==='sendTransaction')return async()=>{throw Object.assign(Error('rpc down'),{code:'SERVER_ERROR'});};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  await assert.rejects(deployMainnet({...input,deployer:failing,resume:saved,timing:{...FAST_HTTP,attempts:2},checkpoint:s=>{last=JSON.parse(JSON.stringify(s));}}),/rpc down|STEP_STUCK/);
  assert.deepEqual(last.pending.hashes,saved.pending.hashes);assert.deepEqual(last.pending.fee,saved.pending.fee);assert.equal(last.pending.nonce,saved.pending.nonce);
 }finally{srv.close();await rpc.disconnect();}
});

test('finding 2: a resume waits for the waiting transaction first: a stale gate sends nothing and the step is recorded',{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved}=await stoppedRun(rpc,srv,{stopBefore:4,mined:false});
  await rpc.request({method:'evm_mine',params:[]});await rpc.request({method:'evm_setAutomine',params:[true]});
  const h=saved.pending.hashes[0];let noReceipt=2;
  srv.state.script=m=>{
   if(m.method==='eth_getTransactionReceipt'&&m.params[0]===h&&noReceipt-->0)return null;
   if(m.method==='eth_call'&&m.params[0].data?.startsWith(GATE))return ethers.ZeroHash;
  };
  const before=srv.state.rawSends,run2=deployMainnet({...input,resume:saved});
  // the read-back below reads the token too: the stale answer ends once the step is recorded and the last two steps are out
  srv.state.onRawSend=n=>{if(n===before+2)srv.state.script=null;};
  const d=await run2;
  assert.equal(srv.state.rawSends,before+2,'only the two missing transactions');
  assert.deepEqual(d.steps.map(s=>s.name).slice(3),[USDC_GOLD,'approvePaidPrice','transferOwnership(Safe)']);
  assert.equal(d.steps[3].hash,h);assert.deepEqual(d.readBackMismatch,[]);
 }finally{srv.close();await rpc.disconnect();}
});

test('finding 2: one stale answer about a step that landed under a lost hash does not send it again',{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved}=await stoppedRun(rpc,srv,{stopBefore:4,mined:true});
  // the record stops before the step; the chain has it
  const lost={...saved,steps:saved.steps.filter(s=>s.name!==USDC_GOLD)};delete lost.pending;
  assert.equal(lost.steps.length,3);
  let stale=1;srv.state.script=m=>{if(m.method==='eth_call'&&m.params[0].data?.startsWith(GATE)&&stale-->0)return ethers.ZeroHash;};
  const before=srv.state.rawSends,d=await deployMainnet({...input,resume:lost});
  assert.equal(srv.state.rawSends,before+2);assert.deepEqual(d.readBackMismatch,[]);
 }finally{srv.close();await rpc.disconnect();}
});

test('a spent nonce no hash explains stops the run: a step never moves to a new nonce unread, and the deploy cannot repeat',{timeout:300000},async()=>{
 const {rpc}=await standInChain(),srv=await rpcServer(rpc);
 try{
  const {input,saved,provider}=await stoppedRun(rpc,srv,{stopBefore:4,mined:true});
  const lost={...saved,steps:saved.steps.filter(s=>s.name!==USDC_GOLD)};delete lost.pending;
  const real=await provider.getTransactionCount(testAuthority(3).address);
  // every read still says "not done", and the first two nonce reads are old: only the chain's own refusal shows the truth
  let stale=2;
  srv.state.script=m=>{
   if(m.method===COUNT&&stale-->0)return ethers.toQuantity(real-1);
   if(m.method==='eth_call'&&m.params[0].data?.startsWith(GATE))return ethers.ZeroHash;
   if(m.method==='eth_estimateGas')return '0x30000';
  };
  const before=srv.state.rawSends;
  await assert.rejects(deployMainnet({...input,resume:lost}),/NONCE_MOVED/);
  assert.equal(srv.state.rawSends,before,'the refused send did not land');
  assert.equal(await provider.getTransactionCount(testAuthority(3).address),real);
 }finally{srv.close();await rpc.disconnect();}
});
