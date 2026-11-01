import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ethers,createTestProvider,testAuthority} from '../tools/runtime.mjs';
import {GENESIS,SEPOLIA} from '../tools/deploy-testnet.mjs';
const FIXTURE_18='contracts/test/Fixtures.sol:FixtureToken',FIXTURE_DEC='contracts/test/Fixtures.sol:DecimalsToken';
import {deployMainnet,mainnetGoldBookEntry,MAINNET} from '../tools/deploy-mainnet.mjs';
import {acceptBatch,openBatch} from '../tools/safe-batch.mjs';
import {FreeApprovalSigner} from '../../signer/free-approval.mjs';
import {revealChain,readyReveals} from '../../signer/reveal-chain.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const look={body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null};
async function chain(id){const rpc=await createTestProvider(id),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});return {rpc,provider};}
const now=async p=>(await p.getBlock('latest')).timestamp;
// Stand-ins on the simulated chain (the Sepolia test tokens refuse chainId 1): local fixtures with 18 decimals for imdUSD
// and 6 for USDC, test account 4 for the Safe.
export async function standIns(deployer){
 const dep=async(k,...args)=>{const c=await new ethers.ContractFactory(artifacts[k].abi,artifacts[k].bytecode,deployer).deploy(await deployer.getAddress(),...args);await c.waitForDeployment();return c.getAddress();};
 return {...MAINNET,imdUSD:await dep(FIXTURE_18),usdc:await dep(FIXTURE_DEC,6),safe:testAuthority(4).address};
}
// The Safe's transactions from a Transaction Builder file, sent by the stand-in Safe account.
async function execute(provider,file,safe){for(const t of file.transactions)await (await safe.sendTransaction({to:t.to,data:t.data,value:0n})).wait();}

test('mainnet deploy on a simulated chainId 1: deployer setup, Safe accepts ownership, then the Safe sets the free list and opens',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0),alice=await provider.getSigner(1),bob=await provider.getSigner(2),key=testAuthority(1);
  const cfg=await standIns(deployer),rc=revealChain(ethers.keccak256(ethers.toUtf8Bytes('mainnet deploy test reveal chain')),64);
  // the signer key must not be the deployer's (separate secrets)
  await assert.rejects(deployMainnet({deployer,revealSigner:deployer,revealCommit:rc.anchor,cfg}),/SIGNER_IS_DEPLOYER/);
  const d=await deployMainnet({deployer,revealSigner:key,revealCommit:rc.anchor,cfg});
  assert.deepEqual(d.readBackMismatch,[]);
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
  const safe=new ethers.Wallet(testAuthority(4).privateKey,provider);
  await execute(provider,acceptBatch(d),safe);
  assert.equal(await g.owner(),cfg.safe);assert.equal(await g.pendingOwner(),ethers.ZeroAddress);
  await assert.rejects(g.connect(deployer).approvePaidPrice.staticCall(),/OwnableUnauthorizedAccount/);
  // the opening batch: free list (with a duplicate, removed) + unpause; opening 7 hours later
  const wallets=[await alice.getAddress(),await bob.getAddress(),(await alice.getAddress()).toLowerCase()],t=await now(provider);
  assert.throws(()=>openBatch(d,wallets,t-60,t+3600,t),/at least 6 hours/);
  assert.throws(()=>openBatch(d,wallets,t+60,t+7*3600,t),/in the past/);
  const o=openBatch(d,wallets,t-60,t+7*3600,t);
  assert.equal(o.tree.count,2);assert.equal(o.file.transactions.length,2);assert.equal(o.file.chainId,'1');assert.equal(o.file.meta.createdFromSafeAddress,cfg.safe);
  await execute(provider,o.file,safe);
  assert.equal(await g.snapshotConfigured(),true);assert.equal(await g.mintPaused(),false);assert.equal(await g.eligibleWalletCount(),2n);
  const signer=new FreeApprovalSigner({provider,contractAddress:d.contract,chainId:1,signer:key,metadataBase:d.metadataBase,snapshotWallets:wallets});
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
