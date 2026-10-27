// Free-mint approval signer for Genesis R5. Checks a request against the shared look rules and the live contract
// state, then signs the EIP-712 Appearance the contract verifies in mintFree. The chain checks only save the wallet a
// failing transaction; the contract re-checks everything and stays the authority.
import {AbiCoder,Contract,getAddress,keccak256,concat,toUtf8Bytes,verifyTypedData,ZeroAddress} from '../vendor/ethers.min.js';
import {lookIdentity,validChoice,CHOICE_RANDOM,LookError} from './look.mjs';

export const DOMAIN_NAME='EmberEvoGenesisCandidate',DOMAIN_VERSION='7';   // 7: Appearance names its route (audit 2026-10-27)
export const APPEARANCE_TYPES={Appearance:[{name:'wallet',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},
 {name:'uriHash',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'},{name:'paid',type:'bool'}]};
export const READ_ABI=['function appearanceSigner() view returns (address)','function signerEpoch() view returns (uint256)',
 'function mintPaused() view returns (bool)','function snapshotConfigured() view returns (bool)','function snapshotRoot() view returns (bytes32)',
 'function totalMinted() view returns (uint256)','function maxSupply() view returns (uint256)','function freeClaimed(uint256) view returns (bool)',
 'function freeMinted() view returns (uint256)','function eligibleWalletCount() view returns (uint256)','function freeStartAt() view returns (uint256)',
 'function skinCount(uint256) view returns (uint256)','function skinCap(uint256) view returns (uint256)','function currentEpoch() view returns (uint256)',
 'function epochRandomCount(uint256) view returns (uint256)','function MAX_RANDOM_PER_EPOCH() view returns (uint256)'];
const coder=AbiCoder.defaultAbiCoder();

export class ApprovalError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new ApprovalError(code,status);};

function wallet(value){
 if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))fail('WALLET_INVALID',400);
 let out;try{out=getAddress(value);}catch{fail('WALLET_INVALID',400);}
 if(out===ZeroAddress)fail('WALLET_INVALID',400);return out;
}

/** Free-mint Merkle tree: leaf = keccak256(keccak256(abi.encode(index, wallet))), sorted pairs, an odd node is promoted.
 *  Wallets are unique and in ascending lowercase-address order, and index is a wallet's position in that order: the
 *  contract keeps one claimed bit per index (gas review 2026-10-28). The owner passes this root to configureSnapshot. */
export function snapshotTree(wallets){
 const list=[...new Set(wallets.map(w=>wallet(w).toLowerCase()))].sort();
 const leaves=list.map((w,i)=>keccak256(keccak256(coder.encode(['uint256','address'],[i,w]))));
 if(!leaves.length)fail('SNAPSHOT_EMPTY',500);
 const layers=[leaves];
 while(layers.at(-1).length>1){const prev=layers.at(-1),next=[];
  for(let i=0;i<prev.length;i+=2)next.push(i+1===prev.length?prev[i]:keccak256(concat([prev[i],prev[i+1]].sort())));layers.push(next);}
 const index=new Map(list.map((w,i)=>[w,i]));
 return {root:layers.at(-1)[0],count:list.length,
  /** The wallet's index in the list, or null when it is not on it. */
  indexOf(w){return index.get(String(w).toLowerCase())??null;},
  proof(w){let i=index.get(w.toLowerCase());if(i===undefined)return null;const out=[];
   for(let level=0;level<layers.length-1;level++){const sibling=i^1;if(sibling<layers[level].length)out.push(layers[level][sibling]);i=Math.floor(i/2);}return out;}};
}

/** URI of a chosen-skin token: same layout as a revealed random token (revealBaseURI + lookKey hex + "/" + skin index). */
export function chosenTokenURI(metadataBase,lookKey,choice){return metadataBase+lookKey+'/'+choice;}

export class FreeApprovalSigner{
 /** provider: ethers provider; signer: ethers Wallet holding the appearance key; snapshotWallets: the free-mint list
  *  (or tree: a prebuilt snapshotTree, so a Worker can build it once and still make a new provider per request). */
 constructor({provider,contractAddress,chainId,signer,metadataBase,snapshotWallets,tree=null,ttlSeconds=300}){
  if(!Number.isSafeInteger(chainId)||chainId<1)fail('CONFIG_CHAIN_ID',500);
  if(typeof metadataBase!=='string'||!/^(ipfs|ar|https):\/\/[^\s]{1,200}\/$/.test(metadataBase))fail('CONFIG_METADATA_BASE',500);
  if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>900)fail('CONFIG_TTL',500);
  this.contractAddress=wallet(contractAddress);this.chainId=chainId;this.signer=signer;this.metadataBase=metadataBase;this.ttl=ttlSeconds;
  this.contract=new Contract(this.contractAddress,READ_ABI,provider);this.provider=provider;this.tree=tree??snapshotTree(snapshotWallets);
  this.domain={name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId,verifyingContract:this.contractAddress};
 }
 /** Public sale counter for the mint page. */
 async stats(){
  const [minted,max]=await Promise.all([this.contract.totalMinted(),this.contract.maxSupply()]);
  return {totalMinted:Number(minted),maxSupply:Number(max)};
 }
 /** Request: {wallet}. Whether the wallet is on the free-mint list and has already used it (the list is public). */
 async eligibility(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).join()!=='wallet')fail('REQUEST_FIELDS_INVALID',400);
  const minter=wallet(request.wallet),index=this.tree.indexOf(minter),eligible=index!==null;
  return {wallet:minter,eligible,freeClaimed:eligible?await this.contract.freeClaimed(index):false};
 }
 /** Request: {wallet, look, choice}. Returns the exact mintFree arguments plus what they bind. */
 async approve(request){
  if(!request||typeof request!=='object'||Array.isArray(request))fail('REQUEST_INVALID',400);
  const keys=Object.keys(request).sort();if(keys.join()!=='choice,look,wallet')fail('REQUEST_FIELDS_INVALID',400);
  const minter=wallet(request.wallet);
  let id,choice;
  try{id=lookIdentity(request.look);choice=validChoice(request.choice);}catch(e){if(e instanceof LookError)fail(e.code,400);throw e;}
  const proof=this.tree.proof(minter),index=this.tree.indexOf(minter);if(!proof)fail('NOT_IN_SNAPSHOT',403);
  // R6: looks may repeat, so there is no look availability check here (or on chain)
  const c=this.contract;
  const [signerOnChain,epoch,paused,configured,root,minted,max,claimed,freeMinted,eligible,startAt,block]=await Promise.all([
   c.appearanceSigner(),c.signerEpoch(),c.mintPaused(),c.snapshotConfigured(),c.snapshotRoot(),c.totalMinted(),c.maxSupply(),c.freeClaimed(index),
   c.freeMinted(),c.eligibleWalletCount(),c.freeStartAt(),this.provider.getBlock('latest')]);
  if(getAddress(signerOnChain)!==getAddress(this.signer.address))fail('SIGNER_NOT_ACTIVE',503);
  if(!configured)fail('MINT_NOT_READY',503);
  if(root!==this.tree.root)fail('SNAPSHOT_MISMATCH',503);
  if(paused)fail('MINT_PAUSED',503);
  if(BigInt(block.timestamp)<startAt)fail('SALE_NOT_STARTED');
  if(minted>=max)fail('SOLD_OUT');
  if(claimed)fail('FREE_ALREADY_CLAIMED');
  if(freeMinted>=eligible)fail('FREE_ALLOCATION_USED');
  let uri='';
  if(choice===CHOICE_RANDOM){
   const [ep,cap]=await Promise.all([c.currentEpoch(),c.MAX_RANDOM_PER_EPOCH()]);
   if(await c.epochRandomCount(ep)>=cap)fail('EPOCH_RANDOM_FULL');
  }else{
   const [count,cap]=await Promise.all([c.skinCount(choice),c.skinCap(choice)]);
   if(count>=cap)fail('SKIN_SOLD_OUT');
   uri=chosenTokenURI(this.metadataBase,id.lookKey,choice);
  }
  const deadline=block.timestamp+this.ttl;
  const value={wallet:minter,lookKey:id.lookKey,choice,uriHash:keccak256(toUtf8Bytes(uri)),deadline,signerEpoch:epoch,paid:false};
  const signature=await this.signer.signTypedData(this.domain,APPEARANCE_TYPES,value);
  if(getAddress(verifyTypedData(this.domain,APPEARANCE_TYPES,value,signature))!==getAddress(this.signer.address))fail('SIGNATURE_SELF_CHECK_FAILED',500);
  return {route:'free',chainId:this.chainId,contract:this.contractAddress,wallet:minter,
   mintFree:{lookKey:id.lookKey,choice,uri,deadline,signature,index,proof},
   signerEpoch:epoch.toString(),canonical:id.canonical,catalogueVersion:id.catalogueVersion,look:id.look};
 }
}
