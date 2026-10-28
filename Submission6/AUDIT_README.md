# Ember Evo Genesis — audit package, Submission 6 (2026-10-29)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters). This is the
**sixth pre-audit** of the release candidate. Submission 5 (Sepolia `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`,
fourth audit b0b1d96a handled) is the base; everything not described here is unchanged from
[Submission5/AUDIT_README.md](../Submission5/AUDIT_README.md), which stays the reference for the rest of the design
(free route, reveal chain, signer rotation, supply, royalties, trust model).

**This version is not deployed on any chain.** `build/standard-input.json` reproduces it with solc 0.8.38
(Submission 5's settings and OpenZeppelin 5.4.0 sources; only `contracts/*.sol` replaced); see `build/build-receipt.json`
(runtime 24,353 bytes, limit 24,576).

## 1. What changed: more payment tokens, each with its own GOLD price

Owner decisions 2026-10-29, after talking with the imdUSD team:

- The contract is deployed with **imdUSD v1** as `paymentToken` (18 decimals), `paidCost` = 20e18, `paidGoldCost` = 1,200.
- Right after deployment the owner Safe adds **USDC** (6 decimals) at **1,600 GOLD**. It is usable two days later, before
  minting opens. It is a fallback in case anything goes wrong with imdUSD.
- Months later, when **imdUSD v2** exists (a new token with a 1:1 migration from v1, on the imdUSD team's suggestion),
  the Safe adds it at **1,200 GOLD**.
- Every token pays the same $20. Paying in imdUSD costs **400 GOLD less**; the Mint page labels the discount.

The contract changes (full diff: [build/EmberEvoGenesisCandidate.Submission5-to-6.diff](build/EmberEvoGenesisCandidate.Submission5-to-6.diff)):

- `mapping(address => uint256) public paymentTokens`. Each entry packs the amount charged per mint in the token's own
  units (bits 0-127), its GOLD price (bits 128-215) and the time it becomes usable (bits 216-255). The constructor
  writes the deployment token's entry (`paidCost`, `paidGoldCost`, usable at once). The constructor now also requires
  `paidCost < 2^128` and `paidGoldCost < 2^88`.
- `addPaymentToken(address token, uint256 goldCost)` (owner only):
  - at most `MAX_EXTRA_PAYMENT_TOKENS` = 2 added tokens, each once;
  - the token must be a contract, must not already be listed, and must not be the recipient;
  - `decimals()` must be 6 or 18, and `paidCost` must convert exactly to the token's units (20e18 → 20e6 for USDC);
  - `goldCost` must be non-zero and below 2^88;
  - the token is usable `PAYMENT_TOKEN_DELAY` = 2 days later, so buyers can see it on chain first;
  - an entry is never changed or removed. Emits `PaymentTokenAdded(token, amount, goldCost, usableAt)`.
- `mintPaid(..., bytes32[] reveals, IERC20 token)`: the caller names the token.
  - The token must be listed and usable, else `PAYMENT_TOKEN_UNAVAILABLE`.
  - The `PaidAuthorization` digest uses **that token's GOLD price**. An order the signer reserved at 1,200 GOLD
    (imdUSD) therefore fails `GOLD_RESERVATION_AUTHORITY` if it is paid in USDC (1,600), and the reverse.
  - The exact-payment check (payer loses and recipient gains exactly the amount) runs on the named token.
  - `PaidOrderConsumed.goldCost` reports the token's GOLD price. `GenesisMinted.cost` stays `paidCost`, the dollar
    price in 18 decimals, whichever token paid.
- The `PaidAuthorization` type string is unchanged: `embeoCost` is still `paidCost` and `goldCost` is now the paid
  token's GOLD price.

Off chain (secondary scope):

- **Signer** (`offchain/signer/paid-approval.mjs`): `prepare` requires a `token`. It reads `paymentTokens(token)`,
  refuses a token that is not usable, reserves GOLD at that token's GOLD price and returns
  `payment: {token, amount, goldCost}`.
- **GOLD book** (`offchain/gold-book/`, World source `7939c37`, under review separately as World Submission19):
  - a registry entry lists the added tokens' GOLD prices in `addedTokenGoldCosts` (at most two, distinct, positive);
  - an order is held only at the deployment token's price or one of those;
  - settlement still requires the stored order's `goldCost`, the held amount and `PaidOrderConsumed.goldCost` to be equal.

## 2. Trust notes

- **The owner can add a token at any GOLD price.** On-chain limits: two tokens, each once, a two-day delay, never
  removed. The owner is the project's Safe (2 of 3). The GOLD book is a second gate: an order is held only at a price its
  registry lists, so a token added at an unlisted price cannot be paid with held GOLD until the registry is changed in a
  reviewed World deploy.
- **The owner chooses which token contracts to trust.** A malicious or upgradeable token could misreport balances. The
  exact-payment check catches fee-on-transfer and burn-on-transfer behaviour at mint time, but not a token that lies
  about both balances. The `nonReentrant` guard covers both mint paths while the token call runs (tested with a hostile
  token below).
- **USDC is upgradeable and can blacklist.** If the recipient Safe were blacklisted, USDC mints would revert. imdUSD
  mints would not be affected.

## 3. Please attack

1. **Price confusion between tokens.** Can a paid mint pay one token's amount at another token's GOLD price, pay an
   added token before `usableAt`, or reuse an order or signature across tokens?
2. **Packing and conversion.** Are there bit overlaps or truncation in `paymentTokens`
   (`uint128(accepted)`, `uint88(accepted >> 128)`, `accepted >> 216`)? Does a 6-decimal amount round or lose units?
   Can a value pass the constructor or `addPaymentToken` checks and still overflow?
3. **`addPaymentToken` edge cases.** Can a call add `paymentToken` itself, the recipient, this contract, an EOA, a token
   whose `decimals()` reverts or returns a huge value, the same token twice, or a third token? What happens if the
   owner changes (`Ownable2Step`) between adding tokens?
4. **Reentrancy and hostile tokens.** Through a malicious added token's `transferFrom` or `balanceOf`, can anyone
   re-enter `mintPaid`, `mintFree` or the reveal settlement, or make the exact-payment check pass without paying?
5. **Events and off-chain readers.** Is `PaidOrderConsumed.goldCost` = the token's GOLD price enough for the GOLD book to
   settle exactly the held amount? Does `GenesisMinted.cost` = `paidCost` (dollars, 18 decimals) mislead an indexer
   when 20 USDC (20e6) was paid?

## 4. Tests

The full local suite passes (Node 24, local in-process chain): **98 tests, 95 pass, 0 fail, 3 skipped**. The 3 skips
are kept on purpose (two old clipping rules kept for the record, and a placeholder for production parameters).

`tests/contract/second-token.test.mjs` (8 tests) covers:
- adding USDC and minting with it at 1,600 GOLD while imdUSD stays at 1,200;
- a 1,200-GOLD signature refused when paid in USDC, and the reverse;
- the exact `usableAt` boundary;
- every `addPaymentToken` refusal (third token, repeat, recipient, EOA, decimals, zero or oversized GOLD price);
- a hostile token that tries to re-enter `mintPaid`, `mintFree` and the reveal settlement (`REENTRANT_CALL`);
- pause (`MINT_NOT_READY`);
- a new owner adding a token.

`tests/signer/paid.test.mjs` runs the signer against the World GOLD book: a USDC mint is held at 2 GOLD and settles at 2
(the fixture's prices are 1 and 2). `tests/gold-book/genesis-gold.test.mjs` (24 tests) covers the registry's price list.

## 5. Not verified

- Not deployed, not on Sepolia, not on mainnet. Gas was not re-measured.
- USDC's real proxy behaviour (blacklist, upgrades) is not in the tests; a 6-decimal fixture token stands in for it.
- imdUSD v2 does not exist yet.

## 6. Files

- `contracts/` — the contract and its test fixtures. `Fixtures.sol` adds `DecimalsToken`, a token with configurable
  decimals. The hostile token is `R3HookToken` in `R3Fixtures.sol`, unchanged.
- `build/` — standard input, build receipt, diff from Submission 5.
- `tests/` — contract, signer and GOLD-book tests.
- `offchain/` — the signer and the GOLD-book code they exercise.
- `tools/` — the deploy and verify tools.

The signer test refers to two local folders by path (the World source and a Sepolia rehearsal copy); they are not part
of this package. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except
itself.
