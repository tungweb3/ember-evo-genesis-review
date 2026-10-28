import type {GenesisDeployment} from './genesis-gold.ts';
// Genesis deployments the GOLD book accepts paid orders for. Each entry pins chain, contract, runtime code hash, deploy
// block, both immutable costs, the GOLD price of every added payment token, the EIP-712 domain version and the payment
// recipient (read back from the deployed contract before an entry is added).
// Owner 2026-10-29: mainnet pays in imdUSD v1 (1,200 GOLD); USDC (1,600 GOLD) is added right after deployment and
// imdUSD v2 (1,200 GOLD) when it exists. The entry is added after USDC is added on chain, so it lists both prices from
// the start; v2 has imdUSD's price already listed, so adding it changes nothing here.
// Production is empty: the mainnet contract is not deployed, so
// every reservation is refused (MINT_DEPLOYMENT_UNKNOWN) even if the mint control were switched on. The entry is added,
// and this file re-reviewed, only after the mainnet deployment.
// Append-only while any order of an entry is held: the cron settles holds only for entries listed here, so removing or
// renaming an entry (or changing its pinned costs) would leave its holds reserved.
export const GENESIS_DEPLOYMENTS:readonly GenesisDeployment[]=Object.freeze([]);
