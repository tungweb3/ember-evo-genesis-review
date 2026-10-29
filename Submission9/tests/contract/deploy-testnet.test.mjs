import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ethers,createTestProvider,testAuthority} from '../tools/runtime.mjs';
import {deployRehearsal,followUp,GENESIS,SEPOLIA} from '../tools/deploy-testnet.mjs';
import {FreeApprovalSigner} from '../../signer/free-approval.mjs';
import {revealChain,readyReveals} from '../../signer/reveal-chain.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const look={body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null};
const RECIPIENT=testAuthority(4).address;   // stands in for the treasury Safe
async function chain(id){const rpc=await createTestProvider(id),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});return {rpc,provider};}

test('rehearsal deploy on a simulated Sepolia chain, then a signed free mint and a random mint revealed by settle()',async()=>{
 const {rpc,provider}=await chain(SEPOLIA);try{
  const deployer=await provider.getSigner(0),alice=await provider.getSigner(1),bob=await provider.getSigner(2),key=testAuthority(1);
  const wallets=[await alice.getAddress(),await bob.getAddress()];
  await assert.rejects(deployRehearsal({deployer,signerAddress:key.address,revealSigner:key,snapshotWallets:wallets,pendingURI:'ipfs://REHEARSAL/pending.json',
   metadataBase:'ipfs://REHEARSAL/looks/',recipient:RECIPIENT,paidCost:1n}),/REVEAL_COMMIT_INVALID/);
  await assert.rejects(deployRehearsal({deployer,signerAddress:key.address,revealSigner:key,snapshotWallets:wallets,pendingURI:'ipfs://REHEARSAL/pending.json',
   metadataBase:'ipfs://REHEARSAL/looks/',paidCost:1n}),/PAYMENT_RECIPIENT_INVALID/);
  const chain=revealChain(ethers.keccak256(ethers.toUtf8Bytes('deploy test reveal chain')),64);
  // the commitment needs the approval signer's acceptance: another key is refused before anything is sent
  await assert.rejects(deployRehearsal({deployer,signerAddress:key.address,revealSigner:testAuthority(3),snapshotWallets:wallets,pendingURI:'ipfs://REHEARSAL/pending.json',
   metadataBase:'ipfs://REHEARSAL/looks/',revealCommit:chain.anchor,recipient:RECIPIENT,paidCost:1n}),/REVEAL_SIGNER_MISMATCH/);
  const d=await deployRehearsal({deployer,signerAddress:key.address,revealSigner:key,snapshotWallets:wallets,pendingURI:'ipfs://REHEARSAL/pending.json',
   metadataBase:'ipfs://REHEARSAL/looks/',revealCommit:chain.anchor,recipient:RECIPIENT,paidCost:20n*10n**18n,goldCost:1200n,startDelay:60});
  assert.equal(d.chainId,SEPOLIA);assert.equal(d.revealCommit,chain.anchor);assert.equal(d.tokenIsTestUSD,true);assert.equal(d.recipient,RECIPIENT);assert.equal(d.eligible,2);
  const g=new ethers.Contract(d.contract,artifacts[GENESIS].abi,provider);
  assert.equal(await g.name(),'Ember Evo Genesis');assert.equal(await g.paymentRecipient(),RECIPIENT);assert.equal(await g.paidCost(),20n*10n**18n);assert.equal(await g.appearanceSigner(),key.address);
  assert.equal(await g.paidPriceApproved(),false);assert.equal(await g.revealURIsLocked(),true);assert.equal(await g.mintPaused(),false);
  const signer=new FreeApprovalSigner({provider,contractAddress:d.contract,chainId:SEPOLIA,signer:key,metadataBase:d.metadataBase,snapshotWallets:wallets});
  await assert.rejects(signer.approve({wallet:wallets[0],look,choice:0}),{code:'SALE_NOT_STARTED'});
  await rpc.request({method:'evm_increaseTime',params:[61]});await rpc.request({method:'evm_mine',params:[]});
  assert.equal(await g.revealCommit(),chain.anchor);
  const reveals=async()=>(await readyReveals({provider,contractAddress:d.contract,chain})).reveals;
  const mint=async(who,m)=>(await g.connect(who).mintFree(m.lookKey,m.choice,m.uri,m.deadline,m.signature,m.index,m.proof,await reveals())).wait();
  const A=(await signer.approve({wallet:wallets[0],look,choice:1})).mintFree;await mint(alice,A);
  assert.equal(await g.tokenURI(1),'ipfs://REHEARSAL/looks/'+A.lookKey+'/1');
  const B=(await signer.approve({wallet:wallets[1],look:{...look,hat:'HAT_BERET.beret'},choice:3})).mintFree;await mint(bob,B);
  assert.equal(await g.tokenURI(2),'ipfs://REHEARSAL/pending.json');
  await rpc.request({method:'hardhat_mine',params:['0x1e']});   // past the seed block and the signer's 2 confirmations
  const ready=await reveals();assert.deepEqual(ready,[chain.secret(1)]);
  await (await g.connect(deployer).settle(ready)).wait();assert.equal(await g.revealCommit(),chain.secret(1));
  const [skin,revealed]=await g.skinOf(2);assert.equal(revealed,true);
  assert.equal(await g.tokenURI(2),'ipfs://REHEARSAL/looks/'+B.lookKey+'/'+skin);
 }finally{await rpc.disconnect();}
});

test('mainnet is refused by the script and by the contract itself',async()=>{
 const {rpc,provider}=await chain(1);try{
  const deployer=await provider.getSigner(0);
  await assert.rejects(deployRehearsal({deployer,signerAddress:testAuthority(1).address,snapshotWallets:[await deployer.getAddress()],
   pendingURI:'ipfs://x/p',metadataBase:'ipfs://x/',paidCost:1n}),/MAINNET_REFUSED/);
  const token=await new ethers.ContractFactory(artifacts['contracts/test/Fixtures.sol:FixtureToken'].abi,artifacts['contracts/test/Fixtures.sol:FixtureToken'].bytecode,deployer).deploy(await deployer.getAddress());
  const f=new ethers.ContractFactory(artifacts[GENESIS].abi,artifacts[GENESIS].bytecode,deployer);
  await assert.rejects(f.getDeployTransaction(await deployer.getAddress(),await token.getAddress(),testAuthority(1).address,RECIPIENT,1n,1n,'X').then(tx=>provider.call({...tx,from:deployer.address})),/MAINNET_NOT_REVIEWED/);
 }finally{await rpc.disconnect();}
});

// Review 2026-10-29: the registry entry the deploy tool prints must have the World book's shape, or the book refuses
// every paid order of the deployment (MINT_DEPLOYMENT_INVALID).
test('the GOLD book registry entry printed after a deploy has every field the World book requires',()=>{
 const d={chainId:SEPOLIA,contract:'0x'+'Ab'.repeat(20),metadataBase:'ipfs://X/',paidRoute:'open',codeHash:'0x'+'1'.repeat(64),startBlock:7,
  paidCost:'20000000000000000000',goldCost:'1200',signer:'0x'+'2'.repeat(40),recipient:'0x'+'C'.repeat(40)};
 const r=followUp(d).goldBookRegistry;
 assert.deepEqual(Object.keys(r).sort(),['addedTokenGoldCosts','chainId','codeHash','contract','deployBlock','domainVersion','embeoCost','environment','goldCost','id','recipient','signer']);
 assert.deepEqual(r.addedTokenGoldCosts,[]);assert.equal(r.contract,d.contract.toLowerCase());assert.equal(r.recipient,d.recipient.toLowerCase());
 assert.equal(r.goldCost,'1200');assert.equal(r.domainVersion,'7');
});
