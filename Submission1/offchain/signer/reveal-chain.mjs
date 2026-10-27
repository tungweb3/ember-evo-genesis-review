// The approval signer's reveal secrets (owner 2026-10-27: the signer commits to the randomness in advance).
// One 32-byte seed (Worker secret REVEAL_SEED) spans a hash chain: x[N] = seed, x[i-1] = keccak256(x[i]). The contract
// is given x[0] (setRevealCommit) before minting opens; each epoch it seals must supply the preimage of its current
// commitment, which then becomes the new commitment. So every secret is fixed before any mint, and the signer can only
// hand out the next one, never pick it.
// A secret is handed out only for an epoch whose seed block is already mined: whoever produces that block cannot know the
// secret, and whoever knows the secret cannot change that block's hash.
import {Contract,keccak256,isHexString} from '../vendor/ethers.min.js';

export const REVEAL_CHAIN_LENGTH=2048;   // >= maxSupply: at most one epoch per random token
export const MAX_REVEALS=8;              // the contract settles at most 8 epochs per call
const ABI=['function revealCommit() view returns (bytes32)','function randomEpochCount() view returns (uint256)',
 'function nextRevealIndex() view returns (uint256)','function randomEpochAt(uint256) view returns (uint256)',
 'function epochSeedBlock(uint256) view returns (uint256)','function epochSeed(uint256) view returns (bytes32)'];
const ZERO='0x'+'0'.repeat(64);

export class RevealError extends Error{constructor(code,status=503){super(code);this.code=code;this.status=status;}}

/** The chain from its top value. anchor = x[0]; next(commit) = the secret that opens `commit`, or null if `commit` is
 *  not on this chain (another seed) or is its last value. */
export function revealChain(top,n=REVEAL_CHAIN_LENGTH){
 if(!isHexString(top,32)||top.toLowerCase()===ZERO)throw new RevealError('REVEAL_SEED_INVALID',500);
 const x=new Array(n+1);x[n]=top.toLowerCase();
 for(let i=n;i>0;i--)x[i-1]=keccak256(x[i]);
 const index=new Map(x.map((v,i)=>[v,i]));
 return Object.freeze({anchor:x[0],length:n,
  secret:k=>{if(!Number.isInteger(k)||k<1||k>n)throw new RevealError('REVEAL_CHAIN_END',500);return x[k];},
  next:commit=>{const i=index.get(String(commit).toLowerCase());return i===undefined||i===n?null:x[i+1];}});
}

/** The secrets a transaction mined in the next block needs, in reveal order: one per unsealed epoch whose seed block
 *  is mined, up to MAX_REVEALS, stopping at the first epoch that is not ready yet. */
export async function readyReveals({provider,contractAddress,chain}){
 const c=new Contract(contractAddress,ABI,provider);
 const [latest,commit,count,next]=await Promise.all([provider.getBlockNumber(),c.revealCommit(),c.randomEpochCount(),c.nextRevealIndex()]);
 const out=[];let open=commit;
 for(let i=Number(next);i<Number(count)&&out.length<MAX_REVEALS;i++){
  const e=await c.randomEpochAt(i),[seedBlock,seed]=await Promise.all([c.epochSeedBlock(e),c.epochSeed(e)]);
  if(Number(seedBlock)>latest)break;         // seed block not mined yet: its secret stays with the signer
  if(seed!==ZERO)continue;                   // sealed, its tokens still being revealed
  const s=chain.next(open);
  if(!s)throw new RevealError('REVEAL_CHAIN_MISMATCH');   // REVEAL_SEED does not belong to this contract's commitment
  out.push(s);open=s;
 }
 return {block:latest,reveals:out};
}
