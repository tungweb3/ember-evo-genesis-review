// Paid-mint approval for Genesis R5 (EMBEO burned + GOLD held in the World book). Two calls:
//  prepare: validate look and chain state, fix the whole order (costs read from the contract), and return the
//           "Ember World GOLD" consent the wallet signs (no gas) plus a ticket so the signer stays stateless.
//  approve: the ticket proves the order came from prepare; the World book holds goldCost after verifying the
//           wallet's consent (GenesisGold.reserve over the service binding); only a 'held' answer gets the two R5
//           signatures. Retrying approve with the same order is safe: the book answers from the stored hold and
//           the signatures are deterministic, so a lost response never holds twice or produces a second order.
import {AbiCoder,Contract,getAddress,keccak256,toUtf8Bytes,verifyTypedData,hexlify,ZeroAddress} from '../vendor/ethers.min.js';
import {lookIdentity,validChoice,CHOICE_RANDOM,LookError} from './look.mjs';
import {ApprovalError,APPEARANCE_TYPES,DOMAIN_NAME,DOMAIN_VERSION,chosenTokenURI} from './free-approval.mjs';

export const BURN='0x000000000000000000000000000000000000dEaD';
export const PAID_TYPES={PaidAuthorization:[{name:'orderId',type:'bytes32'},{name:'wallet',type:'address'},{name:'lookKey',type:'bytes32'},
 {name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},{name:'recipient',type:'address'},{name:'embeoCost',type:'uint256'},
 {name:'goldCost',type:'uint256'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]};
/** Must match the World book (server/genesis-gold.ts GOLD_CONSENT_TYPES / goldConsentDomain). */
export const GOLD_CONSENT_TYPES={GenesisGoldHold:[{name:'orderId',type:'bytes32'},{name:'wallet',type:'address'},{name:'goldCost',type:'uint256'},
 {name:'genesis',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},
 {name:'embeoCost',type:'uint256'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'}]};
export const PAID_READ_ABI=['function appearanceSigner() view returns (address)','function signerEpoch() view returns (uint256)',
 'function mintPaused() view returns (bool)','function snapshotConfigured() view returns (bool)','function paidPriceApproved() view returns (bool)',
 'function paidAvailability() view returns (uint256)','function paidCost() view returns (uint256)','function paidGoldCost() view returns (uint256)',
 'function freeStartAt() view returns (uint256)','function totalMinted() view returns (uint256)','function maxSupply() view returns (uint256)',
 'function skinCount(uint256) view returns (uint256)','function skinCap(uint256) view returns (uint256)','function currentEpoch() view returns (uint256)',
 'function epochRandomCount(uint256) view returns (uint256)','function MAX_RANDOM_PER_EPOCH() view returns (uint256)'];
const ORDER_KEYS=['orderId','wallet','lookKey','choice','uriHash','recipient','embeoCost','goldCost','deadline','signerEpoch'];
const fail=(code,status=409)=>{throw new ApprovalError(code,status);};
const enc=new TextEncoder();
const hexOf=buf=>'0x'+[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
function wallet(v){if(typeof v!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(v))fail('WALLET_INVALID',400);let a;try{a=getAddress(v);}catch{fail('WALLET_INVALID',400);}if(a===ZeroAddress)fail('WALLET_INVALID',400);return a;}

export class PaidApprovalSigner{
 /** gold: the GenesisGold binding ({reserve,order,reconcile}); deploymentId: this deployment's id in the book's registry.
  *  ticketSecret: random secret of this Worker (HMAC for prepared orders). ttlSeconds: at most the book's 900 s. */
 constructor({provider,contractAddress,chainId,signer,metadataBase,gold,deploymentId,ticketSecret,ttlSeconds=600,randomBytes}){
  if(!Number.isSafeInteger(chainId)||chainId<1)fail('CONFIG_CHAIN_ID',500);
  if(typeof metadataBase!=='string'||!/^(ipfs|ar|https):\/\/[^\s]{1,200}\/$/.test(metadataBase))fail('CONFIG_METADATA_BASE',500);
  if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<120||ttlSeconds>900)fail('CONFIG_TTL',500);
  if(typeof ticketSecret!=='string'||ticketSecret.length<32)fail('CONFIG_TICKET_SECRET',500);
  if(!gold||typeof gold.reserve!=='function'||typeof deploymentId!=='string'||!deploymentId)fail('CONFIG_GOLD_BINDING',500);
  this.contractAddress=wallet(contractAddress);this.chainId=chainId;this.signer=signer;this.metadataBase=metadataBase;this.ttl=ttlSeconds;
  this.gold=gold;this.deploymentId=deploymentId;this.provider=provider;this.contract=new Contract(this.contractAddress,PAID_READ_ABI,provider);
  this.randomBytes=randomBytes??(n=>crypto.getRandomValues(new Uint8Array(n)));
  this.domain={name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId,verifyingContract:this.contractAddress};
  this.consentDomain={name:'Ember World GOLD',version:'1',chainId};
  this.keyPromise=crypto.subtle.importKey('raw',enc.encode(ticketSecret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 }
 async ticket(order){return hexOf(await crypto.subtle.sign('HMAC',await this.keyPromise,enc.encode(JSON.stringify([this.deploymentId,this.chainId,this.contractAddress,ORDER_KEYS.map(k=>order[k])]))));}
 consentMessage(o){return {...o,genesis:this.contractAddress};}

 /** Request {wallet, look, choice}. Returns the order, the consent typed data for the wallet, and a ticket. */
 async prepare(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join()!=='choice,look,wallet')fail('REQUEST_FIELDS_INVALID',400);
  const minter=wallet(request.wallet);
  let id,choice;try{id=lookIdentity(request.look);choice=validChoice(request.choice);}catch(e){if(e instanceof LookError)fail(e.code,400);throw e;}
  // R6: looks may repeat, so there is no look availability check here (or on chain)
  const c=this.contract;
  const [signerOnChain,epoch,paused,configured,priceApproved,available,embeoCost,goldCost,startAt,minted,max,block]=await Promise.all([
   c.appearanceSigner(),c.signerEpoch(),c.mintPaused(),c.snapshotConfigured(),c.paidPriceApproved(),c.paidAvailability(),c.paidCost(),c.paidGoldCost(),
   c.freeStartAt(),c.totalMinted(),c.maxSupply(),this.provider.getBlock('latest')]);
  if(getAddress(signerOnChain)!==getAddress(this.signer.address))fail('SIGNER_NOT_ACTIVE',503);
  if(!configured)fail('MINT_NOT_READY',503);
  if(paused)fail('MINT_PAUSED',503);
  if(!priceApproved||available===0n)fail('PAID_NOT_AVAILABLE');
  if(BigInt(block.timestamp)<startAt)fail('SALE_NOT_STARTED');
  if(minted>=max)fail('SOLD_OUT');
  let uri='';
  if(choice===CHOICE_RANDOM){
   const [ep,cap]=await Promise.all([c.currentEpoch(),c.MAX_RANDOM_PER_EPOCH()]);if(await c.epochRandomCount(ep)>=cap)fail('EPOCH_RANDOM_FULL');
  }else{
   const [count,cap]=await Promise.all([c.skinCount(choice),c.skinCap(choice)]);if(count>=cap)fail('SKIN_SOLD_OUT');
   uri=chosenTokenURI(this.metadataBase,id.lookKey,choice);
  }
  const order={orderId:hexlify(this.randomBytes(32)),wallet:minter.toLowerCase(),lookKey:id.lookKey,choice,uriHash:keccak256(toUtf8Bytes(uri)),
   recipient:BURN.toLowerCase(),embeoCost:embeoCost.toString(),goldCost:goldCost.toString(),deadline:String(block.timestamp+this.ttl),signerEpoch:epoch.toString()};
  return {route:'paid',chainId:this.chainId,contract:this.contractAddress,deploymentId:this.deploymentId,order,uri,ticket:await this.ticket(order),
   consent:{domain:this.consentDomain,types:GOLD_CONSENT_TYPES,primaryType:'GenesisGoldHold',message:this.consentMessage(order)},
   canonical:id.canonical,catalogueVersion:id.catalogueVersion};
 }

 /** Request {order, uri, ticket, consentSignature}. Holds GOLD (once), then returns the exact mintPaid arguments. */
 async approve(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join()!=='consentSignature,order,ticket,uri')fail('REQUEST_FIELDS_INVALID',400);
  const {order,uri,ticket,consentSignature}=request;
  if(!order||typeof order!=='object'||Object.keys(order).sort().join()!==[...ORDER_KEYS].sort().join())fail('REQUEST_FIELDS_INVALID',400);
  if(typeof ticket!=='string'||ticket!==await this.ticket(order))fail('ORDER_TICKET_INVALID',400);
  if(typeof uri!=='string'||keccak256(toUtf8Bytes(uri))!==order.uriHash)fail('ORDER_TICKET_INVALID',400);
  if(typeof consentSignature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(consentSignature))fail('INVALID_GOLD_CONSENT',400);
  // Fail early with the wallet's own words: the book verifies the same signature again before holding anything.
  let consenter;try{consenter=verifyTypedData(this.consentDomain,GOLD_CONSENT_TYPES,this.consentMessage(order),consentSignature);}catch{fail('INVALID_GOLD_CONSENT',400);}
  if(consenter.toLowerCase()!==order.wallet)fail('INVALID_GOLD_CONSENT',400);
  let held;
  try{held=await this.gold.reserve({deploymentId:this.deploymentId,order,consentSignature});}
  catch(e){const code=typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'GOLD_UNAVAILABLE';
   fail(code,['GOLD_UNAVAILABLE','GOLD_NOT_CONFIGURED'].includes(code)?503:409);}
  if(held.state!=='held')fail(held.state==='consumed'?'ORDER_ALREADY_MINTED':'ORDER_RELEASED');
  const signer=this.signer,w=getAddress(order.wallet);
  const appearance={wallet:w,lookKey:order.lookKey,choice:order.choice,uriHash:order.uriHash,deadline:order.deadline,signerEpoch:order.signerEpoch,paid:true};
  const auth={...order,wallet:w,recipient:BURN};
  const [signature,goldSignature]=await Promise.all([signer.signTypedData(this.domain,APPEARANCE_TYPES,appearance),signer.signTypedData(this.domain,PAID_TYPES,auth)]);
  for(const [types,value,sig] of [[APPEARANCE_TYPES,appearance,signature],[PAID_TYPES,auth,goldSignature]])
   if(getAddress(verifyTypedData(this.domain,types,value,sig))!==getAddress(signer.address))fail('SIGNATURE_SELF_CHECK_FAILED',500);
  return {route:'paid',chainId:this.chainId,contract:this.contractAddress,orderId:order.orderId,
   mintPaid:{lookKey:order.lookKey,choice:order.choice,uri,deadline:order.deadline,signature,expectedRecipient:BURN,expectedCost:order.embeoCost,order:auth,goldSignature},
   gold:{state:held.state,book:held.book,reserved:held.reserved,available:held.available}};
 }
}
