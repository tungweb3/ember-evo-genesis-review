import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {ethers,createTestProvider,testAuthority} from '../tools/runtime.mjs';
import {randomBytes} from 'node:crypto';
import {GOLD_TYPES} from '../../service/gold-ledger.mjs';
import config from '../config/genesis.json' with {type:'json'};
import {canonicalAppearance} from '../lib/policy.mjs';
import {revealChain,readyReveals} from '../../signer/reveal-chain.mjs';
const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const COST=BigInt(config.fixtureOnly.embeoAtomic),TX={gasLimit:6_000_000n};
/* Reveal commitment (2026-10-27): the signer's hash chain (signer/reveal-chain.mjs) from a fixed TEST seed: the contract
   is given x[0] and the k-th reveal must supply x[k]. Public test values, never a production secret. */
const REVEAL_CHAIN=revealChain(ethers.keccak256(ethers.toUtf8Bytes('ember-evo-genesis TEST reveal chain')),512);
/** The secrets a transaction mined in the next block needs: the same rule the approval signer uses to hand them out. */
async function revealsFor(contract,provider){return (await readyReveals({provider,contractAddress:await contract.getAddress(),chain:REVEAL_CHAIN})).reveals;}
/* Tests written before the reveal commitment call mintFree / mintPaid / settle / sealEpoch without secrets: like the
   signer does for real mints, this wrapper adds the secrets the call needs. A call that passes its own (even empty)
   `reveals` array is left alone, so tests can check REVEAL_PENDING and REVEAL_SECRET_INVALID directly. */
function withReveals(c,provider){
 const arity={mintFree:6,mintPaid:9};
 const isOverrides=v=>v&&typeof v==='object'&&!Array.isArray(v)&&('gasLimit' in v||'value' in v||'nonce' in v);
 const fill=async(name,a)=>{
  if(arity[name]!==undefined){const n=arity[name];if(a.length===n||(a.length===n+1&&isOverrides(a[n])))return [...a.slice(0,n),await revealsFor(c,provider),...a.slice(n)];return a;}
  if(name==='settle'){if(a.length===0||(a.length===1&&isOverrides(a[0])))return [await revealsFor(c,provider),...a];return a;}
  if(name==='sealEpoch'){if(a.length===1||(a.length===2&&isOverrides(a[1])))return [a[0],REVEAL_CHAIN.next(await c.revealCommit()),...a.slice(1)];return a;}
  return a;};
 return new Proxy(c,{get(t,p){
  if(p==='connect')return(...a)=>withReveals(t.connect(...a),provider);
  if(!['mintFree','mintPaid','settle','sealEpoch'].includes(p)){const v=Reflect.get(t,p);
   // ethers keeps contract internals per instance: plain methods (getAddress, waitForDeployment...) must run on the target
   return typeof v==='function'&&typeof v.staticCall!=='function'?v.bind(t):v;}
  const m=t[p],f=async(...a)=>m(...await fill(p,a));
  for(const k of ['staticCall','estimateGas','send','populateTransaction'])f[k]=async(...a)=>m[k](...await fill(p,a));
  return f;}});
}
function tree(wallets){
 const coder=ethers.AbiCoder.defaultAbiCoder(),leaves=wallets.map(w=>ethers.keccak256(ethers.keccak256(coder.encode(['address'],[w]))));
 if(!leaves.length)return {root:ethers.ZeroHash,proof:()=>[]};const layers=[leaves];while(layers.at(-1).length>1){const prev=layers.at(-1),next=[];for(let i=0;i<prev.length;i+=2){next.push(i+1===prev.length?prev[i]:ethers.keccak256(ethers.concat([prev[i],prev[i+1]].sort())));}layers.push(next);}
 return {root:layers.at(-1)[0],proof:i=>{const out=[];for(let level=0;level<layers.length-1;level++){const sibling=i^1;if(sibling<layers[level].length)out.push(layers[level][sibling]);i=Math.floor(i/2);}return out;}};
}
async function harness(type='FixtureToken',candidate='EmberEvoGenesisCandidate',chainId=31337,signerMode='eoa'){
 const rpc=await createTestProvider(chainId),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 const admin=await provider.getSigner(0),alice=await provider.getSigner(1),bob=await provider.getSigner(2),adminAddress=await admin.getAddress(),a=await alice.getAddress(),b=await bob.getAddress();
 const approvalSigner=testAuthority(0);assert.equal(approvalSigner.address,adminAddress);
 async function mine(tx){return await (await tx).wait();}
 async function deploy(key,args){const artifact=artifacts[key],c=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,admin).deploy(...args,TX);await c.waitForDeployment();return c;}
 const token=await deploy((type==='R3HookToken'?'contracts/test/R3Fixtures.sol:':'contracts/test/Fixtures.sol:')+type,[a]);
 const contractSigner=signerMode==='erc1271'?await deploy('contracts/test/HardeningFixtures.sol:ContractAuthority',[adminAddress]):null;
 const args=[adminAddress,await token.getAddress(),contractSigner?await contractSigner.getAddress():adminAddress,COST];if(candidate==='EmberEvoGenesisCandidate')args.push(BigInt(config.fixtureOnly.gold),'LOCAL_FIXTURE');
 const contract=withReveals(await deploy(candidate==='EmberEvoGenesisCandidate'?'contracts/EmberEvoGenesisCandidate.sol:'+candidate:'contracts/test/Fixtures.sol:'+candidate,args),provider);
 const receiver=await deploy('contracts/test/Fixtures.sol:CallbackReceiver',[]);
 const time=async()=>Number((await rpc.request({method:'eth_getBlockByNumber',params:['latest',false]})).timestamp);
 async function approval(wallet,tag='one',uri=undefined,overrides={}){const choice=overrides.choice??0;uri??=(choice===3?'':'ipfs://LOCAL_ONLY/'+tag);
   const key=ethers.keccak256(ethers.toUtf8Bytes(canonicalAppearance({body:'standard',skin:'green',hat:'none',top:tag,bottom:'none',shoes:'bare'}))),deadline=overrides.deadline??(await time())+3600000;
   const signature=await approvalSigner.signTypedData({name:'EmberEvoGenesisCandidate',version:'6',chainId:overrides.chainId??chainId,verifyingContract:overrides.contract??await contract.getAddress()},{Appearance:[{name:'wallet',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]},{wallet,lookKey:key,choice,uriHash:ethers.keccak256(ethers.toUtf8Bytes(uri)),deadline,signerEpoch:overrides.signerEpoch??await contract.signerEpoch()});return {key,choice,uri,deadline,signature,wallet,authority:approvalSigner};
 }
 // Opening needs the snapshot, locked reveal URIs and the reveal commitment (setMintPaused refuses otherwise, 2026-10-27).
 async function configure(wallets=[a],eligible=wallets.length,{pending='ipfs://LOCAL_ONLY/pending',base='ipfs://LOCAL_ONLY/revealed/'}={}){const t=tree(wallets),now=await time(),start=now+20;await mine(contract.configureSnapshot(t.root,eligible,now-1,start,TX));
   await mine(contract.setRevealURIs(pending,base,true,TX));await mine(contract.setRevealCommit(REVEAL_CHAIN.anchor,TX));
   await mine(contract.setMintPaused(false,TX));await mine(contract.approvePaidPrice(TX));await rpc.request({method:'evm_increaseTime',params:[21]});await rpc.request({method:'evm_mine',params:[]});if(wallets.length===0)await openPaid();return {tree:t,start};}
 async function openPaid(){}
 async function paid(signer=alice,p=undefined,recipient=config.receivingAddress,amount=COST){p??=await approval(await signer.getAddress(),'paid-'+Math.random().toString(36).slice(2));const args=await paidArgs(p,await signer.getAddress(),recipient,amount);return mine(contract.connect(signer).mintPaid(...args,TX));}
 async function paidArgs(p,who=p.wallet??a,recipient=config.receivingAddress,amount=COST){const auth={orderId:ethers.hexlify(randomBytes(32)),wallet:who,lookKey:p.key,choice:p.choice??0,uriHash:ethers.keccak256(ethers.toUtf8Bytes(p.uri)),recipient,embeoCost:amount,goldCost:BigInt(config.fixtureOnly.gold),deadline:p.deadline,signerEpoch:await contract.signerEpoch()};const authority=p.authority??approvalSigner;const signature=await authority.signTypedData({name:'EmberEvoGenesisCandidate',version:'6',chainId,verifyingContract:await contract.getAddress()},GOLD_TYPES,auth);return [p.key,p.choice??0,p.uri,p.deadline,p.signature,recipient,amount,auth,signature];}
 return {paidArgs,rpc,provider,admin,alice,bob,a,b,token,contract,receiver,contractSigner,approvalSigner,deploy,time,approval,configure,openPaid,paid,mine,
  reveals:()=>revealsFor(contract,provider),close:()=>rpc.disconnect()};
}


export {harness,COST,TX,artifacts,REVEAL_CHAIN,revealsFor};
