import {WorkerEntrypoint} from '#worker-entrypoint';
import {createGenesisGoldService,maintainGenesisGold,type GenesisGoldDeps,type GenesisGoldEnv} from '../server/genesis-gold-service.ts';
import {SEPOLIA_GENESIS_DEPLOYMENTS} from '../server/genesis-deployments-sepolia.ts';
// SEPOLIA REHEARSAL BOOK (wrangler.gold-sepolia.jsonc): its own Worker and D1 with test GOLD only, for the Genesis R5
// rehearsal on chain 11155111. It never binds the production database, serves no page and no public API: the Genesis
// signer of the same account reaches it through the GenesisGold service binding. The cron settles held orders from
// finalized Sepolia blocks (GENESIS_RPC_URL secret).
const SEPOLIA:GenesisGoldDeps={deployments:SEPOLIA_GENESIS_DEPLOYMENTS,environment:'sepolia'};

export default {
  fetch(){return new Response('{"error":"NOT_FOUND"}',{status:404,headers:{'content-type':'application/json','cache-control':'no-store'}});},
  async scheduled(_controller:{cron:string},env:GenesisGoldEnv,ctx:{waitUntil(p:Promise<unknown>):void}){
    const at=Date.now();
    ctx.waitUntil(maintainGenesisGold(env,SEPOLIA,fetch,at).then(r=>{if(r.length)console.log('genesis_gold',JSON.stringify(r));})
      .catch(()=>console.log('genesis_gold',JSON.stringify({status:'unavailable'}))));
  }
};

export class GenesisGold extends WorkerEntrypoint<GenesisGoldEnv>{
  reserve(request:unknown){return createGenesisGoldService(this.env,SEPOLIA).reserve(request);}
  order(request:unknown){return createGenesisGoldService(this.env,SEPOLIA).order(request);}
  reconcile(request:unknown){return createGenesisGoldService(this.env,SEPOLIA).reconcile(request);}
}
