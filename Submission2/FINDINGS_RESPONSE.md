# Submission 1 findings → Submission 2

Audit job: explorer.imd.fun 31bb373a (code at commit b05b1a9). Test names are in `tests/contract/r5.test.mjs` unless
another file is given. "Fixed" means the code changed and the named test, written from the finding's reproduction,
passes on Submission 2. The tests were not run against the Submission 1 code; the reproductions in the report do that.

| # | Sev. | Finding | Done | Change | Test |
|---|---|---|---|---|---|
| 1 | Medium | Owner alone can re-roll a ready epoch through repeated `setRevealCommit` re-arms | Fixed | A commitment needs the current signer's EIP-712 `RevealCommitAcceptance`. If the next epoch is ready, a replacement re-arms it only `REARM_COOLDOWN` (7,200) blocks after its seed block, and a re-armed epoch likewise only 7,200 blocks after its re-armed block. README 8.2 rewritten | "reveal commitment: … signer's acceptance …", "audit 2026-10-27 finding 1 (reproduction) …" |
| 2 | Medium | GOLD book never settles mints sent through a smart wallet or a bundle | Fixed | `genesis-gold-reader.ts`: no `receipt.to` check; picks this order's `GenesisMinted` (wallet and token id) among any others in the receipt | `tests/gold-book/genesis-gold.test.mjs` "Genesis audit 2026-10-27 finding 2 …" |
| 3 | Low | Nine or more ready epochs make every chosen mint revert | Fixed | No fixed per-call limit; a call settles every ready epoch it has secrets for. The signer hands out up to 32 | "findings 3 and 14 (reproduction): with nine ready epochs …" |
| 4 | Low | Secret released at 0 confirmations; chosen mints allowed inside the seed block | Fixed | Signer waits `seedBlock + 2`. The contract freezes chosen mints from the seed block itself (`block.number < seedBlock`) | "finding 4: chosen-skin mints are frozen from the seed block itself", `tests/signer/signer.test.mjs` "… 2 blocks deep …" |
| 5 | Low | Expired seed block degrades to secret-only | Fixed | Expiry re-arms (secret used up, next secret decides), once per epoch; a second expiry seals with the secret alone. The holder has a bounded set of options (README 8.2). The signer never releases a secret after one that is about to expire | "finding 5: an expired seed block is never sealed with the secret alone …", "… re-armed only once …" |
| 6 | Low | `setRevealCommit` accepts an opened commitment | Fixed | Refuses any value held on the current or a replaced chain, and keccak(anchor) | "reveal commitment: …" (anchor, x1, x2, keccak(anchor), values of a replaced chain) |
| 7 | Low | Re-arm loop is unbounded | Fixed | O(1) re-arm (`rearmState`: block, first epoch, flag) | "finding 7: replacing the commitment re-arms any number of pending epochs at a fixed cost" |
| 8 | Info | Transient marker keyed on `msg.sender` | Documented | README 8.7: a composition rule, not a rate limit; the GOLD reader no longer assumes one mint per receipt | — |
| 9 | Info | `Appearance` has no route | Fixed | `Appearance` has `bool paid` (EIP-712 version 7) | "finding 9: an Appearance approval names its route …" |
| 10 | Info | GOLD book stores domain version 5 | Fixed | Registry entry carries `domainVersion` ("7" for this deployment) | registry: `offchain/gold-book/server/genesis-deployments-sepolia.ts` |
| 11 | Info | Reveal chain 2,048 < `SUPPLY_CEILING` 2,222 | Fixed | Chain length 4,608 (≥ 2 × ceiling: expiries also consume secrets) | `offchain/signer/reveal-chain.mjs` |
| 12 | Info | Gas of settling 8 × 25 | Improved | Seed and cursor no longer stored. Ids are packed 16 bits per token; skin counts and caps share one slot. One `BatchMetadataUpdate` per epoch. Full-epoch reveal: 0.67M → 0.29M (Osaka), 1.50M → 0.54M (Amsterdam) | README section 10 |
| 13 | Info | Odds are path-dependent | Documented | README 8.9 (the mint page will explain it) | — |
| 14 | Info | `reveals[]` matching is order-sensitive | Fixed | The whole list is searched for each epoch | "findings 3 and 14 …" passes the nine secrets in reverse order |

## Also changed after our own second review

| Point | Change |
|---|---|
| Signer re-roll by withholding (the Submission 1 fix of finding 5 had made it unlimited) | One expiry re-arm per epoch, then the secret alone |
| Owner rotates the signer to its own key and vetoes a published outcome | Any re-arm of a ready epoch waits `REARM_COOLDOWN` after its seed block; anyone can settle meanwhile (`settle` works while paused) |
| keccak(anchor) has a public preimage | Refused |
| Code comments overstated the trust model | Rewritten; README 8.2 lists what the signer and the owner can still do |
| Gas (owner request) | Packed `skinState`; 4-bit token words; packed epoch ids; transient reentrancy guard; no per-mint `supplyLocked` write; `paidMinted`, `pendingRandom`, `revealedSecrets` and `tokenLook` are views. Removed: `sealEpoch`, `revealEpoch` (`settle` does both), `MAX_SUPPLY()`, `appearanceKey`, `tokenDisplayName`, `remainingFreeReservation`, `paymentRecipient` (code size) |
