# Ember Evo Genesis — audit package, Submission 2 (2026-10-27)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters). Each token is a
look (body + clothes + accessories) chosen by the minter, plus a skin colour that is either chosen or revealed later at
random. This is the **second pre-audit** of the release candidate. It answers the first audit
(Submission 1, explorer.imd.fun job 31bb373a: 2 medium, 5 low, 7 info). The per-finding answers, with the test that
reproduces each one, are in [FINDINGS_RESPONSE.md](FINDINGS_RESPONSE.md).

After those fixes we ran our own second review: an independent reviewer plus a line-by-line pass. It found no bugs,
but tightened three points of the trust model (section 8.2). It also repacked storage to cut gas: the reveal rules and
results did not change, and section 10 has the numbers.

## 1. Scope

| In scope | File | Notes |
|---|---|---|
| **Primary** | `contracts/EmberEvoGenesisCandidate.sol` (602 lines) | the NFT contract (ERC-721, OpenZeppelin 5.4.0) |
| Secondary (trust model, integration) | `offchain/signer/*.mjs` | approval signer (Cloudflare Worker): signs EIP-712 mint approvals, hands out the committed reveal secrets (`reveal-chain.mjs`) |
| Secondary (trust model, integration) | `offchain/gold-book/**` | off-chain GOLD ledger: holds and settles GOLD for paid mints from finalized chain facts |

Out of scope: `contracts/test/*` (fixtures), `contracts/testnet/TestEmbeo.sol` (Sepolia test token with a public faucet,
never on mainnet), OpenZeppelin, the mint web page, the Sepolia test-GOLD faucet. `tools/` holds the deploy and
Etherscan-verification scripts (for reference: the setup order before minting opens).

## 2. Build (reproducible)

- Compiler **solc 0.8.38+commit.1835d247** (official `soljson-v0.8.38+commit.1835d247.js`, SHA-256
  `6c74ffba0ea4cf9521e78b16052a98208770bb7677616de08ced239f4312d390` as in binaries.soliditylang.org `list.json`),
  optimizer on (200 runs), **viaIR**, EVM **cancun**.
- `build/standard-input.json` is the exact standard-JSON input (43 sources incl. OpenZeppelin 5.4.0; SHA-256
  `673f7219a9ee1eceb73e5deaf60e3021c7e174a2d051d83bfabfb534652e3118`). It reproduces the deployed bytecode
  (Etherscan: exact match). `build/build-receipt.json` has per-source and per-artifact SHA-256.
- `contracts/EmberEvoGenesisCandidate.sol` SHA-256 `fdd103a06d228d89bf896485af0ff3017d1424ae0ece4eb34850b20df5989755`.
- Runtime size 23,972 bytes (limit 24,576). No compiler warnings for the contract apart from solc's generic note on
  transient storage: it is used for the reentrancy guard, which is cleared on exit, and for the one-paid-mint-per-caller
  marker (section 8.7).

## 3. Test deployment (Sepolia, chain 11155111)

| | |
|---|---|
| Contract | `0xb972164188e5164402EDbaCBa3f6f95Decfba836` — **verified on Etherscan (exact match)**: https://sepolia.etherscan.io/address/0xb972164188e5164402EDbaCBa3f6f95Decfba836#code |
| Deploy block | 12002478 (record: `deployment/11155111-1793072261196.json`) |
| On-chain runtime code hash | `0x065d775440ee4fbd149f1c112c3ad9f3d871b75eec5ebd19d7e9806f13c14a7e` (same length as the artifact; the 248 differing bytes are all immutable slots) |
| Reveal commitment at deploy | `0x1114c0ec8c4e0ee42b1c7ceb4ed9177aff827d58931fac20f76bb6571e9a30ed` (chain length 4,608, fresh seed for this deployment, accepted by the signer on chain) |
| Payment token (test) | `0x100d91C5a704d383bDd8a0234B443D4eA893bb5e` (TestEmbeo, 18 decimals) |
| Approval signer | `0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d` |
| Owner | `0x5cF561D7EEB76dBd688127893Bb362C9A819f66D` (test EOA; mainnet: a multisig) |

Setup transactions, in order: `configureSnapshot`, `setRevealURIs(…, lock=true)`,
`setRevealCommit(commit, deadline, signerAcceptance)`, `setMintPaused(false)`, `approvePaidPrice`.
Earlier deployments (`0x8ce6…2efa` = Submission 1, `0x7028…9a93`) are retired.

## 4. Roles and privileges

- **Owner** (`Ownable2Step`; `renounceOwnership` always reverts):
  - Supply: `configureSupply` (only until the supply is fixed: a token exists, minting has opened, or `lockSupply`), `lockSupply`.
  - Setup and opening: `configureSnapshot` (once, before any mint), `setMintPaused` (opening needs the snapshot, locked reveal URIs and a reveal commitment: `OPEN_NOT_READY`).
  - Reveal: `setRevealCommit` (only while paused and with the signer's acceptance, see section 5), `setRevealURIs` (until locked).
  - Payment: `approvePaidPrice` (irreversible; the price itself is immutable), `revokePaidOrder`.
  - Metadata: `setTokenURI` (override for a chosen-skin token, until `lockTokenURIs`), `lockTokenURIs`.
  - Signer rotation, only while paused: `proposeAppearanceSigner` → `activateAppearanceSigner` with the new signer's EIP-712 acceptance; `cancelAppearanceSignerProposal`.
- **Approval signer** (`appearanceSigner`, an EOA held by the off-chain signer service):
  - Signs `Appearance` (wallet, lookKey, choice, uriHash, deadline, signerEpoch, **paid**) for every mint, `PaidAuthorization` for paid mints, and `RevealCommitAcceptance` (commit, signerEpoch, deadline) for every reveal commitment.
  - `signerEpoch` increments on rotation and invalidates all older signatures.
  - Holds the **reveal seed** (a separate secret) and publishes each secret once its epoch's seed block is 2 blocks deep.
- **Anyone**: `settle(reveals)` seals and reveals every ready epoch it has secrets for, even while minting is paused. The caller has no choice over the outcome: a secret either opens the commitment or is ignored.

## 5. Flows

**Free mint** `mintFree(lookKey, choice, uri, deadline, signature, proof, reveals)`:
- The wallet must be in the Merkle snapshot (leaf = keccak256(keccak256(abi.encode(wallet)))); one claim per wallet; not before `freeStartAt`.
- Needs the signer's `Appearance` with `paid = false`. Free eligibility does not reserve supply.

**Paid mint** `mintPaid(..., expectedRecipient, expectedCost, order, goldSignature, reveals)`:
1. The signer holds the order's GOLD in the off-chain book (after the wallet signs an EIP-712 "Ember World GOLD" consent), then signs `PaidAuthorization` and an `Appearance` with `paid = true`.
2. The contract checks the order matches the call and consumes `orderId` once.
3. It moves exactly `paidCost` from the minter to `BURN_ADDRESS` (0x…dEaD), checking both balances and an unchanged `totalSupply` (fee-on-transfer and burn-on-transfer tokens are rejected).
4. One paid mint per caller per transaction (transient marker).
5. The book settles the hold from **finalized** chain facts: the order's `PaidOrderConsumed` log and the `GenesisMinted` log for that wallet and token id in the same receipt, with the contract's code hash pinned. Since Submission 2 it does not look at `receipt.to`, so smart-wallet and bundled mints settle. Otherwise the hold is released after the deadline.

**Skins**:
- Choices 0–2 fix the skin at mint (per-skin caps). Choice 3 is random.
- Random tokens are grouped in 25-block epochs (at most 25 random mints per epoch) and revealed strictly in epoch order.
- Draws are weighted by the remaining capacity of each skin, so the caps (sum = max supply) always hold.

**Randomness (commit-reveal)**

*The commitment.*
- The signer derives a hash chain from a 32-byte seed: `x[N] = seed`, `x[i-1] = keccak256(x[i])`, N = 4,608. That is at least 2 × the supply ceiling: one secret per epoch, plus one each time an expiry uses one up.
- The owner stores `x[0]` with `setRevealCommit(x0, deadline, acceptance)`, where `acceptance` is the signer's EIP-712 signature over (commit, signerEpoch, deadline).
- The contract refuses a value it has held, or one whose preimage is public (it walks back each chain it has held, current and replaced, and one step past each anchor).

*Sealing and revealing.*
- An epoch is *ready* once its seed block is mined: the first block after the epoch, or a later re-arm block.
- `settle` and every mint first look, for the next ready epoch, for the secret in `reveals` that opens the current commitment (in any order). They seal with seed = `keccak256(abi.encode(h, secret, e, address(this)))`, where `h` is the seed block's hash (`blockhash`, else the EIP-2935 history contract), then reveal all of its tokens **in the same call**. They repeat while secrets last.
- The seed is not stored; `EpochSealed` records it with the block hash and the secret, so anyone can recompute every draw.

*When the signer hands out secrets.*
- Only after the seed block is **2 blocks deep** (`readyReveals`, endpoint `GET /v1/reveals`).
- It never hands out a secret that comes after one whose seed block is about to leave the hash window.

*Expiry.*
- If `h` is no longer available, the epoch is not sealed: the supplied secret is used up, the epoch and every later one are **re-armed** to `block.number + 1`, and the next, still unpublished, secret decides.
- This happens **once per epoch**. If the re-armed block also expires, the next secret alone seals it, so withholding secrets gives the holder a bounded set of options (section 8.2).

*Re-arm.*
- One slot (`rearmState`: block, first epoch, expired flag): every unsealed epoch from that epoch on takes the later of its own seed block and the re-arm block.
- Replacing the commitment while the next epoch is ready re-arms it, and is allowed only **REARM_COOLDOWN = 7,200 blocks** (about a day) after its seed block. Meanwhile anyone holding a published secret can settle it.

*Chosen-skin freeze.*
- From an epoch's seed block itself until it is revealed, every chosen-skin mint reverts with `REVEAL_PENDING`. A mint's own `reveals` normally settle the epoch just before.
- Random mints go ahead, because they change no skin count.

**Metadata**:
- `tokenURI` = `revealBaseURI + lookKey(hex) + "/" + skin` for chosen and revealed tokens. It is `pendingURI` for unrevealed random tokens, or the owner override for a chosen token.
- The signer signs exactly that derived URI as `uri`; the contract does not compare the two.
- One ERC-4906 `BatchMetadataUpdate(first, last)` per revealed epoch.

**Storage layout (gas, Submission 2)**:
- `skinState`, one slot: 6 caps, 6 counts, `totalMinted` and `freeMinted`, 16 bits each.
- Per token: its look key, plus 4 bits in a word shared by 64 tokens (random flag, skin + 1).
- Per epoch: its random token ids, 16 bits each, in two slots.
- `maxSupply`, `paidMinted`, `pendingRandom`, `revealedSecrets` and `tokenLook` are views.

## 6. Intended properties (please try to break these)

1. Supply never exceeds `maxSupply`; per-skin counts never exceed their caps; every random token gets a skin.
2. A paid mint burns exactly `paidCost`; an order can be consumed at most once; a revoked order cannot be used.
3. A signature cannot be replayed:
   - by another wallet;
   - after its deadline;
   - for another choice, look, URI or route;
   - after a signer rotation;
   - on another chain or contract.
4. **No minter** can choose or steer a random token's skin: not by timing, by chosen-skin mints around a reveal, by the order of secrets, or by revealing epochs out of order. The owner alone cannot either. For the signer, and the owner with a signer it controls, see 8.2.
5. Each reveal secret can be used once and only in chain order. A value the contract held, or one whose preimage is public, can never become the commitment.
6. Packed storage is equivalent to the per-token draw (tested against an off-chain replica, including 25-token epochs).
7. A failing receiver, a reentrant token or a reentrant receiver cannot leave partial state (all-or-nothing).

## 7. Before mainnet (known differences)

- Remove the rehearsal guard `require(block.chainid != 1)` in the constructor; final contract and EIP-712 domain name
  (now `EmberEvoGenesisCandidate`, version `7`).
- Real EMBEO (a plain 18-decimal ERC-20: no fee-on-transfer, rebasing or hooks), final free-list snapshot, final
  metadata URIs, owner = multisig, signer key and reveal seed custody (separate secrets), Etherscan verification.
- A keeper that calls `settle` shortly after each seed block is 2 deep (through a private RPC), so published secrets are
  used at once (see 8.2 and 8.3).
- Optional further gas cuts, not done here because they change other components:
  - free-list claims in a bitmap keyed by Merkle index;
  - sequential paid order ids in a bitmap;
  - a paid route that verifies only `PaidAuthorization`.

## 8. Known risks and open questions

1. **Signer compromise**: the signer key can approve any look or URI for any wallet, and also signs the GOLD
   authorization. A stolen key could therefore authorize paid mints without a GOLD hold (EMBEO is still burned on chain).
   Acceptable? What on-chain limits would you recommend?
2. **Randomness trust model** (please assess):
   - **The secret holder (the signer) builds the seed block.** Since PBS, anyone can be a builder. The signer could build or buy the seed block and grind its hash knowing the secret, and so pick an outcome. Commit-reveal with a block hash cannot exclude this; a VRF could. Is this acceptable for a 1,288-token collection, or should mainnet use Chainlink VRF (cost) or another source?
   - **Withholding.** The signer can withhold a secret it does not like. After about 27 h the seed block expires and the epoch is re-armed (one fresh draw). If it withholds again, the next secret alone decides. That is at most three options per epoch, each costing about a day during which every chosen-skin mint reverts — visible, but not prevented.
   - **Owner and signer.** The owner cannot set or replace the chain without the current signer's acceptance. It can rotate the signer to a key it controls (paused, visible, with `AppearanceSignerChanged`), and then holds the signer's powers. With a ready epoch whose secret may already be public, a replacement waits `REARM_COOLDOWN` after the seed block, so anyone can settle the published outcome first. Mainnet owner = multisig.
   - **Early knowledge.** A published secret tells everyone the epoch's outcome about a block before it is sealed. Nothing can change the counts in between (chosen mints are frozen), but holders of soon-to-be-common unrevealed tokens could sell first. The planned keeper settles at once.
3. **`REVEAL_PENDING` retries**: around an epoch boundary a chosen-skin mint can revert until the epoch's secret is out (seed block + 2). The page waits and retries for about 36 s. Random mints are not affected.
4. **Gas bounds**: a mint settles as many ready epochs as it has secrets for; the signer hands out at most 32, and an epoch holds at most 25 tokens. Revealing a full epoch adds about 0.11–0.12M gas to a mint (section 10), so even 32 full epochs stay well under a block. Nine ready epochs are tested.
5. **Owner powers over metadata**: `setTokenURI` can change a chosen token's URI until `lockTokenURIs`.
6. **Off-chain GOLD settlement** (secondary scope): the book searches `eth_getLogs` from the deploy block to the finalized block. A bounded search is planned before mainnet.
7. **Transient "one paid mint per caller per transaction" marker**: it is keyed on `msg.sender`, so N contract wallets or an ERC-4337 bundle can do N paid mints in one transaction. It is a composition rule, not a rate limit.
8. **Throughput by design**: at most 25 random mints per 25-block epoch (`EPOCH_RANDOM_FULL` beyond that).
9. **Odds are path-dependent** (from the first audit): chosen mints before an epoch's seed block change the remaining weights for pending random tokens. Expected value can be steered; the outcome cannot. This is documented for the mint page.

## 9. Tests

`tests/contract/*` and `tests/signer/*` run on a local Hardhat EDR (Cancun) chain, and `tests/gold-book/*` on
node:sqlite. Paths are relative to the original workspace; to run the contract and signer tests:

```
node --import ./contract/tools/runtime-local-hook.mjs --test --test-concurrency=1 contract/tests/*.test.mjs signer/tests/*.test.mjs faucet/*.test.mjs
```

Result 2026-10-27: **84 tests, 81 pass, 0 fail, 3 skipped** (a placeholder for formal-chain checks and two archived
tests). The GOLD book tests give 15 / 15. The suite includes a reproduction of every Submission 1 finding that changed code
(FINDINGS_RESPONSE.md), plus:
- the second-expiry path and keccak(anchor) refusal;
- a full 25-token epoch checked against the off-chain draw;
- the paid route end to end: consent, GOLD held in the real book code, mint, burn, and settlement from the finalized chain reader.

## 10. Gas (local EDR, same bytecode as Sepolia)

| Step | Submission 1 (Osaka) | Submission 2 (Osaka) | Submission 2 (Amsterdam / EIP-8037) |
|---|---|---|---|
| deploy | 5,470,330 | 5,446,759 | 38,060,359 |
| setRevealCommit | 57,537 | 70,622 | 151,454 |
| free chosen mint | 268,781 | 178,482 | 582,582 |
| paid random mint (first in epoch) | 328,870 | 240,228 | 725,136 |
| paid random mint (second) | 242,530 | 188,089 | 430,549 |
| chosen mint revealing 2 | 372,121–392,665 | 232,999–233,551 | 719,299 |
| settle revealing 1 | 146,813 | 72,107–72,659 | 72,107 |
| chosen mint revealing a full epoch (25) | 669,187–670,913 | 290,742–296,010 | 540,666 |

Draw-dependent rows vary a little between runs. Sepolia has run Glamsterdam (EIP-8037) since 2026-10-06; the
Sepolia deploy used 39,065,388 gas for the whole setup.
