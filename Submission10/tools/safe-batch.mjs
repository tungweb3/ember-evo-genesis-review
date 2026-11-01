// Safe Transaction Builder files for the owner steps after the mainnet deployment (deploy-mainnet.mjs leaves the Safe as
// pendingOwner and minting paused). Load the file in app.safe.global -> Apps -> Transaction Builder -> drag & drop, check
// the decoded calls, then two owners sign and one executes. Nothing here signs or sends.
//   node contract/tools/safe-batch.mjs accept <deployment record>
//       acceptOwnership(): the Safe becomes the owner (do this right after the deployment).
//   node contract/tools/safe-batch.mjs open <deployment record> <snapshot wallets json> <snapshot time> <opening time>
//       configureSnapshot(root, count, takenAt, start) + setMintPaused(false), as one batch. Times are unix seconds or
//       ISO dates with a zone (2026-11-20T20:00:00+08:00). Free and paid minting both start at the opening time; the
//       snapshot can be set only once, so the wallet list is final when this batch executes.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ethers} from './runtime.mjs';
import {snapshotTree} from '../../signer/free-approval.mjs';

const I=new ethers.Interface(['function acceptOwnership()','function configureSnapshot(bytes32 root,uint256 eligible,uint256 takenAt,uint256 start)','function setMintPaused(bool paused)']);
const unix=v=>{if(/^\d{9,11}$/.test(String(v)))return Number(v);if(!/(Z|[+-]\d\d:\d\d)$/.test(String(v)))throw Error('give a unix time or an ISO date with a zone: '+v);
 const t=Date.parse(v);if(!Number.isFinite(t))throw Error('bad date '+v);return Math.floor(t/1000);};

export function builderFile(d,name,description,calls){
 return {version:'1.0',chainId:String(d.chainId),createdAt:Date.now(),
  meta:{name,description,txBuilderVersion:'1.16.5',createdFromSafeAddress:d.safe,createdFromOwnerAddress:''},
  transactions:calls.map(([fn,args])=>({to:d.contract,value:'0',data:I.encodeFunctionData(fn,args),contractMethod:null,contractInputsValues:null}))};
}
export function acceptBatch(d){return builderFile(d,'EmberEvoGenesis: accept ownership','acceptOwnership() on '+d.contract,[['acceptOwnership',[]]]);}
export function openBatch(d,wallets,takenAt,start,now=Math.floor(Date.now()/1000)){
 const tree=snapshotTree(wallets);
 if(tree.count>Number(d.maxSupply))throw Error('SNAPSHOT_CAPACITY');
 if(!(takenAt>0&&takenAt<=now))throw Error('the snapshot time must be in the past');
 // the Safe needs time to collect two signatures; the contract refuses a start already passed when the batch executes
 if(!(start>=now+6*3600&&start>=takenAt))throw Error('the opening time must be at least 6 hours from now');
 const usdc=d.paymentTokens?.[1]?.usableAt;
 const warnings=usdc&&start<usdc?['USDC is usable only from '+new Date(usdc*1000).toISOString()+': before that only imdUSD works']:[];
 return {tree,warnings,file:builderFile(d,'EmberEvoGenesis: free list + open',
  `configureSnapshot(${tree.root}, ${tree.count}, ${takenAt}, ${start}) + setMintPaused(false). Opening ${new Date(start*1000).toISOString()}`,
  [['configureSnapshot',[tree.root,tree.count,takenAt,start]],['setMintPaused',[false]]])};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,recordFile,...rest]=process.argv.slice(2);
 const d=JSON.parse(readFileSync(resolve(recordFile),'utf8'));
 if(!d.safe||!ethers.isAddress(d.contract))throw Error('not a mainnet deployment record');
 const base=resolve(recordFile).replace(/\.json$/,'');
 if(mode==='accept'){writeFileSync(base+'.safe-accept.json',JSON.stringify(acceptBatch(d),null,1));console.log('wrote',base+'.safe-accept.json');}
 else if(mode==='open'){
  const [walletsFile,taken,start]=rest;const wallets=JSON.parse(readFileSync(resolve(walletsFile),'utf8'));
  const o=openBatch(d,wallets,unix(taken),unix(start));
  writeFileSync(base+'.safe-open.json',JSON.stringify(o.file,null,1));
  // the signer Worker serves free approvals from the same list (same order of dedupe + sort as the root above)
  writeFileSync(base+'.snapshot-wallets.json',JSON.stringify([...new Set(wallets.map(w=>ethers.getAddress(w).toLowerCase()))].sort(),null,1));
  console.log(JSON.stringify({root:o.tree.root,eligible:o.tree.count,listed:wallets.length,warnings:o.warnings,file:base+'.safe-open.json'},null,1));
 }else throw Error('usage: safe-batch.mjs accept <record> | open <record> <wallets.json> <snapshot time> <opening time>');
}
