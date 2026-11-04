# Ember Evo Genesis: remediation of audit 56694dc1, Submission 15 (2026-11-04)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package holds the build
intended for Ethereum mainnet and the tools that will deploy it, after audit `56694dc1` of Submission 14 (5 Low, 1 Info, all in the
deployment tool). The owner chose to fix all of it and publish this without asking for another review. **This version is not deployed
on any chain, and Swarm has not reviewed the changes in it.**

Submissions 5 to 14 stay the reference for everything unchanged. The sequence of transactions is in Submission 11, section 4.

## 1. What changed from Submission 14

**The contract.** Nothing. [build/bytecode-comparison.Submission14-to-15.json](build/bytecode-comparison.Submission14-to-15.json)
compiles both public standard inputs with the same solc 0.8.38 payload: runtime (24,427 bytes), creation code (27,489 bytes) and ABI are
identical, metadata included. `build/EmberEvoGenesisCandidate.Submission14-to-15.diff` is empty on purpose. `MAINNET.reviewed` did not change.

**The tools.** Only `tools/deploy-mainnet.mjs`. All of it, with the tests, is in
[build/tools-and-tests.Submission14-to-15.diff](build/tools-and-tests.Submission14-to-15.diff). `tools/safe-batch.mjs`,
`tools/deploy-mainnet.ps1` and the signer did not change.

**One format change.** Every entry of `steps` and `failed` now has a `nonce`. No mainnet record exists yet. A record written by an earlier
version has no such field, and its `failed` entries do not count as the step's last try (section 2, finding 4).

## 2. The audit's findings

| # | Finding | What was done | Where |
|---|---|---|---|
| 1 L | "nonce too low" or "insufficient funds" about a delivered transaction removed the landed hash | A refusal now looks the hash up before removing it. Shown (a transaction or a receipt): it counts as placed, and is waited for. Absent over `visibleReads` passes: it leaves. An RPC error in the lookup: it stays and is watched, without counting as placed | `send`, `lookup` |
| 2 L | One hash no node holds kept `NONCE_MOVED` from firing | The stop now asks whether any of the step's hashes is shown, instead of whether the list is empty. It does not fire for a hash shown a moment before | `send`, `noneHeld` |
| 3 L | One null answer per hash let a stale step over a live transaction | `meetSeed` uses the same `visibleReads` lookup, and an RPC error is not "absent". The `TIP_CEILING` branch moved to it too | `meetSeed`, `noneHeld` |
| 4 L | Any `failed` entry with the step's name counted as its last try | A record entry stores its nonce. The exception now needs a `failed` entry of this step at the nonce just below the current one | `record`, `meetSeed` |
| 5 L | A count jumping past a queued transaction dropped it unread | `readPassed` reads the receipt of each waiting transaction the count has passed before it leaves. It runs at the end of the resume block and in `seedLanded`. An entry already waited for in the resume block is not waited for twice | `readPassed`, `seedLanded`, the `if(resume)` block |
| 6 I | Bare result names were not understood | `fee\s*too\s*low`, `replacement\s*not\s*allowed`, `already\s*known` and similar now match with or without spaces, and `nonceSpent` and `noFunds` read `OldNonce`, `NonceTooLow` and `InsufficientFunds`, which ethers does not map. Nethermind's `AcceptTxResult.cs` at master was read on 2026-11-04: it now answers in geth-style messages, so the bare names are for older versions, as the report says | `bidTooLow`, `mayHoldBid`, `nonceSpent`, `noFunds` |

## 3. Added beyond the report

This is new code the audit has not seen. One independent review ran on the fixes above and found the two items marked below, both reproduced on a local
chain. Those two fixes, and the smaller changes under them, have had the tests in section 6 but no second review.

- **`lookup` has three answers: shown, absent, unknown.** *(from the review)* An early version treated an RPC error as "held". One rate-limited read then made a
  refused bid count as placed, which opened the estimate fallback, and in a scripted run a reverting transaction went out and burned 29,041 gas.
- **The `NONCE_MOVED` check does not run after a hash was just shown.** *(from the review)* Otherwise a delivered transaction shown by one node and not by the next
  three was given up, which is finding 1 again on a lagging RPC.
- **`lookup` also reads the receipt.** A landed transaction whose `eth_getTransactionByHash` comes back null from every node asked is still shown.
- **`\bold\s*nonce`.** The word boundary keeps text like "threshold nonce exceeded" from counting as a refusal. On a sample of 900 messages ethers builds around random
  raw transactions, the review found no pattern matching the hex.
- `topLeft` was removed: nothing has read it since the last change.

## 4. What would be worth a look

There is no open review request. If someone does read this, these carry the most weight:

1. **`lookup` in the catch block of `send`.** Can a refused and absent hash still land? Can a shown one be left waiting wrongly?
2. **`readPassed`.** Can it wait on the wrong entry, or lose one?
3. **`f.nonce===nonce-1` in `meetSeed`.** Can it stop a retry that should go out?

## 5. Known and accepted, or not yet done

- Submission 14, section 5 still applies.
- **"Absent" is three answers, not a proof.** A transaction held by one node of many, or a landed one every node asked lags on, can still read as absent. A stale step can
  then still go out over a live transaction, or a landed hash can leave the record. The chance is smaller than with one read, not gone. Fails safe: the contract refuses a repeat, and
  the step appears in `notInRecord`.
- **A phantom hash of another step survives `NONCE_MOVED` in `queued`.** The next resume waits `stepTimeoutMs` on it once, about 5 minutes, and then lets it go.
- **A step's own hash with no node holding it** can still cost that wait on a resume, when a run ends in `STEP_STUCK` and not `NONCE_MOVED`.
- **A `failed` entry with no `nonce`,** from a record of an earlier version, ends in `RESUME_OUT_OF_ORDER` until the waiting transaction lands. No mainnet record exists.
- **A refused bid costs up to two more polls** for the lookup. The commit acceptance is signed again on each attempt, so this does not age it.

## 6. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **186 tests: 183 pass, 0 fail, 3 skipped**.
The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy (35 tests), unchanged.

New, with names starting `audit 56694dc1` (23), all in `tests/contract/deploy-mainnet-cli.test.mjs` over real JSON-RPC with a real `Wallet`. The first 13 were run against the
Submission 14 tool: 12 fail, and the one that passes, "a refused hash no node shows still leaves the record", guards against over-fixing. Of the 9 from the review, run against the
version before the review: 4 fail, and the other 5 guard behaviour that version already had but no test held. The one for a bare `NonceTooLow` was added last and was run only on this version.
"A spent nonce with no receipt is waited for once" measures time, with a window of 900 to 1,800 ms.

The review's harnesses are not in this package. It reran each of the first 13 tests with its fix reverted, but not the changes that came after it.

`deploy-mainnet.ps1` did not change and has no test in this package. Its scenarios from Submission 13, section 6 were run again on this version: all stopped as written, no secret reached the console. No mainnet key file appeared in the real home
folder. The dry run gives 6 transactions and no mismatch.

## 7. Not verified

- `deploy-mainnet.mjs` was never run against mainnet or a real load-balanced RPC. Stale reads and reorgs are scripted, or a local `evm_revert`.
- No real client's mempool, and no real gateway that retries. Refusal words are matched from sources and reports, not from a live refusal; Besu's are from memory. Besu's
  effective-price replacement rule may refuse a bid that passes the 10% rule.
- `safe-batch.mjs accept` and `open` were not run on a real RPC. `status` shares their read path. `open` needs the metadata host.
- The real Safe Transaction Builder import, which audit 90ae2f92 asks for on Sepolia before mainnet.
- The local chain runs Cancun, not the current mainnet rules. The `~40M if EIP-8037 is live` allowance in `preflight` is not exercised.
- The tip ceiling was not tried against real mainnet fee conditions.
- `genesis.imdember.com` does not serve metadata yet. `open` refuses until it does; the tests use a stand-in host.

## 8. Files

The layout is the same as Submission 14: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json` reproduces the
build; `build/build-receipt.json` records it. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except
itself.
