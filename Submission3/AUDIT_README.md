# Ember Evo Genesis — audit package, Submission 3 (2026-10-27)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters). Each token is a
look (body + clothes + accessories) chosen by the minter, plus a skin colour that is either chosen or revealed later at
random. This is the **third pre-audit** of the release candidate. It answers the second audit
(Submission 2, explorer.imd.fun job 388b71cb: 2 medium, 4 low, 1 info). The per-finding answers, with the test that
reproduces each one, are in [FINDINGS_RESPONSE.md](FINDINGS_RESPONSE.md).

All seven findings were in the expiry / re-arm part of the reveal. The main change: **an expired seed block keeps the
secret supplied for it** (now public) and re-arms to the next block, so no epoch is ever sealed by a secret alone and
an expired epoch can be settled by anyone without a secret (section 5, *Expiry*). Commitment replacements are bounded
(2 per epoch) and their cooldown also covers a pending re-arm. Before deployment, a storage repack cut about 10k gas
from every mint and 30k from the first random mint of an epoch (section 5, *Storage layout*; section 10).

## 1. Scope

| In scope | File | Notes |
|---|---|---|
| **Primary** | `contracts/EmberEvoGenesisCandidate.sol` (634 lines) | the NFT contract (ERC-721, OpenZeppelin 5.4.0) |
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
  `c5c682ef8dc56c11a77d67b7fe45e8ded3b9886cccea7c790acfdd456945d2f7`). It reproduces the deployed bytecode
  (Etherscan: exact match). `build/build-receipt.json` has per-source and per-artifact SHA-256.
- `contracts/EmberEvoGenesisCandidate.sol` SHA-256 `fcdb05487acf2a8e6834b3530138bfead6cc3f550b72e438d537d5df867227c6`.
- Runtime size 24,435 bytes (limit 24,576). No compiler warnings for the contract apart from solc's generic note on
  transient storage: it is used for the reentrancy guard, which is cleared on exit, and for the one-paid-mint-per-caller
  marker (section 8.7).

## 3. Test deployment (Sepolia, chain 11155111)

| | |
|---|---|
| Contract | `0x0FB5B6E5c1B026c611900a864755faC86dAd4085` — **verified on Etherscan (exact match)**: https://sepolia.etherscan.io/address/0x0FB5B6E5c1B026c611900a864755faC86dAd4085#code |
| Deploy block | 12005964 (record: `deployment/11155111-1793114237482.json`) |
| On-chain runtime code hash | `0xa54bede76104157ccc57079167105d2312ddd7de7267a32f8e9ebd82db4932db` (same length as the artifact; the differing bytes are all immutable slots) |
| Reveal commitment at deploy | `0x4c48feb11f81176cdda8114652c4749ca7caeb0474fec7b8ac039d63b42e9fc7` (chain length 4,608, fresh seed for this deployment, accepted by the signer on chain) |
| Payment token (test) | `0x100d91C5a704d383bDd8a0234B443D4eA893bb5e` (TestEmbeo, 18 decimals) |
| Approval signer | `0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d` |
| Owner | `0x5cF561D7EEB76dBd688127893Bb362C9A819f66D` (test EOA; mainnet: a multisig) |

Setup transactions, in order: `configureSnapshot`, `setRevealURIs(…, lock=true)`,
`setRevealCommit(commit, deadline, signerAcceptance)`, `setMintPaused(false)`, `approvePaidPrice`.
Earlier deployments (`0xb972…a836` = Submission 2, `0x8ce6…2efa` = Submission 1, `0x7028…9a93`) are retired.

## 4. Roles and privileges

- **Owner** (`Ownable2Step`; `renounceOwnership` always reverts):
  - Supply: `configureSupply` (only until the supply is fixed: a token exists, minting has opened, or `lockSupply`), `lockSupply`.
  - Setup and opening: `configureSnapshot` (once, before any mint), `setMintPaused` (opening needs the snapshot, locked reveal URIs and a reveal commitment: `OPEN_NOT_READY`).
  - Reveal: `setRevealCommit` (only while paused and with the signer's acceptance; at most 2 re-arms per epoch, see section 5), `setRevealURIs` (until locked).
  - Payment: `approvePaidPrice` (irreversible; the price itself is immutable), `revokePaidOrder`.
  - Metadata: `setTokenURI` (override for a chosen-skin token, until `lockTokenURIs`), `lockTokenURIs`.
  - Signer rotation, only while paused: `proposeAppearanceSigner` → `activateAppearanceSigner` with the new signer's EIP-712 acceptance; `cancelAppearanceSignerProposal`.
- **Approval signer** (`appearanceSigner`, an EOA held by the off-chain signer service):
  - Signs `Appearance` (wallet, lookKey, choice, uriHash, deadline, signerEpoch, **paid**) for every mint, `PaidAuthorization` for paid mints, and `RevealCommitAcceptance` (commit, **previous**, signerEpoch, deadline) for every reveal commitment: `previous` is the commitment it replaces, so one acceptance allows exactly one replacement.
  - `signerEpoch` increments on rotation and invalidates all older signatures.
  - Holds the **reveal seed** (a separate secret) and publishes each secret once its epoch's seed block is 2 blocks deep.
- **Anyone**: `settle(reveals)` seals and reveals every ready epoch it has secrets for (an expired epoch needs none), even while minting is paused. The caller has no choice over the outcome: a secret either opens the commitment or is ignored. Its only lever is timing, see 8.2 (*Liveness*).

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
- The signer derives a hash chain from a 32-byte seed: `x[N] = seed`, `x[i-1] = keccak256(x[i])`, N = 4,608 (one secret per epoch; more than enough, since an expiry no longer uses one up).
- The owner stores `x[0]` with `setRevealCommit(x0, deadline, acceptance)`, where `acceptance` is the signer's EIP-712 signature over (commit, signerEpoch, deadline).
- The contract refuses a value it has held, and the first 32 hashes above each anchor (their preimages are public): it walks each chain it has held, current and replaced. This guards against operator error; it cannot prove a chain is fresh, which is what the signer's acceptance is for.

*Sealing and revealing.*
- An epoch is *ready* once its seed block is mined: the first block after the epoch, or a later re-arm block.
- `settle` and every mint first look, for the next ready epoch, for the secret in `reveals` that opens the current commitment (in any order). They seal with seed = `keccak256(abi.encode(h, secret, e, address(this)))`, where `h` is the seed block's hash (`blockhash`, else the EIP-2935 history contract), then reveal all of its tokens **in the same call**. They repeat while secrets last.
- The seed is not stored; `EpochSealed` records it with the block hash and the secret, so anyone can recompute every draw.

*When the signer hands out secrets.*
- Only after the seed block is **2 blocks deep** (`readyReveals`, endpoint `GET /v1/reveals`).
- It never hands out a secret that comes after one whose seed block is about to leave the hash window.
- Nothing for an epoch whose secret is already opened (`epochSecretOpened(e)`, see *Expiry*).

*Expiry (changed in Submission 3).*
- If `h` is no longer available (older than the EIP-2935 window of 8,191 blocks), the epoch is not sealed. The supplied secret **stays the epoch's secret**: it is now public and is kept in `revealCommit`. The epoch and every later unsealed one are **re-armed** to `block.number + 1`.
- Once that block is mined, any call (`settle([])` or any mint) seals the epoch with that block's hash and the kept secret; no secret has to be supplied. If that block expires as well (no call for 8,191 blocks), the next call re-arms again, with the same secret.
- So an epoch is never sealed by a secret alone (`EpochSealed.blockHash` is never zero), the signer is never needed again for that epoch, and later epochs keep their own secrets.

*Re-arm.*
- One slot (`revealState`: reveal index, epoch count, re-arm block, first epoch, expired flag, commitment re-arm count): every unsealed epoch from that epoch on takes the later of its own seed block and the re-arm block.
- Replacing the commitment once the next epoch has **closed** (its own seed block is reached) re-arms it. That is allowed only **REARM_COOLDOWN = 7,200 blocks** (about a day) after its current seed block, a pending re-arm included, so anyone holding a published secret can settle first; and at most **MAX_COMMIT_REARMS = 2** times per epoch (`EPOCH_REARM_LIMIT`). The count survives expiry re-arms of the same epoch. After two, the epoch can only be settled with the chain it has.

*Chosen-skin freeze.*
- From an epoch's own seed block (`startBlock + (e + 1) × 25`) until it is revealed, every chosen-skin mint reverts with `REVEAL_PENDING`, whatever re-arm happens in between. A mint's own `reveals` normally settle the epoch just before.
- Random mints go ahead, because they change no skin count.

**Metadata**:
- `tokenURI` = `revealBaseURI + lookKey(hex) + "/" + skin` for chosen and revealed tokens. It is `pendingURI` for unrevealed random tokens, or the owner override for a chosen token.
- The signer signs exactly that derived URI as `uri`; the contract does not compare the two.
- One ERC-4906 `BatchMetadataUpdate(first, last)` per revealed epoch.

**Storage layout (gas, Submission 2; repacked in Submission 3)**:
- `skinState`, one slot: 6 caps, 6 counts, `totalMinted` and `freeMinted`, 16 bits each.
- One slot for what every mint checks first: `appearanceSigner`, `signerEpoch` (uint16), `mintPaused`,
  `paidPriceApproved`, `snapshotConfigured`, `freeStartAt` (uint40; `configureSnapshot` refuses a larger start) and
  `eligibleWalletCount` (uint16, at most `SUPPLY_CEILING`).
- `revealState`, one slot: reveal index (bits 0-31), random-epoch count (32-63) and the re-arm fields (64-194).
- The random-epoch list: 32 bits per epoch, 8 per word (`randomEpochWords`).
- Per token: its look key, plus 4 bits in a word shared by 64 tokens (random flag, skin + 1).
- Per epoch: its random token ids, 16 bits each, in two slots.
- `maxSupply`, `pendingRandom`, `chainSecrets` and `tokenLook` are views (paid mints = `totalMinted` - `freeMinted`).

## 6. Intended properties (please try to break these)

1. Supply never exceeds `maxSupply`; per-skin counts never exceed their caps; every random token gets a skin.
2. A paid mint burns exactly `paidCost`; an order can be consumed at most once; a revoked order cannot be used.
3. A signature cannot be replayed:
   - by another wallet;
   - after its deadline;
   - for another choice, look, URI or route;
   - after a signer rotation;
   - on another chain or contract.
4. **No minter** can choose or steer a random token's skin: not by timing, by chosen-skin mints around a reveal or a re-arm, by the order of secrets, or by revealing epochs out of order. The owner alone cannot either. For the signer, and the owner with a signer it controls, see 8.2.
5. Each reveal secret decides exactly one epoch and is opened only in chain order. A value the contract held, or one of the first 32 hashes above an anchor, can never become the commitment.
6. No epoch is sealed without a block hash that did not exist when its secret was fixed.
7. Packed storage is equivalent to the per-token draw (tested against an off-chain replica, including 25-token epochs).
8. A failing receiver, a reentrant token or a reentrant receiver cannot leave partial state (all-or-nothing).

## 7. Before mainnet (known differences)

- Remove the rehearsal guard `require(block.chainid != 1)` in the constructor; final contract and EIP-712 domain name
  (now `EmberEvoGenesisCandidate`, version `7`).
- Real EMBEO (a plain 18-decimal ERC-20: no fee-on-transfer, rebasing or hooks), final free-list snapshot, final
  metadata URIs, owner = multisig, signer key and reveal seed custody (separate secrets), Etherscan verification.
- A keeper that calls `settle` shortly after each seed block is 2 deep (through a private RPC), so published secrets are
  used at once. This is a **security assumption**, not only UX (8.2, *Liveness*): it alerts when a ready epoch is
  older than a few hundred blocks, far inside the 8,191-block window.
- Optional further gas cuts, not done here because they change other components:
  - free-list claims in a bitmap keyed by Merkle index;
  - sequential paid order ids in a bitmap;
  - a paid route that verifies only `PaidAuthorization`.

## 8. Known risks and open questions

1. **Signer compromise**: the signer key can approve any look or URI for any wallet, and also signs the GOLD
   authorization. A stolen key could therefore authorize paid mints without a GOLD hold (EMBEO is still burned on chain).
   Acceptable? What on-chain limits would you recommend?
2. **Randomness trust model** (rewritten in Submission 3; please assess):
   - **Minters.** A random token's epoch is fixed by its mint block, and that epoch's seed block (natural or re-armed) is always in the future at mint time. Chosen mints are frozen from the epoch's own seed block until it is revealed, re-arm or not. Reveal order is strict and the seed binds the token id. A minter changes no draw; it only shifts expected value (8.9).
   - **Owner alone.** It cannot set or replace the chain (needs the current signer's acceptance for that exact replacement: an unused acceptance signed earlier names a commitment that is no longer current) or rotate the signer (needs the new key's acceptance), so it cannot re-arm anything.
   - **Signer alone: building the seed block.** Since PBS, anyone can be a builder. The signer knows the secret, so if it builds or buys a seed block it can grind that block's hash and pick the outcome. Commit-reveal with a block hash cannot exclude this; a VRF could.
   - **Signer alone: withholding.** The signer knows an epoch's outcome as soon as its seed block is mined. If it dislikes it, it can withhold the secret for about 27 h (8,191 blocks) until the seed block expires. Nobody else can settle meanwhile, and chosen-skin mints revert all that time (visible). To make progress it must then publish the secret: the epoch is re-armed to the next block, whose hash it does not know when it publishes, and from then on anyone settles with no secret. So withholding buys **one fresh draw per epoch that the signer cannot predict** (unless it also builds that next block), never a chosen one. The same expiry also re-arms every later unsealed epoch whose seed block is earlier than the re-arm block. Those epochs keep their own secrets, so by timing one publication the signer chooses between two unpredictable families of draws for them. Withholding forever stalls random reveals and chosen mints; only a replaced commitment (owner + signer) gets past it.
   - **Owner and signer together** (or an owner that rotated the signer to a key it controls: paused, visible, `AppearanceSignerChanged`). A new commitment re-arms a closed epoch to a future block. That is allowed only `REARM_COOLDOWN` (7,200 blocks, about a day) after its current seed block, a pending re-arm included, with minting paused, and **at most 2 times per epoch**, counting the re-arms an epoch waiting behind another shared with it (each re-arm also re-draws every later closed epoch, so those inherit the count instead of starting again once the first is revealed). Each new chain is fixed before the block that decides with it, so each replacement is one more fresh draw, not a chosen one. Per epoch that is at most: the original draw, one after a withheld secret, and two replacements, each of which can again be withheld once. Every option costs at least a day, and each is visible on chain (`EpochRearmed`, `RevealCommitSet`, the pause). Mainnet owner = multisig.
   - **Builder of a re-armed block.** After an expiry, the epoch's secret is public before the re-armed block is built, and so are any secrets already handed out for later ready epochs. Whoever builds that block could grind it (audit 388b71cb, finding 6). This needs 8,191 blocks during which nobody settled. The keeper (section 7) makes it an alert-backed assumption rather than a design property.
   - **Liveness.** Once a secret is published, anyone can compute the epoch's outcome. If nobody settles for 8,191 blocks, the next call re-arms and that outcome is discarded. So a holder of a published secret who dislikes the outcome can hope for that, but any other party can settle first. Hence the keeper.
   - **Early knowledge.** A published secret tells everyone the epoch's outcome about a block before it is sealed. Nothing can change the counts in between (chosen mints are frozen), but holders of soon-to-be-common unrevealed tokens could sell first. The keeper settles at once.
   - **VRF.** With rarity-priced skins (48 gold of 1,288), the levers above are real, if bounded and visible. If "no one can steer" should be a property rather than a trust statement, mainnet could use a VRF instead (about 52 requests at 25 tokens per epoch). That would make the project pay reveal gas instead of minters, and would remove the expiry / re-arm logic. Is commit-reveal with these bounds acceptable for this collection?
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

Result 2026-10-27: **88 tests, 85 pass, 0 fail, 3 skipped** (a placeholder for formal-chain checks and two archived
tests). The GOLD book tests give 15 / 15. The suite includes a reproduction of every Submission 1 and Submission 2 finding
that changed code (FINDINGS_RESPONSE.md of both packages), plus:
- the double-expiry path (re-armed again, never secret-only), an expiry settled with no secret, and a replacement mined in the same block as an expiry re-arm;
- a full 25-token epoch checked against the off-chain draw;
- the paid route end to end: consent, GOLD held in the real book code, mint, burn, and settlement from the finalized chain reader.

## 10. Gas (local EDR, same bytecode as Sepolia)

| Step | Submission 1 (Osaka) | Submission 2 (Osaka) | Submission 3 (Osaka) | Submission 3 (Amsterdam / EIP-8037) |
|---|---|---|---|---|
| deploy | 5,470,330 | 5,446,759 | 5,503,361 | 38,571,195 |
| configureSnapshot | — | 123,847 | 79,703 | 241,343 |
| setRevealCommit | 57,537 | 70,622 | 64,463 | 145,283 |
| free chosen mint | 268,781 | 178,482 | 168,235 | 572,335 |
| paid random mint (first ever) | 328,870 | 240,228 | 231,458 | 716,378 |
| paid random mint (first in a later epoch, one pending) | — | 233,085 | 203,102 | 526,406 |
| paid random mint (second) | 242,530 | 188,089 | 177,297 | 419,745 |
| chosen mint revealing 2 | 372,121–392,665 | 232,999–233,551 | 203,186–204,290 | 606,998–607,838 |
| settle revealing 1 | 146,813 | 72,107–72,659 | 67,392–67,668 | 67,392–67,944 |
| chosen mint revealing a full epoch (25) | 669,187–670,913 | 290,742–296,010 | 280,877–286,949 | 524,717–529,409 |

Submission 3 before the storage repack (section 5) measured as Submission 2 within 0.1k on every row. The first
reveal also stops paying a zero-to-nonzero write for the reveal index. Deployment and setup together cost about 85k
more on Amsterdam (larger code), once.

Draw-dependent rows vary a little between runs. Sepolia has run Glamsterdam (EIP-8037) since 2026-10-06.
