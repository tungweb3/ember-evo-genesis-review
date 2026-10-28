import type {D1Database} from './d1.ts';
import {reserveGenesisGold,genesisGoldOrder,reconcileGenesisGold,reconcileGenesisDeployments,type GenesisDeployment} from './genesis-gold.ts';
import {createGenesisR5Reader,genesisRpc,type JsonRpc} from './genesis-gold-reader.ts';
// The GenesisGold service as the World Worker uses it (worker/index.ts, production registry, Alchemy mainnet transport
// injected by worker/app.ts). The Sepolia rehearsal book keeps its own copy in its own workspace.

type RateLimit={limit(options:{key:string}):Promise<{success:boolean}>};
/** The bindings this service reads. ALCHEMY_API_KEY: mainnet reads; GENESIS_RPC_URL: a test chain's RPC (secret). */
export type GenesisGoldEnv={DB?:D1Database;ALCHEMY_API_KEY?:string;GENESIS_RPC_URL?:string;ECONOMY_CHAIN_LIMITER?:RateLimit};
/** Genesis R5 deployments this book serves, which environment of the registry it is (code, not env), and the chain-1
 *  transport if this book may read mainnet at all. */
export type GenesisGoldDeps={deployments:readonly GenesisDeployment[];environment:'production'|'sepolia'|'local';
  mainnet?:(env:GenesisGoldEnv,chainFetch:typeof fetch)=>JsonRpc;
  /** Blocks per eth_getLogs request of this book's provider (default GENESIS_LOG_BLOCK_RANGE, Alchemy Free's 10). */
  logBlockRange?:number};

/** Chain reads for the Genesis reader: the injected mainnet transport for chain 1, else GENESIS_RPC_URL (a test chain).
 *  Shares ECONOMY_CHAIN_LIMITER (fails closed) under its own key. */
export function genesisChainRpc(env:GenesisGoldEnv,chainFetch:typeof fetch,d:GenesisDeployment,genesis:GenesisGoldDeps):JsonRpc{
  const none:JsonRpc=async()=>{throw Error('MINT_CHAIN_UNAVAILABLE');};
  const base:JsonRpc=d.chainId===1?genesis.mainnet?.(env,chainFetch)??none:env.GENESIS_RPC_URL?genesisRpc(env.GENESIS_RPC_URL,chainFetch):none;
  return async(method,params)=>{
    if(!env.ECONOMY_CHAIN_LIMITER||!(await env.ECONOMY_CHAIN_LIMITER.limit({key:'genesis:rpc'})).success)throw Error('MINT_CHAIN_UNAVAILABLE');
    return base(method,params);
  };
}
/** Only short business codes cross the service boundary; storage text (SQL, stack traces) never does. */
const GENESIS_SQL_CODES:[RegExp,string][]=[[/GOLD_INSUFFICIENT_OR_INVALID_HOLD/,'GOLD_INSUFFICIENT'],[/accepted\s*=\s*1/i,'FEATURE_PAUSED']];
function genesisCode(error:unknown):Error{
  // Trigger names first: D1 wraps them ("D1_ERROR: ...: SQLITE_CONSTRAINT"), node:sqlite reports them bare.
  const message=error instanceof Error?error.message:'';
  for(const [re,code] of GENESIS_SQL_CODES)if(re.test(message))return Error(code);
  if(/^[A-Z][A-Z0-9_]{1,80}$/.test(message))return Error(message);
  return Error('GOLD_UNAVAILABLE');
}
export const genesisReaderFor=(env:GenesisGoldEnv,chainFetch:typeof fetch,genesis:GenesisGoldDeps)=>
  (d:GenesisDeployment,hint:{transactionHash?:string})=>createGenesisR5Reader(d,genesisChainRpc(env,chainFetch,d,genesis),hint,genesis.logBlockRange);
/** What the GenesisGold service binding exposes to the Genesis signer of the same account. */
export function createGenesisGoldService(env:GenesisGoldEnv,genesis:GenesisGoldDeps,chainFetch:typeof fetch=fetch,now:()=>number=Date.now){
  const db=()=>env.DB??(()=>{throw Error('GOLD_NOT_CONFIGURED');})();
  const reader=genesisReaderFor(env,chainFetch,genesis);
  // Every failure (a missing binding too) becomes a rejected promise carrying only a code.
  const guard=<T>(work:()=>Promise<T>)=>Promise.resolve().then(work).catch(error=>{throw genesisCode(error);});
  return {
    reserve:(request:unknown)=>guard(()=>reserveGenesisGold(db(),genesis.deployments,genesis.environment,request,now(),now)),
    order:(request:unknown)=>guard(()=>genesisGoldOrder(db(),genesis.deployments,genesis.environment,request)),
    reconcile:(request:unknown)=>guard(()=>reconcileGenesisGold(db(),genesis.deployments,genesis.environment,reader,request,now()))
  };
}
/** The cron step: one bounded page per deployment of this environment. No deployment: nothing runs. */
export async function maintainGenesisGold(env:GenesisGoldEnv,genesis:GenesisGoldDeps,chainFetch:typeof fetch,at:number){
  if(!env.DB||!genesis.deployments.some(d=>d.environment===genesis.environment))return [];
  const result=await reconcileGenesisDeployments(env.DB,genesis.deployments,genesis.environment,genesisReaderFor(env,chainFetch,genesis),at);
  return result.flatMap<{id?:string;deployment?:string;status:string}>(r=>r.failed?[{deployment:r.deployment,status:r.failed}]:r.outcomes.filter(o=>o.status!=='pending'));
}
