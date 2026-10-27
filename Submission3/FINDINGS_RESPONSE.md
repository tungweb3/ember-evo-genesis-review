# Submission 2 findings → Submission 3

Audit job: explorer.imd.fun 388b71cb (code at commit c790176). Test names are in `tests/contract/r5.test.mjs` unless
another file is given. "Fixed" means the code changed and the named test, written from the finding's reproduction,
passes on Submission 3. The Foundry proofs in the report were ported to the project's own Hardhat EDR harness; they were
not run as Foundry tests.

## The design change behind findings 1, 2 and 6

Submission 2 answered an expired seed block by using the supplied secret up and letting the **next** secret decide;
withholding that one too fell back to a seal by the secret alone. That fallback is what findings 1–3 attack: its outcome
is fixed when the chain is made, or by a chain made after the epoch closed.

Submission 3 removes the fallback. An expired seed block **keeps** the secret supplied for it: that secret is already
public, it stays in `revealCommit`, and the epoch is re-armed to `block.number + 1`. Once that block is mined, any call
(`settle([])` or any mint) seals the epoch with its hash and the same secret; no one, signer included, has to supply
anything. If that block expires as well (nobody called for 8,191 blocks), the next call re-arms again with the same
secret. Nothing is ever sealed with a zero block hash, and the next epoch keeps its own secret (no shift down the chain).

What the signer can still do by withholding is one fresh draw per epoch that it cannot predict when it publishes
(README 8.2). The price is that, after an expiry, the secret is public before the re-armed block is built, so that
block's builder could grind it (finding 6, documented; the keeper is now a stated security assumption).

| # | Sev. | Finding | Done | Change | Test |
|---|---|---|---|---|---|
| 1 | Medium | Secret-only seal after a second expiry is fixed at commit time: the signer can pre-select it | Fixed | No secret-only seal exists. An expiry keeps the (public) secret and re-arms; a second expiry re-arms again | "audit 388b71cb findings 1 and 2: …", "audit 388b71cb finding 1 (reproduction): … re-armed again with the same public secret …" |
| 2 | Medium | `setRevealCommit` skips the cooldown while an expiry re-arm is pending | Fixed | Once the next epoch has closed (its own seed block is reached), a new commitment waits `REARM_COOLDOWN` after its **current** seed block, a pending re-arm included. With no secret-only path, a chain made after the epoch closed can only seal it under a future block's hash | "audit 388b71cb finding 2 (reproduction): in the block of an expiry re-arm, a new commitment is refused …" (settle and `setRevealCommit` mined in the same block) |
| 3 | Low | Chosen-skin freeze lifted in the expiry re-arm block | Fixed | The freeze counts from the epoch's own seed block (`startBlock + (e + 1) × 25`), whatever the re-arm | "audit 388b71cb finding 3 (reproduction): an expiry re-arm does not lift the chosen-skin freeze, even for the chosen mint that triggers it" |
| 4 | Low | Owner + signer re-roll a closed epoch without bound; a replacement clears the expiry flag | Fixed | At most `MAX_COMMIT_REARMS` = 2 re-arms of the same epoch by a new commitment (`EPOCH_REARM_LIMIT`); the count lives in `revealState` and survives expiry re-arms. The expiry flag no longer bounds anything (no secret-only path) | "audit 388b71cb finding 4 (reproduction): new commitments re-arm the same epoch at most MAX_COMMIT_REARMS (2) times …" |
| 5 | Low | keccak²(anchor) accepted as a commitment | Fixed | The held-value walk covers 32 hashes above every anchor (current and replaced chains). README reworded: a safeguard against operator error, not a proof of freshness | "reveal commitment: …" (keccak¹, ², ³ and ³²(anchor) refused) |
| 6 | Low | After an expiry, a secret already out decides with a block not yet built | Documented | Inherent to keeping liveness without the signer (above). The signer still hands out no secret after one whose seed block is near expiry. README 7 and 8.2: the keeper is a security assumption, with an alert on a ready epoch older than a few hundred blocks | — |
| 7 | Info | README 8.2 overstated | Fixed | 8.2 rewritten with the bounds as they now are, including the later-epoch re-arm and liveness | — |

## Internal pre-deployment review (2026-10-27, after the fixes above)

| # | Sev. | Finding | Done | Change | Test |
|---|---|---|---|---|---|
| L-1 | Low | An epoch waiting behind a re-armed one is re-drawn by each of those re-arms, then starts a fresh count of 2 once the first is revealed (k-th epoch of a backlog: up to 2k replacements) | Fixed | `_commitRearms(e)` counts the last re-arm's replacements for every epoch it moved (`e` at or after the re-armed epoch and already closed then), so the bound is 2 per epoch across a backlog | "pre-deployment review 2026-10-27 (L-1): an epoch waiting behind a re-armed one shares its re-arm count …" |
| L-2 | Low | A `RevealCommitAcceptance` had no link to the commitment it replaces: a spare acceptance could be used later by the owner alone | Fixed | `RevealCommitAcceptance(commit, previous, signerEpoch, deadline)`, `previous` = the current `revealCommit` | "reveal commitment: …" (a spare acceptance is refused after another replacement) |

Storage was also repacked for gas (AUDIT_README section 5, *Storage layout*); `rearmBlock`, `rearmFromEpoch`,
`revealedSecrets` and `paidMinted` were removed for code size (`epochSeedBlock`, `chainSecrets` and
`totalMinted - freeMinted` give the same answers).

## Also changed

| Point | Change |
|---|---|
| Settling an expired epoch | Needs no secret: `epochSecretOpened(e)` tells clients; the signer (`readyReveals`) hands out nothing for it |
| `EpochSealed.blockHash` | Never zero |
| Gas | After the repack: about 10k less per mint, 30k less for the first random mint of a later epoch, 10–15k less for a full-epoch reveal; deploy +22k (Osaka) / +265k (Amsterdam), once (README section 10) |
