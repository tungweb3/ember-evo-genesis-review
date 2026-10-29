import type {GenesisDeployment} from './genesis-gold.ts';
// Genesis deployments the GOLD book accepts paid orders for. Each entry pins chain, contract, runtime code hash, deploy
// block, both immutable costs, every payment token with its GOLD price, the EIP-712 domain version and the payment
// recipient (read back from the deployed contract, paymentTokens(token), before an entry is added).
// Owner 2026-10-29: mainnet pays in imdUSD v1 (1,200 GOLD); USDC (1,600 GOLD) is added right after deployment and
// imdUSD v2 (1,200 GOLD) when it exists. The entry is added after USDC is added on chain, so it lists both tokens from
// the start; v2 is appended to addedTokens when it is added on chain (Genesis audit 944905c3: every order names its
// token, so a token missing here cannot be held for). Leaving a listed token out of the signer's policy stops new
// orders in it without changing this entry.
// Production is empty: the mainnet contract is not deployed, so
// every reservation is refused (MINT_DEPLOYMENT_UNKNOWN) even if the mint control were switched on. The entry is added,
// and this file re-reviewed, only after the mainnet deployment.
// Append-only while any order of an entry is held: the cron settles holds only for entries listed here, so removing or
// renaming an entry would leave its holds reserved. An identical retry of a held order is answered from the stored
// order, so appending a token or correcting a price never turns a retry into a refusal (World audit 8febfeed finding 4).
export const GENESIS_DEPLOYMENTS:readonly GenesisDeployment[]=Object.freeze([]);
