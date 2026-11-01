// Ethereum mainnet deployment of EmberEvoGenesis (owner 2026-11-01). Everything the deployer key can do alone, in one run:
//   deploy (owner = the deployer, so the setup below needs no multisig round) -> setRevealURIs(pending, base, locked)
//   -> setRevealCommit (the signer's acceptance names a block 2 below the head; it must land within 256 blocks, which a
//   2-of-3 Safe could miss) -> addPaymentToken(USDC, 1,600 GOLD; usable two days later) -> approvePaidPrice
//   -> transferOwnership(Safe). Minting stays paused: it cannot open without the free-list snapshot, which the Safe sets
//   later together with the opening (contract/tools/safe-batch.mjs open), after it accepts ownership (safe-batch.mjs accept).
//
//   Dry run on a simulated chain with chainId 1 (stand-in tokens, a stand-in Safe address):  node contract/tools/deploy-mainnet.mjs --dry-run
//   Mainnet (deploy-mainnet.ps1 asks for the secrets and sets): RPC_URL, DEPLOYER_PRIVATE_KEY, SIGNER_KEY_FILE,
//     REVEAL_COMMIT (anchor of the mainnet reveal seed). Every other parameter is fixed below and checked on chain first.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ethers,createTestProvider,testAuthority} from './runtime.mjs';
import {revealChain,signRevealCommit} from '../../signer/reveal-chain.mjs';
import {GENESIS} from './deploy-testnet.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
const LOW128=(1n<<128n)-1n;
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
});

/** The deployer-only part of the mainnet setup; returns the record (every value read back from the chain). */
export async function deployMainnet({deployer,revealSigner,revealCommit,cfg=MAINNET,log=()=>{}}){
 const provider=deployer.provider,{chainId}=await provider.getNetwork();
 if(chainId!==BigInt(cfg.chainId))throw Error('WRONG_CHAIN '+chainId);
 if(!/^0x[0-9a-fA-F]{64}$/.test(revealCommit??'')||BigInt(revealCommit)===0n)throw Error('REVEAL_COMMIT_INVALID');
 if(!revealSigner)throw Error('REVEAL_SIGNER_REQUIRED');
 const signerAddress=ethers.getAddress(await revealSigner.getAddress()),owner=await deployer.getAddress();
 if(signerAddress===owner)throw Error('SIGNER_IS_DEPLOYER');   // separate secrets (audit README section 7)
 const steps=[];
 const record=async(name,tx)=>{const rc=await tx.wait();if(rc.status!==1)throw Error('TX_FAILED '+name);steps.push({name,hash:tx.hash,gasUsed:rc.gasUsed.toString()});log(name,tx.hash);return rc;};
 // a load-balanced RPC can answer from a node that has not seen the block yet (2026-10-29 rehearsal)
 async function codeVisible(address){
  for(let i=0,seen=0;i<90;i++){if((await provider.getCode(address))!=='0x'){if(++seen>=3)return;}else seen=0;await new Promise(r=>setTimeout(r,2000));}
  throw Error('CODE_NOT_VISIBLE '+address);
 }
 const genesisArgs=[owner,ethers.getAddress(cfg.imdUSD),signerAddress,ethers.getAddress(cfg.safe),cfg.paidCost,cfg.goldCost,cfg.symbol];
 const factory=new ethers.ContractFactory(artifacts[GENESIS].abi,artifacts[GENESIS].bytecode,deployer);
 const genesis=await factory.deploy(...genesisArgs);
 const deployRc=await record('deploy EmberEvoGenesis',genesis.deploymentTransaction());
 const contract=await genesis.getAddress();await codeVisible(contract);
 await record('setRevealURIs (locked)',await genesis.setRevealURIs(cfg.pendingURI,cfg.metadataBase,true));
 const commitBlock=await provider.getBlock((await provider.getBlockNumber())-2);
 const acceptance=await signRevealCommit({signer:revealSigner,chainId,contractAddress:contract,commit:revealCommit,previous:await genesis.revealCommit(),signerEpoch:await genesis.signerEpoch(),block:commitBlock});
 await record('setRevealCommit',await genesis.setRevealCommit(revealCommit,commitBlock.number,acceptance));
 await record('addPaymentToken(USDC, 1600 GOLD)',await genesis.addPaymentToken(ethers.getAddress(cfg.usdc),cfg.usdcGoldCost));
 await record('approvePaidPrice',await genesis.approvePaidPrice());
 await record('transferOwnership(Safe)',await genesis.transferOwnership(ethers.getAddress(cfg.safe)));

 // read back everything the next steps (Safe, signer Worker, World GOLD book, Etherscan) depend on
 const readToken=async t=>{const p=await genesis.paymentTokens(t);return {token:ethers.getAddress(t),amount:(p&LOW128).toString(),goldCost:((p>>128n)&((1n<<88n)-1n)).toString(),usableAt:Number(p>>216n)};};
 const paymentTokens=[await readToken(cfg.imdUSD),await readToken(cfg.usdc)];
 const got={name:await genesis.name(),symbol:await genesis.symbol(),owner:await genesis.owner(),pendingOwner:await genesis.pendingOwner(),
  recipient:await genesis.paymentRecipient(),signer:await genesis.appearanceSigner(),paidCost:(await genesis.paidCost()).toString(),goldCost:(await genesis.paidGoldCost()).toString(),
  mintPaused:await genesis.mintPaused(),paidPriceApproved:await genesis.paidPriceApproved(),revealURIsLocked:await genesis.revealURIsLocked(),
  revealCommit:await genesis.revealCommit(),pendingURI:await genesis.pendingURI(),metadataBase:await genesis.revealBaseURI(),maxSupply:(await genesis.maxSupply()).toString(),
  snapshotConfigured:await genesis.snapshotConfigured(),domainVersion:(await genesis.eip712Domain())[2],domainName:(await genesis.eip712Domain())[1]};
 const expect={name:cfg.name,symbol:cfg.symbol,owner,pendingOwner:ethers.getAddress(cfg.safe),recipient:ethers.getAddress(cfg.safe),signer:signerAddress,
  paidCost:cfg.paidCost.toString(),goldCost:cfg.goldCost.toString(),mintPaused:true,paidPriceApproved:true,revealURIsLocked:true,revealCommit,
  pendingURI:cfg.pendingURI,metadataBase:cfg.metadataBase,maxSupply:'1688',snapshotConfigured:false,domainVersion:'7',domainName:'EmberEvoGenesisCandidate'};
 const mismatch=Object.keys(expect).filter(k=>String(got[k]).toLowerCase()!==String(expect[k]).toLowerCase());
 if(paymentTokens[0].amount!==cfg.paidCost.toString()||paymentTokens[0].goldCost!==cfg.goldCost.toString())mismatch.push('paymentTokens(imdUSD)');
 if(paymentTokens[1].amount!==(cfg.paidCost/10n**12n).toString()||paymentTokens[1].goldCost!==cfg.usdcGoldCost.toString())mismatch.push('paymentTokens(USDC)');
 const code=await provider.getCode(contract),codeHash=ethers.keccak256(code);
 return {chainId:Number(chainId),contract,deployBlock:deployRc.blockNumber,startBlock:Number(await genesis.startBlock()),owner:got.owner,pendingOwner:got.pendingOwner,
  safe:ethers.getAddress(cfg.safe),token:ethers.getAddress(cfg.imdUSD),usdc:ethers.getAddress(cfg.usdc),paymentTokens,recipient:got.recipient,signer:signerAddress,
  symbol:got.symbol,name:got.name,pendingURI:got.pendingURI,metadataBase:got.metadataBase,revealCommit,paidCost:got.paidCost,goldCost:got.goldCost,
  domainVersion:got.domainVersion,maxSupply:got.maxSupply,mintPaused:got.mintPaused,snapshotConfigured:false,codeHash,runtimeBytes:(code.length-2)/2,
  readBackMismatch:mismatch,steps,totalGas:steps.reduce((a,s)=>a+BigInt(s.gasUsed),0n).toString(),
  etherscan:{contractName:GENESIS,compiler:'v0.8.38+commit.1835d247',constructorArgsHex:genesis.interface.encodeDeploy(genesisArgs).slice(2)}};
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
export async function preflight(provider,deployerAddress,signerAddress,cfg=MAINNET){
 const E=['function symbol() view returns (string)','function decimals() view returns (uint8)'];
 const S=['function getOwners() view returns (address[])','function getThreshold() view returns (uint256)','function VERSION() view returns (string)'];
 const out={};
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
 const bal=await provider.getBalance(deployerAddress),fee=await provider.getFeeData();
 out.deployerEth=ethers.formatEther(bal);out.maxFeeGwei=ethers.formatUnits(fee.maxFeePerGas??fee.gasPrice??0n,'gwei');
 // about 6.3M gas for the six transactions today (Osaka pricing; ~40M if EIP-8037 is live): refuse a wallet that cannot pay 45M at maxFee
 out.needEth=ethers.formatEther(45_000_000n*(fee.maxFeePerGas??fee.gasPrice??0n));
 if(bal<45_000_000n*(fee.maxFeePerGas??fee.gasPrice??0n))throw Error(`deployer has ${out.deployerEth} ETH, needs about ${out.needEth}`);
 return out;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run');
 let deployer,revealSigner,revealCommit,cfg=MAINNET,close=()=>{};
 if(dry){
  const rpc=await createTestProvider(1),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});
  deployer=await provider.getSigner(0);close=()=>rpc.disconnect();revealSigner=testAuthority(1);
  revealCommit=revealChain(ethers.keccak256(ethers.toUtf8Bytes('ember-evo-genesis MAINNET DRY RUN reveal chain'))).anchor;
  // local fixtures (the Sepolia test tokens refuse chainId 1): 18 decimals for imdUSD, 6 for USDC
  const dep=async(k,...a)=>{const c=await new ethers.ContractFactory(artifacts[k].abi,artifacts[k].bytecode,deployer).deploy(await deployer.getAddress(),...a);await c.waitForDeployment();return c.getAddress();};
  cfg={...MAINNET,imdUSD:await dep('contracts/test/Fixtures.sol:FixtureToken'),usdc:await dep('contracts/test/Fixtures.sol:DecimalsToken',6),safe:testAuthority(4).address};
 }else{
  const need=k=>{const v=process.env[k];if(!v)throw Error('missing env '+k);return v.trim();};
  const provider=new ethers.JsonRpcProvider(need('RPC_URL'));
  deployer=new ethers.Wallet(need('DEPLOYER_PRIVATE_KEY'),provider);
  revealSigner=new ethers.Wallet(readFileSync(need('SIGNER_KEY_FILE'),'utf8').trim());
  revealCommit=need('REVEAL_COMMIT');
  console.log(JSON.stringify(await preflight(provider,await deployer.getAddress(),revealSigner.address),null,1));
  if(process.env.PREFLIGHT_ONLY==='1')process.exit(0);
 }
 try{
  const d=await deployMainnet({deployer,revealSigner,revealCommit,cfg,log:(n,h)=>console.log('  ',n,h)});
  const file=fileURLToPath(new URL(`../deployments/${dry?'dryrun-':''}${d.chainId}-${Date.now()}.json`,import.meta.url));
  mkdirSync(resolve(file,'..'),{recursive:true});
  writeFileSync(file,JSON.stringify({...d,followUp:{goldBookRegistry:mainnetGoldBookEntry(d),
   workerVars:{CHAIN_ID:String(d.chainId),CONTRACT_ADDRESS:d.contract,METADATA_BASE:d.metadataBase,PAYMENT_TOKENS:d.paymentTokens.map(t=>t.token).join(',')}}},null,1));
  console.log(JSON.stringify({contract:d.contract,owner:d.owner,pendingOwner:d.pendingOwner,paymentTokens:d.paymentTokens,readBackMismatch:d.readBackMismatch,totalGas:d.totalGas,file},null,1));
  if(d.readBackMismatch.length)process.exitCode=2;
 }finally{close();}
}
