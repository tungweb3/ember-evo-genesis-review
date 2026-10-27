# Submission 4 findings → Submission 5

Audit job: explorer.imd.fun b0b1d96a (code at commit b14f07d; 2 low, 1 info). The report itself is attached unchanged
as [AUDIT_REPORT_b0b1d96a.md](AUDIT_REPORT_b0b1d96a.md) (from https://api.imd.fun/jobs/b0b1d96a-bd57-44c7-a43c-8b7d123b9bb2/report.md,
SHA-256 `d8f3f61f9ff31b48bb908b7226085e09f5be653861bf22379e571b2429d183d7`). "Fixed" means the code changed and the
named test, written from the finding's reproduction, passes on Submission 5. The Foundry proof for finding 1 was ported
to the project's own Hardhat EDR harness; it was not run as a Foundry test.

| # | Sev. | Finding | Done | Change | Test |
|---|---|---|---|---|---|
| 1 | Low | The one-hour `RevealCommitAcceptance` window bounds only `deadline - now` at use, not the acceptance's age: one signed with a far deadline becomes usable by the owner alone in its last hour | Fixed | The acceptance no longer carries a deadline. It signs a recent block: `RevealCommitAcceptance(commit, previous, signerEpoch, blockNumber, blockHash)`, and `setRevealCommit(commit, blockNumber, acceptance)` supplies `blockHash = blockhash(blockNumber)`, refusing a zero hash (`REVEAL_ACCEPTANCE_EXPIRED`). A block hash cannot be known before the block exists, and `blockhash()` forgets it after 256 blocks (EIP-2935 deliberately not used here), so the acceptance's age is bounded by the chain, not by the signer's choice. `signRevealCommit` takes `block` ({number, hash}); the deploy tool signs the block two below the head | "reveal commitment: …": a future block and a wrong hash are refused; a spare acceptance is accepted 254 blocks after its block and refused 257 blocks after it |
| 2 | Low | An expiry re-arm still re-draws, or offers a keep-or-redraw choice on, every later closed epoch whose seed block expires during the same withhold | Documented (owner decision) | Signer trust, as the report says. README 5 (*Expiry*), 7 (keeper) and 8.2 (*Signer alone: withholding*, *Builder of a re-armed block*) and the `_rearm` comment now state what one withhold buys: a forced re-draw of every later epoch that shares the last commitment re-arm block, and a keep-or-redraw choice (about 25 blocks each) on every epoch that closed during the withhold; never a chosen draw. The keeper's "ready epoch with no published secret" alert covers the whole backlog. The VRF option in 8.2 remains the alternative | — |
| 3 | Info | The GOLD book's stored-hold check accepts domain version 5 or 7 and any non-zero recipient for every deployment | Fixed | `MintBinding` / `encodeMintAuth` carry the registry's `domainVersion` (default `5`) and `recipient` (default the burn address), set by `reserveGenesisGold`; the `genesis-r5-paid-v1` document must match both exactly, and a binding without them is refused | `tests/gold-book/genesis-gold.test.mjs` "Genesis audit b0b1d96a finding 3: …" (the report's case: a v7 document for a v5 deployment, and another recipient, are refused) |

## Other effects

- Only `setRevealCommit`, one type hash and comments changed in the contract. Runtime size 23,451 bytes (Submission 4:
  23,446). The `ACCEPTANCE_WINDOW` constant is gone.
- Gas: mint rows unchanged within draw variation; `setRevealCommit` 64,542 on Osaka (Submission 4: 64,557). README
  section 10.
- No change to the EIP-712 domain (still version `7`), any event, or any mint function. The `RevealCommitAcceptance`
  type is the only signed type that changed.
- Mainnet note (README 7): with a multisig owner, the commitment transaction must be executed within 256 blocks of the
  block the acceptance names.
- Live on Sepolia since 2026-10-28: the signer Worker, the test GOLD book (registry entry `sepolia-r6-rehearsal-9`) and
  the friends' test site point at `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`.
