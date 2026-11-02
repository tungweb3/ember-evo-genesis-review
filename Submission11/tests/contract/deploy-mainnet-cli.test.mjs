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
import {MAINNET,mainnetGoldBookEntry} from '../tools/deploy-mainnet.mjs';
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
// A node behind the others: no new block, no receipt, no contract code yet. Seeded, so a failure repeats.
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
  if((m.method==='eth_getCode'&&isNew(m.params[0]))||(m.method==='eth_call'&&isNew(m.params[0].to)))return '0x';
  return undefined;
 };
}
async function rpcServer(rpc,{lag=0}={}){
 const fixed=answers(),behind=lagger(rpc,lag),state={rawSends:0,onRawSend:null,requests:0};
 const one=async m=>{
  state.requests++;
  const f=fixed(m);if(f!==undefined)return {jsonrpc:'2.0',id:m.id,result:f};
  const b=lag?await behind(m):undefined;if(b!==undefined)return {jsonrpc:'2.0',id:m.id,result:b};
  try{
   const result=await rpc.request({method:m.method,params:m.params??[]});
   if(m.method==='eth_sendRawTransaction'){state.rawSends++;state.onRawSend?.(state.rawSends);}
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
  const pre=await run(tool('deploy-mainnet.mjs'),[],{...env,PREFLIGHT_ONLY:'1'});
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
