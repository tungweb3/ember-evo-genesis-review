// Sepolia rehearsal deployment for Genesis R5. Refuses mainnet (the contract refuses it too).
//   Dry run on a simulated Sepolia chain (chainId 11155111, in memory):  node contract/tools/deploy-testnet.mjs --dry-run
//   Real Sepolia (the owner runs this with their own env; nothing is read from files except the snapshot list):
//     RPC_URL, DEPLOYER_PRIVATE_KEY, SIGNER_ADDRESS, SNAPSHOT_FILE (JSON array of wallets), PENDING_URI, METADATA_BASE,
//     REVEAL_COMMIT (the signer's reveal chain anchor, bytes32), SIGNER_KEY_FILE (the approval signer's key file: it signs
//     the contract's RevealCommitAcceptance in this process, audit 2026-10-27; the key is never printed or written),
//     PAYMENT_RECIPIENT (where every paid mint's payment goes: the treasury Safe, owner 2026-10-28)
//     optional: PAID_COST (whole tokens, default 20), GOLD_COST (default 1200), SYMBOL (default tEEVO),
//               PAYMENT_TOKEN (else a TestUSD is deployed), START_DELAY_SECONDS (default 600),
//               OPEN_PAID=1 (also call approvePaidPrice: the paid rehearsal), TOKEN_RECIPIENTS (comma list: 1,000 tUSD each)
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ethers,createTestProvider,testAuthority} from './runtime.mjs';
import {snapshotTree} from '../../signer/free-approval.mjs';
import {revealChain,signRevealCommit} from '../../signer/reveal-chain.mjs';

const artifacts=JSON.parse(readFileSync(new URL('../artifacts/test-artifacts.private.json',import.meta.url),'utf8'));
export const GENESIS='contracts/EmberEvoGenesisCandidate.sol:EmberEvoGenesisCandidate',TEST_USD='contracts/testnet/TestUSD.sol:TestUSD';
export const SEPOLIA=11155111;

export async function deployRehearsal({deployer,signerAddress,revealSigner,snapshotWallets,pendingURI,metadataBase,revealCommit,recipient,paidCost,goldCost=1n,symbol='tEEVO',startDelay=600,tokenAddress=null,openPaid=false,tokenRecipients=[],log=()=>{}}){
 const provider=deployer.provider,{chainId}=await provider.getNetwork();
 if(chainId===1n)throw Error('MAINNET_REFUSED');
 if(!ethers.isAddress(signerAddress))throw Error('SIGNER_ADDRESS_INVALID');
 if(!ethers.isAddress(recipient)||BigInt(recipient)===0n)throw Error('PAYMENT_RECIPIENT_INVALID');
 // the signer's reveal chain anchor (signer/tools/reveal-anchor.mjs prints it; the seed itself never comes here)
 if(!/^0x[0-9a-fA-F]{64}$/.test(revealCommit??'')||BigInt(revealCommit)===0n)throw Error('REVEAL_COMMIT_INVALID');
 // the approval signer accepts the commitment (the contract refuses one the owner sets alone)
 if(!revealSigner||ethers.getAddress(await revealSigner.getAddress())!==ethers.getAddress(signerAddress))throw Error('REVEAL_SIGNER_MISMATCH');
 if(!/^(ipfs|ar|https):\/\/\S+\/$/.test(metadataBase)||!/^(ipfs|ar|https):\/\/\S+$/.test(pendingURI))throw Error('METADATA_URI_INVALID');
 if(!Number.isSafeInteger(startDelay)||startDelay<60)throw Error('START_DELAY_INVALID');
 if(tokenRecipients.some(a=>!ethers.isAddress(a))||(tokenRecipients.length&&tokenAddress))throw Error('TOKEN_RECIPIENTS_INVALID');
 const tree=snapshotTree(snapshotWallets),owner=await deployer.getAddress(),steps=[];
 const record=async(name,tx)=>{const rc=await tx.wait();steps.push({name,hash:tx.hash,gasUsed:rc.gasUsed.toString()});log(name,tx.hash);return rc;};
 async function deploy(key,args,name){const c=await new ethers.ContractFactory(artifacts[key].abi,artifacts[key].bytecode,deployer).deploy(...args);await record(name,c.deploymentTransaction());return c;}
 const token=tokenAddress??await (await deploy(TEST_USD,[owner],'deploy TestUSD')).getAddress();
 const genesisArgs=[owner,token,signerAddress,ethers.getAddress(recipient),paidCost,goldCost,symbol];
 const genesis=await deploy(GENESIS,genesisArgs,'deploy EmberEvoGenesis');
 const now=(await provider.getBlock('latest')).timestamp,freeStartAt=now+startDelay;
 await record('configureSnapshot',await genesis.configureSnapshot(tree.root,tree.count,now-1,freeStartAt));
 await record('setRevealURIs (locked)',await genesis.setRevealURIs(pendingURI,metadataBase,true));
 // The acceptance signs a block two below the head (audit b0b1d96a, finding 1): it exists for every node, survives a
 // short reorg, and blockhash() still knows it when the transaction (and its gas estimate) runs.
 const commitBlock=await provider.getBlock((await provider.getBlockNumber())-2);
 const acceptance=await signRevealCommit({signer:revealSigner,chainId,contractAddress:await genesis.getAddress(),commit:revealCommit,previous:await genesis.revealCommit(),signerEpoch:await genesis.signerEpoch(),block:commitBlock});
 await record('setRevealCommit',await genesis.setRevealCommit(revealCommit,commitBlock.number,acceptance));
 await record('setMintPaused(false)',await genesis.setMintPaused(false));
 // Paid rehearsal: open the route at the deploy-time (test) price, and hand test tUSD to the test wallets.
 if(openPaid)await record('approvePaidPrice',await genesis.approvePaidPrice());
 if(tokenRecipients.length){const t=new ethers.Contract(token,artifacts[TEST_USD].abi,deployer);
  for(const to of tokenRecipients)await record('tUSD 1,000 -> '+to,await t.transfer(to,1_000n*10n**18n));}
 const contract=await genesis.getAddress();
 const codeHash=ethers.keccak256(await provider.getCode(contract));
 return {chainId:Number(chainId),owner,contract,token,tokenIsTestUSD:!tokenAddress,recipient:ethers.getAddress(recipient),signer:signerAddress,snapshotRoot:tree.root,eligible:tree.count,
  freeStartAt,startBlock:Number(await genesis.startBlock()),pendingURI,metadataBase,revealCommit,paidCost:paidCost.toString(),goldCost:goldCost.toString(),symbol,
  paidRoute:openPaid?'open (approvePaidPrice called; test price)':'closed (approvePaidPrice not called)',codeHash,steps,
  // for Etherscan "Verify & Publish" (Solidity standard JSON input = contract/artifacts/standard-input.private.json)
  etherscan:{contractName:GENESIS,compiler:'v0.8.38+commit.1835d247',constructorArgsHex:genesis.interface.encodeDeploy(genesisArgs).slice(2),
   tokenConstructorArgsHex:tokenAddress?null:ethers.AbiCoder.defaultAbiCoder().encode(['address'],[owner]).slice(2)},
  totalGas:steps.reduce((a,s)=>a+BigInt(s.gasUsed),0n).toString()};
}

/** What the signer Worker and the mint page need from a deployment. */
export function followUp(d){
 return {workerVars:{CHAIN_ID:String(d.chainId),CONTRACT_ADDRESS:d.contract,METADATA_BASE:d.metadataBase},
  pageConfig:`window.GENESIS_CONFIG=${JSON.stringify({chainId:d.chainId,chainName:'Sepolia (test network)',contract:d.contract,signerApi:'<signer worker URL>',explorer:'https://sepolia.etherscan.io',paid:d.paidRoute.startsWith('open')})};`,
  // World repo server/genesis-deployments-sepolia.ts entry (the GOLD book only accepts orders for pinned deployments)
  // id: unique per contract (an id already in the registry would make the book find the old entry); domainVersion: the
  // contract's EIP-712 version, stored with every hold. addedTokenGoldCosts (owner 2026-10-29): the GOLD price of each
  // token added with addPaymentToken(token, goldCost); empty at deployment. Add the entry only after the added tokens are
  // on chain, with their prices read back from paymentTokens(token) (a price not listed refuses that token's orders).
  goldBookRegistry:{id:'sepolia-'+d.contract.slice(2,10).toLowerCase(),environment:'sepolia',chainId:d.chainId,contract:d.contract.toLowerCase(),codeHash:d.codeHash,
   deployBlock:String(d.startBlock),embeoCost:d.paidCost,goldCost:d.goldCost,addedTokenGoldCosts:[],signer:d.signer,domainVersion:'7',recipient:d.recipient.toLowerCase()}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run');
 let deployer,close=()=>{},args;
 if(dry){
  const rpc=await createTestProvider(SEPOLIA),provider=new ethers.BrowserProvider(rpc,undefined,{cacheTimeout:-1});
  deployer=await provider.getSigner(0);close=()=>rpc.disconnect();
  args={signerAddress:testAuthority(1).address,revealSigner:testAuthority(1),snapshotWallets:[await (await provider.getSigner(1)).getAddress(),await (await provider.getSigner(2)).getAddress()],
   pendingURI:'ipfs://REHEARSAL/pending.json',metadataBase:'ipfs://REHEARSAL/looks/',revealCommit:revealChain(ethers.keccak256(ethers.toUtf8Bytes('ember-evo-genesis DRY RUN reveal chain'))).anchor,
   recipient:testAuthority(4).address,paidCost:20n*10n**18n,goldCost:1200n,openPaid:true,tokenRecipients:[await (await provider.getSigner(2)).getAddress()]};
 }else{
  const need=k=>{const v=process.env[k];if(!v)throw Error('missing env '+k);return v;};
  const provider=new ethers.JsonRpcProvider(need('RPC_URL'));
  if((await provider.getNetwork()).chainId!==BigInt(SEPOLIA))throw Error('RPC_URL is not Sepolia');
  deployer=new ethers.Wallet(need('DEPLOYER_PRIVATE_KEY'),provider);
  args={signerAddress:need('SIGNER_ADDRESS'),revealSigner:new ethers.Wallet(readFileSync(need('SIGNER_KEY_FILE'),'utf8').trim()),snapshotWallets:JSON.parse(readFileSync(need('SNAPSHOT_FILE'),'utf8')),pendingURI:need('PENDING_URI'),
   metadataBase:need('METADATA_BASE'),revealCommit:need('REVEAL_COMMIT'),recipient:need('PAYMENT_RECIPIENT'),paidCost:BigInt(process.env.PAID_COST??'20')*10n**18n,goldCost:BigInt(process.env.GOLD_COST??'1200'),
   symbol:process.env.SYMBOL??'tEEVO',tokenAddress:process.env.PAYMENT_TOKEN||null,startDelay:Number(process.env.START_DELAY_SECONDS??600),
   openPaid:process.env.OPEN_PAID==='1',tokenRecipients:(process.env.TOKEN_RECIPIENTS??'').split(',').map(s=>s.trim()).filter(Boolean)};
 }
 try{
  const d=await deployRehearsal({deployer,...args,log:(n,h)=>console.log('  ',n,h)});
  const file=fileURLToPath(new URL(`../deployments/${dry?'dryrun-':''}${d.chainId}-${Date.now()}.json`,import.meta.url));
  mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({...d,followUp:followUp(d)},null,1));
  console.log(JSON.stringify({contract:d.contract,token:d.token,eligible:d.eligible,totalGas:d.totalGas,file},null,1));
 }finally{close();}
}
