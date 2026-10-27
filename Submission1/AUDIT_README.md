# Ember Evo Genesis — audit package (pre-audit, 2026-10-27, revision 3)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters). Each token is a
look (body + clothes + accessories) chosen by the minter, plus a skin colour that is either chosen or revealed later at
random. This package is for a **pre-audit of the release candidate**. The mainnet version will differ in the few
places listed under "Before mainnet"; a final audit of the frozen mainnet code is planned after this one.

Revision 2 (same day, after our own review) replaces the blockhash-only randomness with a **commit-reveal scheme**:
the approval signer commits to a hash chain of secrets before minting opens, and each random epoch's seed mixes the
next secret with the epoch's seed-block hash. Section 5 describes it; section 8 lists what it does and does not
protect against.

Revision 3 (same day) changes only the compiler: solc 0.8.37 → **0.8.38**, because 0.8.37 is affected by the known
optimizer bug SOL-2026-7 (YulOptimizerKnowledgeBaseStaleBookkeeping, optimized IR code generation, fixed in 0.8.38).
The only source change is the `pragma` line. Comparing the two builds opcode by opcode, the runtime code differs in a
single peephole near the start (`LT ISZERO` → `GT`) plus the resulting 1-byte shift of every code offset, so the 0.8.37
build was not affected. The contract was redeployed on Sepolia with a fresh reveal seed and **verified on Etherscan**
(section 3).

## 1. Scope

| In scope | File | Notes |
|---|---|---|
| **Primary** | `contracts/EmberEvoGenesisCandidate.sol` (516 lines) | the NFT contract (ERC-721, OpenZeppelin 5.4.0) |
| Secondary (trust model, integration) | `offchain/signer/*.mjs` | approval signer (Cloudflare Worker): signs EIP-712 mint approvals and hands out the committed reveal secrets (`reveal-chain.mjs`) |
| Secondary (trust model, integration) | `offchain/gold-book/**` | off-chain GOLD ledger: holds and settles GOLD for paid mints from finalized chain facts |

Out of scope: `contracts/test/*` (test fixtures), `contracts/testnet/TestEmbeo.sol` (Sepolia test token with a public
faucet; never deployed on mainnet), OpenZeppelin itself, the mint web page, the Sepolia test-GOLD faucet.
`tools/deploy-testnet.mjs` is the deployment script (for reference: the setup order before minting opens).

## 2. Build (reproducible)

- Compiler **solc 0.8.38+commit.1835d247** (official `soljson-v0.8.38+commit.1835d247.js`, SHA-256
  `6c74ffba0ea4cf9521e78b16052a98208770bb7677616de08ced239f4312d390` as listed in binaries.soliditylang.org
  `list.json`), optimizer on (200 runs), **viaIR**, EVM **cancun**.
- `build/standard-input.json` is the exact Solidity standard-JSON input (43 sources incl. OpenZeppelin 5.4.0;
  SHA-256 `9cfa6afb6a0476ae2cdbaa20f4fe6680be9d53dd11c77ffbe78818b485c0ffdc`). Compiling it reproduces the deployed
  bytecode (Etherscan: exact match). `build/build-receipt.json` has per-source and per-artifact SHA-256.
- `contracts/EmberEvoGenesisCandidate.sol` SHA-256 `c5c28e6b963b876485bd66aad520d05b1dedb9cc72a4c059ef7bec15c6eb5bbe`.
- Runtime size 23,378 bytes (limit 24,576). No compiler warnings for the contract apart from solc's generic note on
  transient storage (used only for the one-paid-mint-per-transaction marker, see 8.7).

## 3. Test deployment (Sepolia, chain 11155111)

| | |
|---|---|
| Contract | `0x8ce67008570ED41F64e4Be149ecAA66d1aBE2efa` — **verified on Etherscan (exact match)**: https://sepolia.etherscan.io/address/0x8ce67008570ED41F64e4Be149ecAA66d1aBE2efa#code |
| Deploy block | 12001804 (record: `deployment/11155111-1793063966361.json`) |
| On-chain runtime code hash | `0x596274cfa725311d28083323cb6aa69057553f81fc67281fa6c35952c4e76ad4` (same length as the artifact's runtime template; the 245 differing bytes are all immutable slots: payment token, costs, start block) |
| Reveal commitment (`revealCommit` at deploy) | `0x3727e0d90ad709196693de87171e11661fd7409c5200f16f6201d8fea3880d2e` (chain length 2,048, fresh seed for this deployment) |
| Payment token (test) | `0x100d91C5a704d383bDd8a0234B443D4eA893bb5e` (TestEmbeo, 18 decimals) |
| Approval signer | `0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d` |
| Owner | `0x5cF561D7EEB76dBd688127893Bb362C9A819f66D` (test EOA; mainnet: a multisig) |

Verified with `tools/verify-etherscan.mjs` (Etherscan API v2, standard-JSON input above, constructor arguments from
the deploy record's `etherscan.constructorArgsHex`). The previous revision-2 deployment
`0x7028e57466C36A7c8135980Ca3FBf77D277E9a93` (solc 0.8.37) is retired.
Setup transactions, in order: `configureSnapshot`, `setRevealURIs(…, lock=true)`, `setRevealCommit`,
`setMintPaused(false)`, `approvePaidPrice`.

## 4. Roles and privileges

- **Owner** (`Ownable2Step`; `renounceOwnership` always reverts):
  `configureSupply` (until the supply is fixed), `lockSupply`, `configureSnapshot` (once, before any mint),
  `setMintPaused` (opening requires the snapshot, locked reveal URIs and a reveal commitment: `OPEN_NOT_READY`),
  `setRevealCommit` (only while paused; replacing it re-arms ready unsealed epochs, see 5),
  `approvePaidPrice` (irreversible; price itself is immutable), `setRevealURIs` (until locked),
  `setTokenURI` (override for a chosen-skin token, until `lockTokenURIs`), `lockTokenURIs`, `revokePaidOrder`,
  signer rotation (`proposeAppearanceSigner` → `activateAppearanceSigner` with the new signer's EIP-712 acceptance,
  only while paused; `cancelAppearanceSignerProposal`).
- **Approval signer** (`appearanceSigner`, an EOA held by the off-chain signer service): signs `Appearance`
  (wallet, lookKey, choice, uriHash, deadline, signerEpoch) for every mint, and `PaidAuthorization` for paid mints.
  `signerEpoch` increments on rotation and invalidates all older signatures. The same service holds the **reveal
  seed** (a separate secret) and publishes each reveal secret once its epoch's seed block is mined.
- **Anyone**: `settle(reveals)`, `sealEpoch(e, secret)`, `revealEpoch(e, maxCount)` — no choice over the outcome:
  a secret either opens the commitment or is rejected.

## 5. Flows

**Free mint** `mintFree(lookKey, choice, uri, deadline, signature, proof, reveals)`: wallet in the Merkle snapshot
(leaf = keccak256(keccak256(abi.encode(wallet)))), one claim per wallet, not before `freeStartAt`, approved by the
signer. Free eligibility does not reserve supply.

**Paid mint** `mintPaid(..., expectedRecipient, expectedCost, order, goldSignature, reveals)`: the signer first holds
the order's GOLD in the off-chain book (after the wallet signs an EIP-712 "Ember World GOLD" consent), then signs
`PaidAuthorization`. The contract checks the order matches the call, consumes `orderId` once, and moves exactly
`paidCost` of the payment token from the minter to `BURN_ADDRESS` (0x…dEaD), checking both balances and an
unchanged `totalSupply` (fee-on-transfer / burn-on-transfer tokens are rejected). One paid mint per caller per
transaction (transient-storage marker). The book later settles the hold from **finalized** chain facts
(`PaidOrderConsumed` + `GenesisMinted` in the receipt, contract code hash pinned) or releases it after the deadline.

**Skins**: choice 0–2 fixes the skin at mint (per-skin caps). Choice 3 is random: tokens are grouped in 25-block
epochs (≤ 25 random mints per epoch) and revealed strictly in epoch order. Draws are weighted by the remaining
capacity of each skin, so the caps (sum = max supply) always hold.

**Randomness (commit-reveal, revision 2)**
- Before minting opens, the signer service derives a hash chain from a 32-byte seed: `x[N] = seed`,
  `x[i-1] = keccak256(x[i])`, N = 2,048 (≥ max supply, at most one epoch per random token). The owner stores
  `x[0]` with `setRevealCommit`.
- An epoch `e` is *ready* once its seed block (the first block after the epoch, or a re-armed block) is mined. It is
  sealed with the preimage of the current commitment: `keccak256(abi.encode(secret)) == revealCommit`, after which
  `revealCommit = secret`. Seed = `keccak256(abi.encode(h, secret, e, address(this)))`, where `h` is the seed block's
  hash from `blockhash`, else the EIP-2935 history contract (8,191 blocks), else zero. There is no re-arm on expiry.
- The signer hands out a secret only after its epoch's seed block is mined (`readyReveals` in
  `offchain/signer/reveal-chain.mjs`; endpoint `GET /v1/reveals`). The mint page fetches the secrets just before
  sending and passes them as `reveals`.
- Every mint first settles ready epochs with the `reveals` it carries (up to 8 epochs per call). Secrets that do not
  open the current commitment are skipped (a concurrent transaction may have used them), so a stale list does not
  revert the mint.
- A **chosen-skin** mint that leaves a ready epoch unrevealed reverts with `REVEAL_PENDING`: from the moment the seed
  block exists until the epoch is revealed, nothing can change the skin counts that epoch draws from. A **random**
  mint goes ahead (it changes no skin count; it joins the current epoch).
- `setRevealCommit` (paused only) replaces a lost or compromised chain; every unsealed epoch whose seed block is already
  mined is re-armed to `block.number + 1`, so the new secrets were fixed before that block's hash existed.

**Metadata**: `tokenURI` = `revealBaseURI + lookKey(hex) + "/" + skin` for chosen and revealed tokens (chosen-skin
URIs are derived, not stored), `pendingURI` for unrevealed randoms, or the owner override for a chosen token. Reveal
requires `revealURIsLocked` (and minting cannot open without it).

## 6. Intended properties (please try to break these)

1. Supply never exceeds `maxSupply`; per-skin counts never exceed their caps; every random token gets a skin.
2. A paid mint burns exactly `paidCost`; an order can be consumed at most once; a revoked order cannot be used.
3. A signature cannot be replayed by another wallet, after its deadline, for another choice / look / URI, after a
   signer rotation, or on another chain / contract.
4. No minter can choose or steer a random token's skin: not by timing, not by chosen-skin mints around a reveal, not
   by revealing epochs out of order. (For the owner and the signer, see 8.2.)
5. Each reveal secret can be used once and only in chain order; a wrong secret never seals an epoch.
6. The free list is fixed once configured; one free claim per listed wallet.
7. A failing receiver, a reentrant token or a reentrant receiver cannot leave partial state (all-or-nothing).

## 7. Before mainnet (known differences)

- Remove the rehearsal guard `require(block.chainid != 1)` in the constructor; final contract and EIP-712 domain name
  (now `EmberEvoGenesisCandidate`, version `6`).
- Real EMBEO token address (must be a plain 18-decimal ERC-20: no fee-on-transfer, rebasing or transfer hooks),
  final free-list snapshot, final metadata URIs, owner = multisig, signer key and reveal seed custody (separate
  secrets), Etherscan verification of the mainnet deployment (same tool as on Sepolia).

## 8. Known risks and open questions

1. **Signer compromise**: the signer key can approve any look/URI for any wallet, and also signs the GOLD
   authorization, so a stolen key could authorize paid mints without a GOLD hold (EMBEO is still burned on chain).
   Is this acceptable, and what on-chain limits would you recommend?
2. **Randomness trust model** (please assess):
   - The signer service knows every secret in advance. Alone it cannot pick an outcome (the seed block's hash is
     unknown when the chain is committed), but colluding with the proposer of a seed block it could grind that block.
   - Owner + signer together can re-roll a ready epoch: withhold the secret, pause, `setRevealCommit` with a new chain
     (re-arm), reopen. All of it is visible on chain (`RevealCommitSet`, `EpochRearmed`).
   - If the signer withholds a secret for more than ~8,191 blocks (~27 h), `h` becomes zero and the outcome changes
     once: one extra option for the signer. During that time every chosen-skin mint reverts, so it is visible.
   - Once a secret is published (API or mempool), anyone can compute the epoch's outcome about a block before it is
     sealed; no transaction can change the counts in between (point 4 of section 6).
3. **`REVEAL_PENDING` retries**: a chosen-skin mint signed before its seed block was mined, but included after it
   without the secret, reverts (the minter presses Mint again; the page fetches fresh secrets, and its dry run waits
   up to three blocks for them). Random mints are not affected.
4. **Gas bounds**: a mint may settle up to 8 epochs × 25 random tokens before minting. In practice at most one or two
   epochs are ready at a time (every chosen mint and most random mints carry the secrets).
5. **Owner powers over metadata**: `setTokenURI` can change a chosen token's URI until `lockTokenURIs`.
6. **Off-chain GOLD settlement** (secondary scope): the book searches `eth_getLogs` from the deploy block to the
   finalized block; with many blocks some RPC providers refuse the range (seen on Sepolia, fixed by changing the RPC;
   a bounded search is planned before mainnet).
7. Any issue with the transient-storage "one paid mint per transaction" marker and smart-contract wallets.
8. Throughput by design: at most 25 random mints per 25-block epoch (`EPOCH_RANDOM_FULL` beyond that).

## 9. Tests

`tests/contract/*` and `tests/signer/*` run on a local Hardhat EDR (Cancun) chain. In the original workspace
(paths are relative to it, not to this package):

```
node --import ./contract/tools/runtime-local-hook.mjs --test --test-concurrency=1 contract/tests/*.test.mjs signer/tests/*.test.mjs faucet/*.test.mjs
```

Result 2026-10-27 (solc 0.8.38 build): **78 tests, 75 pass, 0 fail, 3 skipped** (a placeholder for formal-chain checks and two archived
tests). Includes: the commit-reveal rules (wrong / stale / extra secrets, out-of-order sealing, expired seed blocks,
replacing the commitment), random mints while a reveal is pending, an off-chain replica of the draw checked token by
token, filling every skin exactly to its cap, and the paid route end to end (consent, GOLD held in the real book code
on node:sqlite, mint, burn, settlement from the finalized chain reader).

Sepolia, 2026-10-27, on the revision-2 deployment `0x7028…9a93` (same source, solc 0.8.37): a paid chosen-skin mint
(#1), a paid random mint (#2), then `settle` with the first secret (block 12000441, `revealedSecrets` = 1, #2
revealed) — confirming the signer's seed matches the on-chain commitment. On the revision-3 deployment the signer's
`GET /v1/reveals` was checked against the new commitment; no mints yet.

## 10. Gas (for reference)

See `docs/GAS_估算_項目方_2026-10-27.md` (Chinese). Measured on a local EDR chain, current mainnet rules (Osaka):
deploy 5.47M; setup 352k (5 transactions); chosen free mint ≈ 269k; random paid mint ≈ 243k–329k; a mint that
reveals a full epoch of 25 ≈ 650k–690k (depends on the draws). The 0.8.38 build differs from 0.8.37 by a few gas per
call (deploy −3,039). Sepolia runs Glamsterdam (EIP-8037) since 2026-10-06, where storage-creating operations cost
several times more (deploy ≈ 37.9M on Sepolia).
