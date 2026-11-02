// Safe Transaction Builder files for the owner steps after the mainnet deployment (deploy-mainnet.mjs leaves the Safe as
// pendingOwner and minting paused). Load the file in app.safe.global -> Apps -> Transaction Builder -> drag & drop, check
// the decoded calls (the app does not check a file's chain: have the Safe open on Ethereum), then two owners sign and one
// executes. Nothing here signs or sends; every mode reads the chain first
// (READ_RPC_URL, default a public mainnet RPC).
//   node contract/tools/safe-batch.mjs status <deployment record>
//       Prints who owns the contract and whether it is opened. Until owner is the Safe, the deployer key still has every owner power.
//   node contract/tools/safe-batch.mjs accept <deployment record>
//       acceptOwnership(): the Safe becomes the owner (do this right after the deployment).
//   node contract/tools/safe-batch.mjs open <deployment record> <snapshot wallets json> <snapshot time> <opening time> --sample-look=<lookKey>/<skin> [--far-opening]
//       setRevealURIs(locked) + configureSnapshot(root, count, takenAt, start) + setMintPaused(false), as one batch. Times are
//       unix seconds or ISO dates with a zone (2026-11-20T20:00:00+08:00). Free and paid minting both start at the opening
//       time; the URIs lock here and the snapshot can be set only once, so the host must be live, the opening time right and the
//       wallet list final when this batch executes. --sample-look names a look the metadata host already serves: the base URI
//       plus it must answer with JSON before the URIs lock. An opening more than 60 days ahead needs --far-opening.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {ethers} from './runtime.mjs';
import {reportFailure} from './tool-errors.mjs';
import {snapshotTree} from '../../signer/free-approval.mjs';

const I=new ethers.Interface(['function acceptOwnership()','function setRevealURIs(string pending,string base,bool lock)',
 'function configureSnapshot(bytes32 root,uint256 eligible,uint256 takenAt,uint256 start)','function setMintPaused(bool paused)']);
const READ=['function owner() view returns (address)','function pendingOwner() view returns (address)','function snapshotConfigured() view returns (bool)',
 'function mintPaused() view returns (bool)','function revealURIsLocked() view returns (bool)','function pendingURI() view returns (string)','function revealBaseURI() view returns (string)',
 'function revealCommit() view returns (bytes32)','function appearanceSigner() view returns (address)','function pendingAppearanceSigner() view returns (address)','function maxSupply() view returns (uint256)',
 'function skinCap(uint256) view returns (uint256)','function paidPriceApproved() view returns (bool)',
 'event PaymentTokenAdded(address indexed token,uint256 amount,uint256 goldCost,uint256 usableAt)'];
const SKIN_CAPS='1068,218,218,68,68,48';
const DAY=86400;
export const MAX_OPENING_AHEAD=60*DAY;
const WORKER_LIST=fileURLToPath(new URL('../../signer/snapshot-wallets.json',import.meta.url));
const PUBLIC_RPC='https://ethereum-rpc.publicnode.com';
// 10 digits are unix seconds until the year 2286: an extra digit is a typo (Swarm audit 90ae2f92 finding 3)
export const unix=v=>{if(/^\d{10}$/.test(String(v)))return Number(v);if(!/(Z|[+-]\d\d:\d\d)$/.test(String(v)))throw Error('give a unix time or an ISO date with a zone: '+v);
 const t=Date.parse(v);if(!Number.isFinite(t))throw Error('bad date '+v);return Math.floor(t/1000);};

// apps/tx-builder/src/lib/checksum.ts of safe-global/safe-react-apps: keys sorted, meta.name nulled, keccak256 of the string
const serialize=json=>{
 if(Array.isArray(json))return `[${json.map(serialize).join(',')}]`;
 if(typeof json==='object'&&json!==null){const keys=Object.keys(json).sort();return `{${JSON.stringify(keys)}${keys.map(k=>serialize(json[k])+',').join('')}}`;}
 return JSON.stringify(json===undefined?null:json);
};
export const batchChecksum=file=>ethers.keccak256(ethers.toUtf8Bytes(serialize({...file,meta:{...file.meta,name:null}})));

// The app shows decoded calls only when data is empty and contractMethod is set (Swarm audit 90ae2f92 finding 9)
function builderTx(to,fn,args){
 const f=I.getFunction(fn);
 return {to,value:'0',data:null,contractMethod:{inputs:f.inputs.map(p=>({internalType:p.type,name:p.name,type:p.type})),name:f.name,payable:false},
  contractInputsValues:Object.fromEntries(f.inputs.map((p,i)=>[p.name,String(args[i])]))};
}
/** The calldata the app encodes from a builder transaction. */
export const calldataOf=t=>I.encodeFunctionData(t.contractMethod.name,t.contractMethod.inputs.map(p=>{const v=t.contractInputsValues[p.name];return p.type==='bool'?v==='true':v;}));
export function builderFile(d,name,description,calls){
 const file={version:'1.0',chainId:String(d.chainId),createdAt:Date.now(),
  meta:{name,description,txBuilderVersion:'1.16.5',createdFromSafeAddress:d.safe,createdFromOwnerAddress:''},
  transactions:calls.map(([fn,args])=>builderTx(d.contract,fn,args))};
 return {...file,meta:{...file.meta,checksum:batchChecksum(file)}};
}
export function acceptBatch(d){return builderFile(d,'EmberEvoGenesis: accept ownership','acceptOwnership() on '+d.contract,[['acceptOwnership',[]]]);}
export function openBatch(d,wallets,takenAt,start,now=Math.floor(Date.now()/1000),{farOpening=false,lockUris=true}={}){
 const tree=snapshotTree(wallets);
 if(tree.count>Number(d.maxSupply))throw Error('SNAPSHOT_CAPACITY');
 if(!(takenAt>0&&takenAt<=now))throw Error('the snapshot time must be in the past');
 // the Safe needs time to collect two signatures; the contract refuses a start already passed when the batch executes
 if(!(start>=now+6*3600&&start>=takenAt))throw Error('the opening time must be at least 6 hours from now');
 // freeStartAt has no setter and the snapshot is once only: a wrong year would leave the collection unmintable for good
 if(!farOpening&&(start>now+MAX_OPENING_AHEAD||takenAt<now-MAX_OPENING_AHEAD))throw Error('a time more than 60 days from now: check it, or pass --far-opening');
 if(lockUris&&(!d.pendingURI||!d.metadataBase))throw Error('the record has no metadata URIs');
 const usdc=d.paymentTokens?.[1]?.usableAt;
 const warnings=usdc&&start<usdc?['USDC is usable only from '+new Date(usdc*1000).toISOString()+': before that only imdUSD works']:[];
 const calls=[['configureSnapshot',[tree.root,tree.count,takenAt,start]],['setMintPaused',[false]]];
 if(lockUris)calls.unshift(['setRevealURIs',[d.pendingURI,d.metadataBase,true]]);
 return {tree,warnings,file:builderFile(d,'EmberEvoGenesis: free list + open',
  `${lockUris?`setRevealURIs(${d.pendingURI}, ${d.metadataBase}, locked) + `:''}configureSnapshot(${tree.root}, ${tree.count}, ${takenAt}, ${start}) + setMintPaused(false). Opening ${new Date(start*1000).toISOString()}`,
  calls)};
}

// a public RPC may answer one read from a node that has not seen the contract yet: that read is asked again, not the whole state
const steady=async read=>{let last;for(let i=0;i<5;i++){try{return await read();}catch(e){last=e;await new Promise(r=>setTimeout(r,1000));}}throw last;};
/** What the chain says now; the batch files are built from the record, which cannot see what the deployer key did since (finding 6). */
export async function chainState(provider,d){
 const g=new ethers.Contract(d.contract,READ,provider),q=(fn,...a)=>steady(()=>g[fn](...a));
 const chainId=await provider.send('eth_chainId',[]);
 if(BigInt(chainId)!==BigInt(d.chainId))throw Error('the read RPC is on another chain');
 const [owner,pendingOwner,snapshotConfigured,mintPaused,revealURIsLocked,pendingURI,revealBaseURI]=await Promise.all(['owner','pendingOwner','snapshotConfigured','mintPaused','revealURIsLocked','pendingURI','revealBaseURI'].map(fn=>q(fn)));
 const [revealCommit,signer,pendingSigner,maxSupply,paidPriceApproved,...caps]=await Promise.all([...['revealCommit','appearanceSigner','pendingAppearanceSigner','maxSupply','paidPriceApproved'].map(fn=>q(fn)),...[0,1,2,3,4,5].map(i=>q('skinCap',i))]);
 // the count is private on chain, so the events tell it; an RPC may refuse the range, which must not hide that it went unchecked
 const extraTokens=await g.queryFilter('PaymentTokenAdded',d.startBlock??0).then(l=>String(l.length)).catch(()=>null);
 if(extraTokens===null)console.warn('could not read the PaymentTokenAdded logs: check on Etherscan that only USDC was added');
 return {owner:ethers.getAddress(owner),pendingOwner:ethers.getAddress(pendingOwner),snapshotConfigured,mintPaused,revealURIsLocked,pendingURI,revealBaseURI,
  revealCommit,signer:ethers.getAddress(signer),pendingSigner:ethers.getAddress(pendingSigner),maxSupply:maxSupply.toString(),extraTokens,paidPriceApproved,skinCaps:caps.join(',')};
}
/** What the deployer key could still change after the record was written. */
export function checkRecord(s,d){
 const bad=[];
 if(s.revealCommit.toLowerCase()!==d.revealCommit.toLowerCase())bad.push('revealCommit');
 if(s.signer!==ethers.getAddress(d.signer))bad.push('signer');
 if(s.pendingSigner!==ethers.ZeroAddress)bad.push('pendingSigner');
 if(s.maxSupply!==String(d.maxSupply))bad.push('maxSupply');
 if(s.skinCaps!==SKIN_CAPS)bad.push('skinCaps');
 if(s.extraTokens!==null&&s.extraTokens!=='1')bad.push('extraTokens');
 if(!s.paidPriceApproved)bad.push('paidPriceApproved');
 if(bad.length)throw Error('CHAIN_DIFFERS_FROM_RECORD '+bad.join(',')+': the deployer key changed the contract, stop and check');
}
export function checkAccept(s,d){
 const safe=ethers.getAddress(d.safe);
 if(s.owner===safe)throw Error('ALREADY_ACCEPTED the Safe is already the owner');
 if(s.pendingOwner!==safe)throw Error('NOT_PENDING_SAFE pendingOwner is '+s.pendingOwner+', not the Safe: the deployer key changed it, stop and check');
 if(s.snapshotConfigured||!s.mintPaused||s.pendingURI!==d.pendingURI||s.revealBaseURI!==d.metadataBase)throw Error('CHAIN_DIFFERS_FROM_RECORD free list, pause or metadata URIs: the deployer key changed the contract, stop and check');
 checkRecord(s,d);
}
/** Returns whether the batch must lock the URIs. */
export function checkOpen(s,d){
 const safe=ethers.getAddress(d.safe);
 if(s.owner!==safe)throw Error('NOT_OWNER the owner is '+s.owner+', not the Safe: the Safe must accept first');
 if(s.snapshotConfigured)throw Error('SNAPSHOT_ALREADY_SET the free list was set outside this tool: stop and check');
 if(!s.mintPaused)throw Error('ALREADY_OPEN minting is not paused');
 if(s.pendingURI!==d.pendingURI||s.revealBaseURI!==d.metadataBase)throw Error('URIS_CHANGED the chain holds other metadata URIs than the record: stop and check');
 checkRecord(s,d);
 return !s.revealURIsLocked;
}
/** The Worker bundles this list: a different root fails every free approval after the opening (finding 7). */
export function checkWorkerList(tree,file=WORKER_LIST){
 const root=snapshotTree(JSON.parse(readFileSync(file,'utf8'))).root;
 if(root!==tree.root)throw Error(`WORKER_LIST_DIFFERS signer/snapshot-wallets.json has root ${root}, this batch ${tree.root}: copy the list written next to the record there, deploy the signer Worker, run this again`);
}
/** The URI locks for good in this batch: the host must already answer with JSON. */
export async function checkPendingServed(uri,fetchImpl=fetch){
 let r;try{r=await fetchImpl(uri);}catch{throw Error('PENDING_URI_NOT_SERVED '+uri);}
 if(!r.ok)throw Error('PENDING_URI_NOT_SERVED '+uri+' answered '+r.status);
 try{await r.json();}catch{throw Error('PENDING_URI_NOT_JSON '+uri);}
}
/** A token's URI is the base plus lookKey/skin: one the host should already serve must answer before the base locks (Swarm audit 90ae2f92 finding 5). */
export async function checkSampleServed(base,sample,fetchImpl=fetch){
 if(!/^[^\s/?#]+\/\d+$/.test(sample??''))throw Error('SAMPLE_LOOK_REQUIRED the URIs lock in this batch: pass --sample-look=<lookKey>/<skin> of a look the metadata host already serves');
 const uri=base+sample;let r;try{r=await fetchImpl(uri);}catch{throw Error('SAMPLE_LOOK_NOT_SERVED '+uri);}
 if(!r.ok)throw Error('SAMPLE_LOOK_NOT_SERVED '+uri+' answered '+r.status);
 try{await r.json();}catch{throw Error('SAMPLE_LOOK_NOT_JSON '+uri);}
}
/** A listed address with contract code (other than an EIP-7702 wallet) holds a free slot nobody can use. */
export async function contractWallets(provider,wallets){
 const found=[];
 for(let i=0;i<wallets.length;i+=20)await Promise.all(wallets.slice(i,i+20).map(async w=>{const c=await steady(()=>provider.getCode(w));if(c!=='0x'&&!c.startsWith('0xef0100'))found.push(w);}));
 return found.sort();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const all=process.argv.slice(2),farOpening=all.includes('--far-opening'),sample=all.find(a=>a.startsWith('--sample-look='))?.slice(14),[mode,recordFile,...rest]=all.filter(a=>!a.startsWith('--'));
  const d=JSON.parse(readFileSync(resolve(recordFile),'utf8'));
  if(!d.safe||!ethers.isAddress(d.contract))throw Error('not a mainnet deployment record');
  const base=resolve(recordFile).replace(/\.json$/,'');
  if(d.chainId!==1&&!process.env.READ_RPC_URL)throw Error('this record is not on mainnet: set READ_RPC_URL');
  if(mode!=='status'&&d.readBackMismatch?.length)throw Error('RECORD_HAS_MISMATCH '+d.readBackMismatch.join(',')+': this deployment read back wrong values, no Safe file until it is checked');
  const provider=new ethers.JsonRpcProvider(process.env.READ_RPC_URL?.trim()||PUBLIC_RPC,d.chainId,{staticNetwork:true});
  // a public RPC may answer from a node that has not seen the last block: a refusal must hold for a while before it counts
  const holds=async check=>{let last;for(let i=0;i<10;i++){try{return check(await chainState(provider,d));}catch(e){last=e;await new Promise(r=>setTimeout(r,3000));}}throw last;};
  if(mode==='status'){
   const s=await holds(x=>x);
   console.log(JSON.stringify({...s,ownerIsSafe:s.owner===ethers.getAddress(d.safe),next:s.owner===ethers.getAddress(d.safe)?'done: the deployer key has no owner power left':'the Safe must sign acceptOwnership: until then the deployer key has every owner power'},null,1));
  }else if(mode==='accept'){
   await holds(s=>checkAccept(s,d));
   writeFileSync(base+'.safe-accept.json',JSON.stringify(acceptBatch(d),null,1));console.log('wrote',base+'.safe-accept.json');
  }else if(mode==='open'){
   const [walletsFile,taken,start]=rest;const wallets=JSON.parse(readFileSync(resolve(walletsFile),'utf8'));
   const lockUris=await holds(s=>checkOpen(s,d));
   const takenAt=unix(taken),startAt=unix(start),o=openBatch(d,wallets,takenAt,startAt,undefined,{farOpening,lockUris});
   // the signer Worker serves free approvals from the same list (same order of dedupe + sort as the root above)
   const list=[...new Set(wallets.map(w=>ethers.getAddress(w).toLowerCase()))].sort();
   // named by its root, so a later run cannot leave a list and a batch that disagree
   const listFile=`${base}.snapshot-wallets-${o.tree.root.slice(2,10)}.json`;
   writeFileSync(listFile,JSON.stringify(list,null,1));console.log('wrote',listFile);
   checkWorkerList(o.tree);
   if(lockUris){await checkPendingServed(d.pendingURI);await checkSampleServed(d.metadataBase,sample);}
   const withCode=await contractWallets(provider,list);
   if(withCode.length)o.warnings.push('listed addresses with contract code hold a free slot nobody can use: '+withCode.join(', '));
   // the last sanity check before a once-only call: the owner reads the date and types it
   const iso=new Date(startAt*1000).toISOString().slice(0,16);
   console.log(JSON.stringify({root:o.tree.root,eligible:o.tree.count,listed:wallets.length,warnings:o.warnings,snapshotTaken:new Date(takenAt*1000).toISOString(),openingUTC:iso},null,1));
   const rl=createInterface({input:process.stdin,output:process.stdout});
   const confirm=`${iso} ${o.tree.count}`;
   const typed=(await rl.question(`Minting opens at ${iso} UTC with ${o.tree.count} wallets on the free list, and neither can ever change. Type "${confirm}" to write the batch: `)).trim();rl.close();
   if(typed!==confirm)throw Error('the date and count do not match: nothing was written');
   writeFileSync(base+'.safe-open.json',JSON.stringify(o.file,null,1));console.log('wrote',base+'.safe-open.json');
  }else throw Error('usage: safe-batch.mjs status <record> | accept <record> | open <record> <wallets.json> <snapshot time> <opening time> --sample-look=<lookKey>/<skin> [--far-opening]');
 }catch(e){reportFailure(e);}
}
