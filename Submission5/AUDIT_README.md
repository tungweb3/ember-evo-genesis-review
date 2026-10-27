# Ember Evo Genesis — audit package, Submission 5 (2026-10-28)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters). Each token is a
look (body + clothes + accessories) chosen by the minter, plus a skin colour that is either chosen or revealed later at
random. This is the **fifth pre-audit** of the release candidate. It answers the fourth audit
(Submission 4, explorer.imd.fun job b0b1d96a: 2 low, 1 info). The per-finding answers, with the test that
reproduces each one, are in [FINDINGS_RESPONSE.md](FINDINGS_RESPONSE.md).

The changes are narrow:
- **A reveal-commitment acceptance signs a recent block's number and hash instead of a deadline** (finding 1). It cannot
  be made before that block exists, and the contract takes it only while `blockhash()` still knows the block (256
  blocks, about 51 minutes). Its age is bounded by the chain, not by the deadline a signer chooses. Only
  `setRevealCommit` changed; minting is untouched.
- **What one withheld secret buys is restated** (finding 2, documentation only): it also reaches the later epochs whose
  seed blocks age during the same withhold (section 8.2, *Signer alone: withholding*).
- **The GOLD book's stored-hold check compares the domain version and the recipient with the deployment's registry
  entry** (finding 3), not with "5 or 7" and "any non-zero address".

Mint gas is unchanged (section 10); runtime code grew by 5 bytes (section 2).

Submission 4 (the previous package) already carried these owner decisions (2026-10-28), unchanged here:
- **The payment goes to a treasury, not a burn address.** `BURN_ADDRESS` is gone. `paymentRecipient` is an immutable
  set at deployment; on mainnet it is the project's Safe multisig (2 of 3,
  `0x29e7c208481f648795f677b55F6ECb2bADc2F01E`). The exact-payment checks now apply to that address.
- **The paid price is 20 imdUSD + 1,200 GOLD.** imdUSD (`0x61aA…2a25`, 18 decimals) replaces EMBEO as the payment token.
  Token and price were already deployment parameters, so this changes no code. On Sepolia a valueless `TestUSD` (tUSD)
  stands in.
- **Supply is 1,688:** skin caps 1,068 / 218 / 218 / 68 / 68 / 48.
- **Resale royalty 2.5% to the treasury** (ERC-2981, fixed).

And Submission 4's gas review (section 5, *Free mint* and *Paid mint*; section 10):
- free claims are one bit per free-list index (`mintFree` takes the index; the Merkle leaf includes it);
- the paid route checks one signature, a `PaidAuthorization` the contract rebuilds from its own values, so the call
  carries only the order id and deadline (the `Appearance` signature, the order struct, `expectedRecipient` and
  `expectedCost` are gone);
- the redundant `totalSupply` comparison around the payment is removed.
A paid mint costs about 14.7k gas less than in Submission 3, a free mint one storage slot less, and the code is 1.0 KB
smaller.

## 1. Scope

| In scope | File | Notes |
|---|---|---|
| **Primary** | `contracts/EmberEvoGenesisCandidate.sol` (676 lines) | the NFT contract (ERC-721, OpenZeppelin 5.4.0) |
| Secondary (trust model, integration) | `offchain/signer/*.mjs` | approval signer (Cloudflare Worker): signs EIP-712 mint approvals, hands out the committed reveal secrets (`reveal-chain.mjs`; Submission 5: `signRevealCommit` signs a block) |
| Secondary (trust model, integration) | `offchain/gold-book/**` | off-chain GOLD ledger: holds and settles GOLD for paid mints from finalized chain facts. Changed in Submission 5: a hold's binding carries the registry's domain version and recipient, and the stored hold document must match them (`world-gold.ts`, `world-gold-result.ts`, `genesis-gold.ts`) |

Out of scope: `contracts/test/*` (fixtures), `contracts/testnet/TestEmbeo.sol` and `TestUSD.sol` (Sepolia test tokens with a public
faucet, never on mainnet), OpenZeppelin, the mint web page, the Sepolia test-GOLD faucet. `tools/` holds the deploy and
Etherscan-verification scripts (for reference: the setup order before minting opens).

## 2. Build (reproducible)

- Compiler **solc 0.8.38+commit.1835d247** (official `soljson-v0.8.38+commit.1835d247.js`, SHA-256
  `6c74ffba0ea4cf9521e78b16052a98208770bb7677616de08ced239f4312d390` as in binaries.soliditylang.org `list.json`),
  optimizer on (200 runs), **viaIR**, EVM **cancun**.
- `build/standard-input.json` is the exact standard-JSON input (44 sources incl. OpenZeppelin 5.4.0; SHA-256
  `9a142ac6b357a641c684ef1bdb63247e093d1d797af82cde074420e45d5bbf0b`). It reproduces the deployed bytecode
  (Etherscan: exact match). `build/build-receipt.json` has per-source and per-artifact SHA-256. Only the contract
  source differs from Submission 4's input; compiler and settings are the same.
- `contracts/EmberEvoGenesisCandidate.sol` SHA-256 `a038820e0e00754de93f8352e0860752d818f2ff0af78d988e4ae264b5458761`.
- Runtime size 23,451 bytes (limit 24,576; Submission 4: 23,446). No compiler warnings for the contract apart from solc's generic note on
  transient storage: it is used for the reentrancy guard, which is cleared on exit, and for the one-paid-mint-per-caller
  marker (section 8.7).

## 3. Test deployment (Sepolia, chain 11155111)

| | |
|---|---|
| Contract | `0x6A7626c15C4746DA348E4D11F6f38228C743d25d` — **verified on Etherscan (exact match)**: https://sepolia.etherscan.io/address/0x6A7626c15C4746DA348E4D11F6f38228C743d25d#code |
| Deploy block | 12008266 (record: `deployment/11155111-1793141907357.json`) |
| On-chain runtime code hash | `0xfde48e7a4c1a459568f5111e102aaac5fef802396eabc9ba066b699f09cf1278` (same length as the artifact; the differing bytes are all immutable slots) |
| Reveal commitment at deploy | `0xa69f3210e358f30a94018a4d9497fe3b3e04766a84b7feac7eb99a5d680702eb` (chain length 4,608, fresh seed for this deployment, accepted by the signer on chain over a block two below the head) |
| Payment token (test) | `0x453f257995B8f93137E63C8E9E9e6a106D03BfD5` (TestUSD "tUSD", 18 decimals, public faucet; stands in for imdUSD) |
| Payment recipient | `0x29e7c208481f648795f677b55F6ECb2bADc2F01E` (the mainnet treasury Safe's address; on Sepolia only an address) |
| Price | 20 tUSD + 1,200 GOLD per paid mint; supply 1,688 |
| Approval signer | `0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d` |
| Owner | `0x5cF561D7EEB76dBd688127893Bb362C9A819f66D` (test EOA; mainnet: a multisig) |

Setup transactions, in order: `configureSnapshot`, `setRevealURIs(…, lock=true)`,
`setRevealCommit(commit, blockNumber, signerAcceptance)`, `setMintPaused(false)`, `approvePaidPrice`.
Earlier deployments (`0xD5f3…F8Af` = Submission 4, `0x0FB5…4085` = Submission 3, `0xb972…a836` = Submission 2, `0x8ce6…2efa` = Submission 1,
`0x7028…9a93`) are retired.

## 4. Roles and privileges

- **Owner** (`Ownable2Step`; `renounceOwnership` always reverts):
  - Supply: `configureSupply` (only until the supply is fixed: a token exists, minting has opened, or `lockSupply`), `lockSupply`.
  - Setup and opening: `configureSnapshot` (once, before any mint), `setMintPaused` (opening needs the snapshot, locked reveal URIs and a reveal commitment: `OPEN_NOT_READY`).
  - Reveal: `setRevealCommit` (only while paused and with the signer's acceptance; at most 2 re-arms per epoch, see section 5), `setRevealURIs` (until locked).
  - Payment: `approvePaidPrice` (irreversible; the price itself is immutable), `revokePaidOrder`. The payment token, the price and `paymentRecipient` are all fixed at deployment; there is no setter for any of them.
  - Metadata: `setTokenURI` (override for a chosen-skin token, until `lockTokenURIs`), `lockTokenURIs`.
  - Signer rotation, only while paused: `proposeAppearanceSigner` → `activateAppearanceSigner` with the new signer's EIP-712 acceptance; `cancelAppearanceSignerProposal`.
- **Approval signer** (`appearanceSigner`, an EOA held by the off-chain signer service):
  - Signs `Appearance` (wallet, lookKey, choice, uriHash, deadline, signerEpoch, **paid** = false) for every free mint, `PaidAuthorization` (orderId, wallet, lookKey, choice, uriHash, recipient, cost, goldCost, deadline, signerEpoch) for every paid mint (since Submission 4 the paid route takes only this one signature), and `RevealCommitAcceptance` (commit, **previous**, signerEpoch, **blockNumber, blockHash**) for every reveal commitment: `previous` is the commitment it replaces, and the block is a recent one the signer saw, so one acceptance allows one replacement, and only while `blockhash(blockNumber)` is still known (256 blocks, about 51 minutes; Submission 5).
  - `signerEpoch` increments on rotation and invalidates all older signatures.
  - Holds the **reveal seed** (a separate secret) and publishes each secret once its epoch's seed block is 2 blocks deep.
- **Anyone**: `settle(reveals)` seals and reveals every ready epoch it has secrets for (an expired epoch needs none), even while minting is paused. The caller has no choice over the outcome: a secret either opens the commitment or is ignored. Its only lever is timing, see 8.2 (*Liveness*).

## 5. Flows

**Free mint** `mintFree(lookKey, choice, uri, deadline, signature, index, proof, reveals)` (changed in Submission 4):
- The wallet must be in the Merkle snapshot at `index`: leaf = keccak256(keccak256(abi.encode(index, wallet))), the list sorted by lowercase address with duplicates removed. One claim per index, kept as one bit in a word shared by 256 indices (`freeClaimed(index)`), so a listed wallet has exactly one free mint. Not before `freeStartAt`.
- Needs the signer's `Appearance` with `paid = false`. Free eligibility does not reserve supply.

**Paid mint** `mintPaid(lookKey, choice, uri, orderId, deadline, goldSignature, reveals)` (changed in Submission 4):
1. The signer holds the order's GOLD in the off-chain book (after the wallet signs an EIP-712 "Ember World GOLD" consent), then signs `PaidAuthorization`.
2. The contract rebuilds that `PaidAuthorization` from the call and its own values (wallet = caller, recipient = `paymentRecipient`, cost = `paidCost`, goldCost = `paidGoldCost`, the current `signerEpoch`) and checks the signer's signature over it, then consumes `orderId` once. An order signed for any other wallet, look, choice, URI, recipient, price, GOLD cost, epoch, order id or deadline fails the signature check.
3. It moves exactly `paidCost` from the minter to `paymentRecipient` (the treasury Safe; until Submission 3 a fixed burn address) and checks that the minter lost and the recipient gained exactly that amount (fee-on-transfer and burn-on-transfer tokens are rejected; Submission 3's extra `totalSupply` comparison added nothing to this and was removed). A minter that is the recipient itself fails the balance check. The constructor refuses a zero recipient, the contract itself and the payment token.
4. One paid mint per caller per transaction (transient marker).
5. The book settles the hold from **finalized** chain facts: the order's `PaidOrderConsumed` log and the `GenesisMinted` log for that wallet and token id in the same receipt, with the contract's code hash pinned. Since Submission 2 it does not look at `receipt.to`, so smart-wallet and bundled mints settle. Otherwise the hold is released after the deadline.

**Skins**:
- Choices 0–2 fix the skin at mint (per-skin caps). Choice 3 is random.
- Random tokens are grouped in 25-block epochs (at most 25 random mints per epoch) and revealed strictly in epoch order.
- Draws are weighted by the remaining capacity of each skin, so the caps (sum = max supply) always hold.

**Randomness (commit-reveal)**

*The commitment.*
- The signer derives a hash chain from a 32-byte seed: `x[N] = seed`, `x[i-1] = keccak256(x[i])`, N = 4,608 (one secret per epoch; more than enough, since an expiry no longer uses one up).
- The owner stores `x[0]` with `setRevealCommit(x0, blockNumber, acceptance)`, where `acceptance` is the signer's EIP-712 signature over (commit, previous, signerEpoch, blockNumber, blockHash) and the contract supplies `blockHash = blockhash(blockNumber)`. A zero hash (a block not mined yet, or more than 256 blocks old) reverts `REVEAL_ACCEPTANCE_EXPIRED`; EIP-2935 is deliberately not used here. So an acceptance can only have been signed after that block existed and is usable for at most 256 blocks after it, far less than `REARM_COOLDOWN` (Submission 5, audit b0b1d96a finding 1; Submission 4's signed deadline bounded only the time left before it).
- The contract refuses a value it has held, and the first 32 hashes above each anchor (their preimages are public): it walks each chain it has held, current and replaced. This guards against operator error; it cannot prove a chain is fresh, which is what the signer's acceptance is for.

*Sealing and revealing.*
- An epoch is *ready* once its seed block is mined: the first block after the epoch, or a later re-arm block.
- `settle` and every mint first look, for the next ready epoch, for the secret in `reveals` that opens the current commitment (in any order). They seal with seed = `keccak256(abi.encode(h, secret, e, address(this)))`, where `h` is the seed block's hash (`blockhash`, else the EIP-2935 history contract), then reveal all of its tokens **in the same call**. They repeat while secrets last.
- The seed is not stored; `EpochSealed` records it with the block hash and the secret, so anyone can recompute every draw.

*When the signer hands out secrets.*
- Only after the seed block is **2 blocks deep** (`readyReveals`, endpoint `GET /v1/reveals`).
- It never hands out a secret that comes after one whose seed block is about to leave the hash window.
- Nothing for an epoch whose secret is already opened (`epochSecretOpened(e)`, see *Expiry*).

*Expiry (Submission 3; narrowed in Submission 4).*
- If `h` is no longer available (older than the EIP-2935 window of 8,191 blocks), the epoch is not sealed. The supplied secret **stays the epoch's secret**: it is now public and is kept in `revealCommit`. **That epoch alone** is re-armed to `block.number + 1`. Later epochs keep their own seed blocks; one whose seed block has expired as well goes through the same step when its turn comes. Those later seed blocks age during the same wait, so one withheld secret can reach them too: see 8.2, *Signer alone: withholding* (audit b0b1d96a, finding 2).
- Once that block is mined, any call (`settle([])` or any mint) seals the epoch with that block's hash and the kept secret; no secret has to be supplied. If that block expires as well (no call for 8,191 blocks), the next call re-arms again, with the same secret.
- So an epoch is never sealed by a secret alone (`EpochSealed.blockHash` is never zero), the signer is never needed again for that epoch, and later epochs keep their own secrets.

*Re-arm (bookkeeping changed in Submission 4).*
- Two kinds, kept apart in one slot (`revealState`):
  - **Commitment re-arm**: the block set by the last new commitment that re-armed an epoch, and the block of the one before it. Every unsealed epoch that had closed when the commitment was set takes the later of its own seed block and that block, because its secret now comes from a chain fixed after its own seed block was public.
  - **Expiry re-arm**: one block and the one epoch it applies to. Only that epoch takes it; it is also the epoch whose secret is opened (`epochSecretOpened`). A new commitment clears it, because that chain is replaced.
- `epochSeedBlock(e)` = the latest of: e's own seed block, the last commitment re-arm block, and the expiry re-arm block if it is e's.
- Replacing the commitment once the next epoch has **closed** (its own seed block is reached) re-arms it. That is allowed only **REARM_COOLDOWN = 7,200 blocks** (about a day) after its current seed block, a pending re-arm included, so anyone holding a published secret can settle first; and at most **MAX_COMMIT_REARMS = 2** times per epoch (`EPOCH_REARM_LIMIT`).
- The count is the number of the last two commitment re-arm blocks that come after the epoch's own seed block: the commitments set after it closed. An epoch waiting behind a re-armed one is re-drawn by the same replacements, so it shares their count; an expiry re-arm, or a commitment set before the epoch closed, never counts. The next epoch to reveal is always the oldest, so its count bounds every epoch behind it. After two, the epoch can only be settled with the chain it has.

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
- `revealState`, one slot: reveal index (bits 0-31), random-epoch count (32-63), the last two commitment re-arm blocks
  (64-103, 104-143; 40 bits each), the expiry re-arm block (144-183) and its epoch (184-215).
- The random-epoch list: 32 bits per epoch, 8 per word (`randomEpochWords`).
- Per token: its look key, plus 4 bits in a word shared by 64 tokens (random flag, skin + 1).
- Per epoch: its random token ids, 16 bits each, in two slots.
- Free claims: one bit per free-list index, 256 per word (`freeClaimedBits`; Submission 4, was a `bool` per wallet).
- `maxSupply`, `pendingRandom`, `chainSecrets` and `tokenLook` are views (paid mints = `totalMinted` - `freeMinted`).

**Royalty (Submission 4)**: ERC-2981 `royaltyInfo` returns 2.5% (`ROYALTY_BPS` = 250) of the sale price to
`paymentRecipient` for every token; `supportsInterface(0x2a55205a)` is true. It is fixed: there is no setter.
Marketplaces read it; whether they enforce it is up to them.

## 6. Intended properties (please try to break these)

1. Supply never exceeds `maxSupply`; per-skin counts never exceed their caps; every random token gets a skin.
2. A paid mint pays exactly `paidCost` to `paymentRecipient` and nowhere else; an order can be consumed at most once; a revoked order cannot be used.
3. A signature cannot be replayed:
   - by another wallet;
   - after its deadline;
   - for another choice, look, URI or route (a free `Appearance` cannot pay for a paid mint, a `PaidAuthorization` cannot mint free);
   - for another recipient, price or GOLD cost (paid route);
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
- Payment token imdUSD `0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25` (verified on Etherscan: a plain 18-decimal ERC-20
  whose only privileged functions are mint and burn by its vault; no pause, blacklist, fee or proxy), price
  `20e18`, `paymentRecipient` = the treasury Safe `0x29e7c208481f648795f677b55F6ECb2bADc2F01E` (Safe v1.5.0, 2 of 3, no
  modules or guard; a test transfer out of it with two signatures has succeeded). Final free-list snapshot, final metadata
  URIs, owner = multisig, signer key and reveal seed custody (separate secrets), Etherscan verification.
- The free-list root must be built with signer/free-approval.mjs snapshotTree (as 	ools/deploy-testnet.mjs does): it
  removes duplicate wallets and uses the leaf with the index. The contract cannot see duplicates: a wallet listed twice
  would get two free mints, and configureSnapshot can be called only once.
- With the owner a multisig, a `setRevealCommit` must be executed within 256 blocks (about 51 minutes) of the block the
  signer's acceptance names (Submission 5); otherwise the signer signs again over a newer block.
- A keeper that calls `settle` shortly after each seed block is 2 deep (through a private RPC), so published secrets are
  used at once. This is a **security assumption**, not only UX (8.2, *Liveness*), and it covers only epochs whose
  secret is public (published by the signer, or opened by an expiry). It alerts when a ready epoch is older than a few
  hundred blocks, far inside the 8,191-block window, and also when a ready epoch has no published secret (signer outage
  or withholding): the keeper cannot settle such an epoch, only report it. Such an alert concerns the **whole backlog**
  behind that epoch, not only the epoch itself (8.2, *Signer alone: withholding*; audit b0b1d96a, finding 2).
- Gas cuts: two of the three listed in Submission 3 are done in Submission 4 (free claims in a bitmap keyed by the
  free-list index; a paid route that verifies only `PaidAuthorization`). The third, sequential paid order ids in a
  bitmap, is not: the off-chain GOLD book reads `paidOrderTokenId(orderId)` and would have to change with it.

## 8. Known risks and open questions

1. **Signer compromise**: the signer key can approve any look or URI for any wallet, and also signs the GOLD
   authorization. A stolen key could therefore authorize paid mints without a GOLD hold (the 20 imdUSD is still paid to
   the treasury on chain).
   Acceptable? What on-chain limits would you recommend?
2. **Randomness trust model** (rewritten in Submission 3, corrected in Submission 4 after audit d726b1cd and in Submission 5 after audit b0b1d96a; please assess):
   - **Minters.** A random token's epoch is fixed by its mint block, and that epoch's seed block (natural or re-armed) is always in the future at mint time. Chosen mints are frozen from the epoch's own seed block until it is revealed, re-arm or not. Reveal order is strict and the seed binds the token id. A minter changes no draw; it only shifts expected value (8.9).
   - **Owner alone.** With the current signer in place it cannot set or replace the chain: that needs the signer's acceptance for that exact replacement (it names the commitment it replaces) and signs a recent block that the contract must still see in `blockhash()`, so a spare acceptance cannot be kept for later: it is unusable 256 blocks after the block it names, whatever the signer would have chosen as a deadline (Submission 5; in Submission 4 a far deadline could keep one usable in its last hour, audit b0b1d96a finding 1). But the owner can **rotate the signer to a key it holds**: `proposeAppearanceSigner` + `activateAppearanceSigner` need only the new key's acceptance, not the outgoing signer's, and no delay. After that rotation, which is visible (minting paused, `AppearanceSignerChanged`), the owner alone has every power of *owner and signer together* below for chains it makes; it never learns the old chain's unpublished secrets. Mainnet owner = multisig. A rotation delay, or the outgoing signer's co-signature, would close this; we would like your view on whether it is worth the code.
   - **Signer alone: building the seed block.** Since PBS, anyone can be a builder. The signer knows the secret, so if it builds or buys a seed block it can grind that block's hash and pick the outcome. Commit-reveal with a block hash cannot exclude this; a VRF could.
   - **Signer alone: withholding.** The signer knows an epoch's outcome as soon as its seed block is mined. If it dislikes it, it can withhold the secret. Nobody else can settle meanwhile (the keeper has no secret to settle with), and chosen-skin mints revert all that time (visible). After about 27 h (8,191 blocks) the seed block expires. To make progress the signer must then publish the secret in a `settle`, and it chooses the block that call lands in (its own, or a builder it pays), which makes the next block the re-arm block. From then on anyone settles with no secret. So a withhold buys **one fresh draw for that epoch**: one the signer cannot predict when it publishes, unless it also builds or buys that next block (see *Builder of a re-armed block*). It is never a chosen draw, and the signer cannot repeat it for that epoch, because the secret is public from then on. Since Submission 4 the expiry re-arm itself moves **only that epoch** (in Submission 3 it also moved later epochs, so a backlog compounded). **But one withhold reaches further than that epoch** (restated in Submission 5 after audit b0b1d96a, finding 2). The later epochs' secrets sit deeper in the same chain, so nobody but the signer can settle them while it withholds the one ahead, and their seed blocks age during the same wait:
     - epochs that share the last commitment re-arm block expire at the same moment, so each of them is re-drawn as its turn comes, with no further withhold;
     - epochs on their own natural seed blocks (25 blocks apart) give the signer, who already knows their outcomes, a choice once the epoch ahead is sealed: publish the next secret and keep that outcome, or wait about 25 more blocks per epoch (not another 8,191) for a fresh draw.
     So one visible withhold of about 27 hours buys a keep-or-redraw choice (never a chosen draw) for every random epoch that closed during it. Random mints are not stopped by a pending reveal, so that backlog can grow to about 8,191 / 25 epochs. This is signer trust only: no minter or owner gains a lever. Withholding forever stalls random reveals and chosen mints; only a replaced commitment (owner + signer) gets past it.
   - **Owner and signer together** (or an owner that rotated the signer to a key it controls: paused, visible, `AppearanceSignerChanged`). A new commitment re-arms a closed epoch to a future block. That is allowed only `REARM_COOLDOWN` (7,200 blocks, about a day) after its current seed block, a pending re-arm included, with minting paused, and **at most 2 times per epoch**, counting only the replacements set after the epoch closed; an epoch waiting behind another shares them (each replacement also re-draws every later closed epoch, so those do not start again once the first is revealed). Each new chain is fixed before the block that decides with it, so each replacement is one more fresh draw, not a chosen one. The cooldown counts from the epoch's **own** current seed block. An epoch waiting behind one that expired keeps its own block, so once the epoch ahead is sealed it may already be past the cooldown, and its secret may already have been handed out. A replacement then re-draws it at once. That is still owner and signer together: it needs a fresh acceptance from the signer, which knew the outcome anyway. It is one of the 2 replacements, and it is visible. (In Submission 3 the expiry also moved that epoch, which restarted its cooldown but compounded its draws: finding 2.) The code bounds the replacements; it does **not** bound expiry re-arms. Once a secret is public, a further expiry re-arm needs 8,191 more blocks in which nobody settles the epoch, and the keeper exists to prevent that. With the keeper settling, the draws per epoch are at most: the original, one after a withheld secret, and two replacements, each of which can again be withheld once. Every option costs at least a day, and each is visible on chain (`EpochRearmed`, `RevealCommitSet`, the pause). Mainnet owner = multisig.
   - **Builder of a re-armed block.** After an expiry, the epoch's secret is public before the re-armed block is built, so whoever builds that block could grind it (audit 388b71cb, finding 6). This is **not** only a keeper question. In the withholding case above, the signer produces the 8,191 idle blocks itself and picks the block its `settle` lands in, so it can build, or pay the builder of, the block that decides. The "fresh draw" after a withhold therefore assumes that the signer does not control that one block. The epochs behind it that are re-armed in turn (see *withholding* above) are exposed the same way. A second expiry of an epoch whose secret is already public needs 8,191 more blocks with no call at all. That is what the keeper prevents (section 7). If these assumptions are not acceptable for 48 gold skins, the VRF option below is the alternative.
   - **Liveness.** Once a secret is published, anyone can compute the epoch's outcome. If nobody settles for 8,191 blocks, the next call re-arms and that outcome is discarded. So a holder of a published secret who dislikes the outcome can hope for that, but any other party can settle first. Hence the keeper.
   - **Early knowledge.** A published secret tells everyone the epoch's outcome about a block before it is sealed. Nothing can change the counts in between (chosen mints are frozen), but holders of soon-to-be-common unrevealed tokens could sell first. The keeper settles at once.
   - **VRF.** With rarity-priced skins (48 gold of 1,688), the levers above are real, if bounded and visible. If "no one can steer" should be a property rather than a trust statement, mainnet could use a VRF instead (about 52 requests at 25 tokens per epoch). That would make the project pay reveal gas instead of minters, and would remove the expiry / re-arm logic. Is commit-reveal with these bounds acceptable for this collection?
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

(with `WORLD_SOURCE` pointing at the GOLD book source, which the faucet tests need).

Result 2026-10-28: **96 tests, 93 pass, 0 fail, 3 skipped** (a placeholder for formal-chain checks and two archived
tests). The GOLD book's Genesis tests give 18 / 18 (new: the stored-hold check takes domain version and recipient from
the binding, audit b0b1d96a finding 3). The suite includes a reproduction of every Submission 1–4 finding that changed
code (FINDINGS_RESPONSE.md of each package), plus:
- an expiry after a commitment re-arm: the later epoch stays on the commitment's block, never back on its own (whose hash
  was public before that chain was set);
- the double-expiry path (re-armed again, never secret-only), an expiry settled with no secret, and a replacement mined in the same block as an expiry re-arm;
- a full 25-token epoch checked against the off-chain draw;
- the paid route end to end: consent, GOLD held in the real book code, mint, payment to the treasury, and settlement
  from the finalized chain reader;
- the paid route refuses a validly signed order for another wallet, look, choice, URI, recipient, price, GOLD cost,
  signer epoch, order id or deadline, an order signed under another domain, and either `Appearance` as its signature;
- free claims: another wallet's index or proof is refused, a claimed index cannot claim again, and indices on both sides
  of a 256-bit word boundary work;
- ERC-2981: the interface id, 2.5% to the treasury for several prices, no setter;
- reveal-commitment acceptances (Submission 5): one naming a future block or a wrong hash is refused; a spare one is
  accepted 254 blocks after its block and refused 257 blocks after it.

## 10. Gas (local EDR, same bytecode as Sepolia)

All builds measured with the same script (Submission 3 and 4 columns as published in Submission 4):

| Step | Submission 3 (Osaka) | Submission 4 (Osaka) | **Submission 5 (Osaka)** | Submission 4 (Amsterdam / EIP-8037) | **Submission 5 (Amsterdam)** |
|---|---|---|---|---|---|
| deploy | 5,503,361 | 5,291,948 | **5,293,100** | 37,044,226 | **37,052,028** |
| setRevealCommit | 64,463 | 64,557 | **64,542** | 145,365 | **145,374** |
| free chosen mint (the first in its group of 256: opens a bitmap word) | 168,235 | 168,623 | **168,623** | 572,723 | **572,723** |
| free chosen mint (any other), also revealing 2 | 202,898 | 188,940 | **186,180** | 509,736 | **509,460** |
| paid random mint (first ever) | 231,458 | 216,718 | **216,706** | 701,638 | **701,638** |
| paid random mint (second) | 177,297 | 162,593 | **162,593** | 405,041 | **405,053** |
| paid random mint (first in a later epoch, one pending) | 217,158 | 202,406 | **202,418** | 606,518 | **606,518** |
| settle revealing 1 | 67,392 | 68,332 | **67,504** | 67,504 | **67,504** |
| chosen paid mint revealing a full epoch (25) | 283,625 | 263,902 | **265,258** | 507,994 | **509,950** |

Submission 5 changes only `setRevealCommit`; every mint row is the same as Submission 4 within the run-to-run variation
of the draws (reveal rows depend on which skins are drawn). Submission 4's gas review: a paid mint saves about 14.7k gas (one signature check, no order struct in calldata, no `totalSupply` calls); a free
mint saves a new storage slot (about 14–17k on Osaka, about 98k on Amsterdam, where new state is priced much higher),
except the first claim in each group of 256. The treasury recipient (an immutable instead of a constant) costs about
450 gas per paid mint, included above. Runtime code is 1.0 KB smaller than Submission 3. Earlier submissions' gas is in
their own packages.

Submission 3 before the storage repack (section 5) measured as Submission 2 within 0.1k on every row. The first
reveal also stops paying a zero-to-nonzero write for the reveal index. Deployment and setup together cost about 85k
more on Amsterdam (larger code), once.

Draw-dependent rows vary a little between runs. Sepolia has run Glamsterdam (EIP-8037) since 2026-10-06.
