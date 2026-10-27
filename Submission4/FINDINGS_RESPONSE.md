# Submission 3 findings → Submission 4

Audit job: explorer.imd.fun d726b1cd (code at commit ebbd946). Test names are in `tests/contract/r5.test.mjs`. "Fixed"
means the code changed and the named test, written from the finding's reproduction, passes on Submission 4. Each of the
five new tests also **fails on Submission 3's build** (checked by running them against the deployed artifacts). The
Foundry proofs in the report were ported to the project's own Hardhat EDR harness; they were not run as Foundry tests.

## The bookkeeping change behind findings 1 and 2

Submission 3 kept one re-arm record of either kind (block, first epoch, expired flag, commitment count), and every
unsealed epoch from that first epoch on took the record's block. That made an expiry re-arm move every later closed
epoch (finding 2), and made an epoch inherit a count from re-arms that never moved it (finding 1).

Submission 4 keeps the two kinds apart, in the same slot:
- **commitment re-arms**: the blocks of the last two. Every unsealed epoch that had closed when a commitment was set takes
  that block, as before: its secret now comes from a chain made after its own seed block was public, so it must not fall
  back to that block. An epoch's count is how many of those two blocks come after its own seed block.
- **the expiry re-arm**: one block and one epoch. Only that epoch takes it. A new commitment clears it.

We did not take the report's suggested fix for finding 2 (`e == from` when the expired flag is set) as written. If a
commitment re-arm had moved a later epoch and the earlier epoch then expired, that later epoch would have fallen back to
its own seed block, whose hash was public before its new chain was chosen. Keeping the last commitment block separately
avoids that; the test "audit d726b1cd finding 2 (no regression) …" covers it.

| # | Sev. | Finding | Done | Change | Test |
|---|---|---|---|---|---|
| 1 | Low | `_commitRearms` charges an epoch with re-arms that never moved it (an expiry re-arm, or a commitment set before it closed), so a replacement README 5 / 8.2 allow reverts `EPOCH_REARM_LIMIT` | Fixed | Count = how many of the last two commitment re-arm blocks come after the epoch's own seed block; expiry re-arms never count. L-1 (an epoch waiting behind a re-armed one shares its re-arms) still holds | "audit d726b1cd finding 1 (reproduction, instance a): …", "… (reproduction, instance b): …"; L-1 and 388b71cb finding 4 tests unchanged and passing |
| 2 | Low | An expiry re-arm moves every later closed epoch, so a withholding signer compounds draws across a backlog | Fixed | An expiry re-arm moves only its own epoch; a later epoch keeps its seed block (natural, or the last commitment block) and goes through its own expiry if that block has expired too | "audit d726b1cd finding 2 (reproduction): …", "audit d726b1cd finding 2 (no regression): …" |
| 3 | Low | README 8.2 / 7 state the keeper assumption for the wrong path | Documented | README 7: the keeper covers only epochs whose secret is public, and alerts on a ready epoch with no published secret. README 8.2: the withholding signer forces the expiry and picks the block its `settle` lands in, so the fresh draw assumes it does not control the next block; expiry re-arms are not bounded by code, only by someone settling within the window | — |
| 4 | Low | A spare `RevealCommitAcceptance` stays usable by the owner alone until the chain's first secret is opened | Fixed | `setRevealCommit` requires `now <= deadline <= now + 1 hour` (`ACCEPTANCE_WINDOW`), far below `REARM_COOLDOWN`. The deploy tool already signs with `latest block time + 3600` | "reveal commitment: …" (deadlines 30 days and 3,700 s ahead refused) |
| 5 | Low | `readyReveals` reads `revealCommit` and `nextRevealIndex` at different heights | Fixed | Every contract read in `readyReveals` uses `{blockTag: latest}`, the block number it reports. A read that fails (a load-balanced RPC node one block behind) is retried from a fresh block number, twice at most | "audit d726b1cd finding 5: readyReveals pins every contract read to the block it reports" |
| 6 | Info | README 8.2 says the owner alone cannot rotate the signer | Documented | 8.2 *Owner alone*: the owner can rotate to a key it holds (visible, while paused) and then has the owner + signer powers; a rotation delay or co-signature is listed as an open question | — |

## Internal review of these fixes (2026-10-28)

An independent review of the diff found no correctness bug. It raised two points, both handled:
- **The cooldown after an expiry.** An epoch waiting behind an expired one keeps its own seed block, so it can be past
  `REARM_COOLDOWN` as soon as the one ahead is sealed. A replacement then needs the signer's fresh acceptance and is one
  of the two allowed. This is documented in README 8.2 (*Owner and signer together*); no code change.
- **Availability of the pinned reads.** These are now retried, as described for finding 5.

## Other effects

- Runtime size: the audit fixes alone give 24,431 bytes (Submission 3: 24,435); with the owner changes and the gas review
  below, 23,446 (limit 24,576). The deadline check uses one unchecked subtraction: a past deadline
  wraps around and fails the same `<= ACCEPTANCE_WINDOW` comparison, with the same `REVEAL_ACCEPTANCE_EXPIRED` message.
- Gas: the audit fixes are within 1% of Submission 3; the gas review below cuts a paid mint by about 14.7k and a free
  mint by one storage slot (README section 10).
- The signer's `EXPIRY_MARGIN` rule (no later secret after one whose seed block is near expiry) is kept as a margin; it is
  no longer needed for safety, since an expiry no longer moves later epochs.
- No change to the EIP-712 domain (still version `7`) or any event signature.

## Owner changes in the same build (2026-10-28, not audit findings)

| Change | Where | Test |
|---|---|---|
| Payment to `paymentRecipient`, an immutable set at deployment (mainnet: the treasury Safe), instead of `BURN_ADDRESS`. The constructor refuses zero, the contract itself and the payment token | contract constructor and `mintPaid`; signer `paid-approval.mjs` reads it from the contract; the page checks the order against it | "owner 2026-10-28: the payment goes to paymentRecipient …", "owner 2026-10-28: deployment refuses a zero recipient …"; `tests/signer/paid.test.mjs` end to end |
| Price 20 imdUSD + 1,200 GOLD (deployment parameters; Sepolia uses TestUSD) | deploy tool and config | "R6 price (owner 2026-10-28) …" |
| Supply 1,688 = 1,068 / 218 / 218 / 68 / 68 / 48 | constructor default caps | `tests/contract/r6-supply.test.mjs`, the end-game and 1,688-mint replica tests |
| GOLD book: the registry names each deployment's recipient; the stored hold document accepts domain version 7 (it refused v7 deployments, a bug found while doing this) and the registry's recipient | `offchain/gold-book/server/genesis-gold.ts`, `world-gold-result.ts` | `tests/gold-book/genesis-gold.test.mjs` (two new tests) |
| Resale royalty: ERC-2981 `royaltyInfo`, 2.5% to `paymentRecipient`, fixed; `supportsInterface(0x2a55205a)` | contract | "owner 2026-10-28: ERC-2981 royalty of 2.5% …" |

## Gas review before deployment (2026-10-28)

| Change | Where | Test |
|---|---|---|
| Free claims: one bit per free-list index; `mintFree(…, index, proof, …)`, leaf = keccak256(keccak256(abi.encode(index, wallet))); `freeClaimed(uint256 index)` | contract; signer `free-approval.mjs` (`snapshotTree` leaves and `indexOf`, eligibility); page `chain.mjs` | "gas review 2026-10-28: free claims are one bit per free-list index …"; every free-mint test |
| Paid route: one signature. `mintPaid(lookKey, choice, uri, orderId, deadline, goldSignature, reveals)` rebuilds the `PaidAuthorization` from the caller and the contract's recipient, prices and signer epoch | contract; signer `paid-approval.mjs` (no `Appearance` for paid mints); page `chain.mjs` | `tests/contract/concurrent.test.mjs` "absent/malformed/wrong-domain GOLD authority …" now signs each altered order validly and still gets `GOLD_RESERVATION_AUTHORITY`; "audit 2026-10-27 finding 9 …" (route separation); `tests/signer/paid.test.mjs` end to end |
| Removed the `totalSupply` comparison around the payment (the exact payer and recipient balance checks already refuse fee-on-transfer and burn-on-transfer tokens) | contract | "R4: fee-on-transfer token rejects …" |

The runtime is 23,446 bytes (Submission 3: 24,435), so the test-only `SupplyBoundaryHarness` fits the 24,576-byte limit
again, and a test checks the contract's own size.
