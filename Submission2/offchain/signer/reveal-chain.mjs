// The approval signer's reveal secrets (owner 2026-10-27: the signer commits to the randomness in advance).
// One 32-byte seed (Worker secret REVEAL_SEED) spans a hash chain: x[N] = seed, x[i-1] = keccak256(x[i]). The contract
// is given x[0] (setRevealCommit, with the signer's acceptance) before minting opens; each epoch it seals must supply the
// preimage of its current commitment, which then becomes the new commitment. So every secret is fixed before any mint,
// and the signer can only hand out the next one, never pick it.
// A secret is handed out only for an epoch whose seed block is mined and CONFIRMATIONS deep: whoever produces that block
// cannot know the secret, and whoever knows the secret cannot change that block's hash (audit 2026-10-27, finding 4).
import {Contract,keccak256,isHexString} from '../vendor/ethers.min.js';
import {DOMAIN_NAME,DOMAIN_VERSION} from './free-approval.mjs';

/** >= 2 x SUPPLY_CEILING (2,222): one secret per random epoch, plus one more each time an expired seed block uses one
 *  up (audit finding 11). */
export const REVEAL_CHAIN_LENGTH=4608;
/** Secrets per answer; the contract has no fixed per-call limit (audit finding 3). */
export const MAX_REVEALS=32;
/** Blocks on top of a seed block before its secret is handed out. */
export const CONFIRMATIONS=2;
/** Block hashes the contract can still read: EIP-2935 keeps 8,191 (Sepolia, mainnet); 256 without the history contract. */
export const HASH_WINDOW=8191;
/** A seed block this close to leaving the window gets its secret, but no later secret goes with it: if the epoch expires
 *  on chain, its secret is used up and the next one must stay private until the new seed block exists. */
const EXPIRY_MARGIN=64;
const ABI=['function revealCommit() view returns (bytes32)','function randomEpochCount() view returns (uint256)',
 'function nextRevealIndex() view returns (uint256)','function randomEpochAt(uint256) view returns (uint256)',
 'function epochSeedBlock(uint256) view returns (uint256)'];
const ZERO='0x'+'0'.repeat(64);
export const REVEAL_COMMIT_TYPES={RevealCommitAcceptance:[{name:'commit',type:'bytes32'},{name:'signerEpoch',type:'uint256'},{name:'deadline',type:'uint256'}]};

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

/** The approval signer's acceptance of a reveal commitment (setRevealCommit(commit, deadline, acceptance)). */
export async function signRevealCommit({signer,chainId,contractAddress,commit,signerEpoch,deadline}){
 return signer.signTypedData({name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId,verifyingContract:contractAddress},REVEAL_COMMIT_TYPES,{commit,signerEpoch,deadline});
}

/** The secrets a transaction mined in the next blocks needs, in reveal order: one per unsealed epoch whose seed block is
 *  CONFIRMATIONS deep, up to MAX_REVEALS, stopping at the first epoch that is not ready yet, and right after an epoch
 *  whose seed block is about to leave the block-hash window. */
export async function readyReveals({provider,contractAddress,chain,confirmations=CONFIRMATIONS,hashWindow=HASH_WINDOW}){
 const c=new Contract(contractAddress,ABI,provider);
 const [latest,commit,count,next]=await Promise.all([provider.getBlockNumber(),c.revealCommit(),c.randomEpochCount(),c.nextRevealIndex()]);
 const out=[];let open=commit;
 for(let i=Number(next);i<Number(count)&&out.length<MAX_REVEALS;i++){
  // every epoch before nextRevealIndex is sealed and revealed (the contract does both in one call)
  const seedBlock=await c.epochSeedBlock(await c.randomEpochAt(i));
  if(Number(seedBlock)+confirmations>latest)break;          // seed block not mined or not deep enough: secret stays here
  const s=chain.next(open);
  if(!s)throw new RevealError('REVEAL_CHAIN_MISMATCH');     // REVEAL_SEED does not belong to this contract's commitment
  out.push(s);open=s;
  if(latest-Number(seedBlock)>=hashWindow-EXPIRY_MARGIN)break;   // may expire on chain: keep the next secret private
 }
 return {block:latest,reveals:out};
}
