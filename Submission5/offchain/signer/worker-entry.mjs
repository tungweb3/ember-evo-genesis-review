// Cloudflare Worker entry. Config comes from wrangler vars and secrets; the free-mint list is bundled at deploy time.
// Vars: CHAIN_ID, CONTRACT_ADDRESS, METADATA_BASE, ALLOWED_ORIGINS (comma separated), APPROVAL_TTL_SECONDS,
//       GOLD_DEPLOYMENT_ID (this deployment's id in the World book's registry)
// Secrets: RPC_URL, SIGNER_PRIVATE_KEY, TICKET_SECRET (paid orders),
//          REVEAL_SEED (32-byte hex, the top of the reveal hash chain whose anchor the contract holds; signer/tools/new-reveal-seed.mjs)
// Bindings: GOLD (service binding to the World book's GenesisGold entrypoint; absent = paid route off), RATE_LIMITER (optional),
//           LOOKS (KV: lookKey -> canonical look, written before each approval; absent = looks not recorded, /v1/look answers 501)
// The provider (and its pending fetches / batch timers) must not outlive a request: Workers cancel a request that
// waits on I/O started by another request. Only pure data (the Merkle tree, the key) is kept between requests.
import {JsonRpcProvider,Wallet} from '../vendor/ethers.min.js';
import {FreeApprovalSigner,snapshotTree} from './free-approval.mjs';
import {PaidApprovalSigner} from './paid-approval.mjs';
import {createHandler} from './worker.mjs';
import {revealChain,readyReveals} from './reveal-chain.mjs';
import snapshotWallets from './snapshot-wallets.json';

let tree=null,key=null,chain=null;
// Secrets may arrive with a trailing newline (piped into `wrangler secret put` from a file or PowerShell).
const secret=v=>String(v??'').trim();
const provider=env=>new JsonRpcProvider(secret(env.RPC_URL),Number(env.CHAIN_ID),{staticNetwork:true});
function approver(env){
 tree??=snapshotTree(snapshotWallets);key??=new Wallet(secret(env.SIGNER_PRIVATE_KEY));
 return new FreeApprovalSigner({provider:provider(env),chainId:Number(env.CHAIN_ID),contractAddress:env.CONTRACT_ADDRESS,signer:key,metadataBase:env.METADATA_BASE,tree,
  ttlSeconds:Number(env.APPROVAL_TTL_SECONDS??300)});
}
function paidApprover(env){
 if(!env.GOLD||!env.GOLD_DEPLOYMENT_ID||!env.TICKET_SECRET)return null;
 key??=new Wallet(secret(env.SIGNER_PRIVATE_KEY));
 return new PaidApprovalSigner({provider:provider(env),chainId:Number(env.CHAIN_ID),contractAddress:env.CONTRACT_ADDRESS,signer:key,metadataBase:env.METADATA_BASE,
  gold:env.GOLD,deploymentId:env.GOLD_DEPLOYMENT_ID,ticketSecret:secret(env.TICKET_SECRET),ttlSeconds:Number(env.PAID_TTL_SECONDS??600)});
}
// The chain (2,048 hashes) is computed once per isolate; the secrets are only read through readyReveals.
function reveals(env){
 if(!env.REVEAL_SEED)return null;
 chain??=revealChain(secret(env.REVEAL_SEED));
 return ()=>readyReveals({provider:provider(env),contractAddress:env.CONTRACT_ADDRESS,chain});
}
let handler=null;
export default {fetch(request,env){
 handler??=createHandler({approver,paidApprover,reveals,allowedOrigins:String(env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean)});
 return handler(request,env);
}};
