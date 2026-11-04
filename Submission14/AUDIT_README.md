# Ember Evo Genesis: remediation of audit 8b5de2de, Submission 14 (2026-11-04)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package holds the build
intended for Ethereum mainnet and the tools that will deploy it, after audit `8b5de2de` of Submission 13 (6 Low, 2 Info, all in the
tools). The owner asked for this review before the deployment. **This version is not deployed on any chain.**

Submissions 5 to 13 stay the reference for everything unchanged. The sequence of transactions is in Submission 11, section 4.

## 1. What changed from Submission 13

**The contract.** Nothing. [build/bytecode-comparison.Submission13-to-14.json](build/bytecode-comparison.Submission13-to-14.json)
compiles both public standard inputs with the same solc 0.8.38 payload: runtime (24,427 bytes), creation code (27,489 bytes) and ABI are
identical, metadata included. `build/EmberEvoGenesisCandidate.Submission13-to-14.diff` is empty on purpose. `MAINNET.reviewed` pins the
same values, and now also the storage slot of finding 8.

**The tools.** `tools/deploy-mainnet.mjs` and `tools/safe-batch.mjs`. All of it, with the tests, is in
[build/tools-and-tests.Submission13-to-14.diff](build/tools-and-tests.Submission13-to-14.diff). `tools/deploy-mainnet.ps1` and the signer
did not change.

**One format change.** The tool now signs, records the hash, then broadcasts. It no longer calls `sendTransaction`, so it needs a signer
that can sign locally. The mainnet CLI always used a `Wallet`; the dry run and the unit tests moved to one.

## 2. The audit's findings

| # | Finding | What was done | Where |
|---|---|---|---|
| 1 L | The drop rested on two requests that can reach two nodes | A step records its `blockHash`. An entry leaves only when one `eth_getBlockByNumber(n, true)` answer shows a block at that height with another hash and none of the step's hashes, over `visibleReads` passes. A null block, the recorded hash, or a block listing the transaction all count as not proved, and end in `RECEIPT_NOT_VISIBLE`. The head is no longer read here | `recordedReceipt`, `record` |
| 2 L | A reply lost after the node took the transaction lost the hash | The transaction is signed first, its hash goes in the record and is checkpointed, then `broadcastTransaction`. An answer that is a refusal (`NONCE_EXPIRED`, `INSUFFICIENT_FUNDS`, a bid too low) removes a hash this attempt added; anything else keeps it, and it is watched. A resend of the same bytes keeps the hash (`fresh`) | `send`, `refusedSend` |
| 3 L | `mayHoldBid` knew only geth's words | `bidTooLow` and `mayHoldBid` now cover "insufficient gas price to replace", "below ... minimum", "fee too low", "could not replace", "already imported" and "same hash". The reth and Erigon strings were read from their sources at main on 2026-11-04; for Nethermind only the result names were read; Besu's are from memory | `bidTooLow`, `mayHoldBid` |
| 4 L | A refill's checkpoints erased the later waiting transaction | The record gains `queued`: every waiting transaction of another step, kept until its nonce is spent. A resume looks at the receipts of `pending` and all of `queued`, and a queued one becomes the bid to beat when its nonce is reached | `state`, `later`, `nextSeed`, `trimSeed`, the `if(resume)` block |
| 5 L | The ceiling fired on a 25% raise when 10% still fitted | When 25% passes the ceiling and 10% does not, the bid is the ceiling itself, with a fee cap 10% over the last and never under the tip. `TIP_CEILING` fires only when even 10% passes | `fees` |
| 6 L | `seedLanded` with no receipt dropped its bounds | The current nonce and `plan + steps + failed` stay. The count is read until it passes the waiting nonce, keeping the highest read. If it never does within `visibleTries`, that nonce is free (a resend above the landed step that no node holds) and the run goes on | `seedLanded` |
| 7 I | A step the record lost skipped the `usableAt` check | With no add block, `usableAt` must fall between the deploy block's time and the current head's time, plus the delay. The deployment record gains `notInRecord`, the steps the chain shows but the record has no hash for, whose gas is not in `totalGas`. The CLI prints it | the read-back |
| 8 I | The slot was read without pinning the code | `chainState` reads the code at the agreed head. Its keccak must equal the record's `codeHash`, and on mainnet `runtimeMatches` must hold against the reviewed build, or `CODE_NOT_RECORDED_BUILD`. `verifyBuild` runs first, so a local recompile is named as that. The slot moved to `MAINNET.reviewed.extraTokenCountSlot`, beside the hashes | `chainState`, `MAINNET.reviewed` |

## 3. Added beyond the report

These are new code the audit has not seen. Two independent reviews ran on this change. The first covered the fixes above and found the first
four items below; the second covered those four and found the fifth. The fifth is one line. It has had the second reviewer's scripted reorg
reproduction, 35 existing tests and a 76-scenario lagging sweep with it applied, and the full suite here, but no third review.

- **Only a placed bid opens the estimate fallback.** `hashes.length` can now mean signed and never held, so the fallback is keyed on `placed`.
  Without this, a stale gate, a lost send and a true revert sent a transaction that reverted.
- **A waiting transaction above the nonce is queued, not pending.** The first checkpoint writes `pending` only at the current nonce. A stop right
  after a drop used to make every later resume start from the waiting nonce.
- **`meetSeed`: a waiting transaction of another step at this nonce.** Three outcomes: no node holds it, the step goes out at market; held and this
  step has a `failed` entry, the step bids over its fee (at most one lands); held otherwise, `RESUME_OUT_OF_ORDER`, as before, for a stale read. It
  also runs on the retry after a revert, which skipped this check.
- **The queue filter is by name and nonce.** A later transaction at the nonce being sent stays in `queued`. The old form dropped it from the record.
- **Only a landed transaction bounds the nonce.** `floor` starts at 0 and only a receipt raises it. A pending transaction above the real count, in a
  record that lost the step below it, held every resume at that nonce for good. A stale low read now sends at a spent nonce, which a node refuses.

Smaller: `STEP_STUCK` carries the error code and the node's words; a taken bid clears the last error; the upper bound of `usableAt` is read
inside the read-back pass.

## 4. What to look at hardest

1. **Signing first (`send`).** Can a hash in the record that no node ever held change a decision wrongly? Can a refusal remove a held hash?
   A gateway that retries internally could answer "nonce too low" about a transaction it just delivered. Does anything recover from that?
2. **`refusedSend` and the words list.** Can an error count as a refusal when the node took the transaction? Can a refusal in a client's words be missed?
3. **`queued` and `meetSeed`.** Can a live transaction leave the record, can a resume repeat forever without progress, can a step land twice? See section 5
   for the case we accept.
4. **`floor` at 0.** What now stops a run at a spent nonce on a stale read, and does anything cost gas? Is `plan + steps + failed` still right for every
   record the tool can write?
5. **`recordedReceipt`.** Can a real reorg now stick a run? Can a mined entry still be dropped (section 5 has the case we know)?
6. **Fees at the ceiling.** Is the last bid always acceptable to a node? Can the ceiling branch repeat a bid?
7. **`chainState`'s code check.** Can it stop a valid `accept` or `open`, on a lagging node or otherwise?
8. **Anything in audit 8b5de2de not actually fixed.**

Report severity, reproduction and fix. Not in scope: artwork, the Mint web page, World 3D.

## 5. Known and accepted, or not yet done

- Submission 13, section 5 still applies, except its line on a stale gate after a lost hash, which section 2 narrows.
- **A mined entry can still leave the record** after a true reorg that moved its transaction to a later block, while the receipt backend lags. For `steps` the
  gate recovers it and it appears in `notInRecord`. A `failed` entry loses its gas and its place in the count. Fails safe.
- **A step can land twice after a reorg.** A reverts at n, its retry waits at n+1, and a reorg removes the failed entry: A goes out at n below its own retry. In a
  scripted run both landed: the contract refused the repeat, the read-back was clean, and it cost one extra transaction.
- **A live hash can leave the record** in two reorg cases: a dropped top entry's hash that returns to the pool and lands, and a resend `seedLanded` lets go of
  because the count stayed at its nonce. The run still ends correct, with the step in `notInRecord` or a stop at `NONCE_MOVED`.
- `safe-batch.mjs` now imports `deploy-mainnet.mjs`, so it needs the local build file at import. A missing file gives a raw stack trace.
- `usableAt` with no add block is checked against a window, not one block. A head that stays behind the add block through all 10 read-back passes reports a
  mismatch on a valid run. The partial record stays and a resume reads again.
- A process death between the two checkpoints leaves a hash in the record with `fee` null. If the transaction did go out, a market bid is refused and climbs.
- Not built yet, all planned before opening: the metadata and image host, the mainnet signer Worker, the keeper, the final free list and the
  production GOLD book entry (`genesis-deployments.ts` is still empty).

## 6. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **163 tests: 160 pass, 0 fail, 3 skipped**.
The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy (35 tests), unchanged.

New, with names starting `audit 8b5de2de` (18): 17 in `tests/contract/deploy-mainnet-cli.test.mjs` over real JSON-RPC with a real `Wallet`, 1 in
`tests/contract/deploy-mainnet.test.mjs`. Run against the Submission 13 tools, 17 of the 18 fail. The one that passes on both, "a send a node refuses leaves
no hash behind", guards against a regression. Some of those fail on the old tools because the feature did not exist, not because each reproduces a bug.

Changed: one test was deleted ("a node that is behind the recorded block"), because the head is no longer read there and finding 1's test covers it. The test
wrappers moved from `sendTransaction` to `signTransaction` and `broadcastTransaction`. The local test RPC now avoids the ports `fetch` refuses, a flake seen once
in the full run.

The two reviewers' harnesses are not in this package. The second ran these sweeps on the code before the fifth item of section 3, all with a clean read-back: one
stop at each of the 19 checkpoints with 7 pool outcomes (133 scenarios), two stops with 3 pool outcomes (513), one stop with a lagging node on 12% of reads (76), and
a real `evm_revert` reorg of each of the first 5 steps with stops (660). With the fifth item it reran the reorg reproduction, 35 tests and the lagging sweep only.

**On a real RPC.** Measured on 2026-11-04 against the public nodes `ethereum-rpc.publicnode.com` and `ethereum-sepolia-rpc.publicnode.com`, read only:
`eth_getBlockByNumber(n, true)` gives a hash and transaction objects with `hash`, and a block not there yet answers null, as `recordedReceipt` assumes.
`safe-batch.mjs status` was run against the real Sepolia rehearsal contract `0x630CF8c1D20697d28D2a54d4e4a4612B7bEA5b30` twice: about 9 seconds each, `extraTokens: 1`.
With a wrong `codeHash` in the record it stopped with `CODE_NOT_RECORDED_BUILD`. That record had its `codeHash` added by hand from the chain.

`deploy-mainnet.ps1` did not change and has no test in this package. Its full set of scenarios from Submission 13, section 6 was run again on this change before the fifth
item of section 3, and the success, second-run and key-prompt scenarios again after it. All stopped as written, no secret reached the console, and no mainnet key file
appeared in the real home folder. The dry run gives 6 transactions and no mismatch.

## 7. Not verified

- `deploy-mainnet.mjs` was never run against mainnet or a real load-balanced RPC. Stale reads and reorgs are scripted, or a local `evm_revert`.
- No real client's mempool. Refusal words are matched from sources and reports, not from a live refusal; Besu's are from memory, and Nethermind's constants were not read. Besu's
  effective-price replacement rule may refuse a bid that passes the 10% rule.
- `safe-batch.mjs accept` and `open` were not run on a real RPC. `status` shares their read path. `open` needs the metadata host.
- The real Safe Transaction Builder import, which audit 90ae2f92 asks for on Sepolia before mainnet.
- The local chain runs Cancun, not the current mainnet rules. The `~40M if EIP-8037 is live` allowance in `preflight` is not exercised.
- The tip ceiling was not tried against real mainnet fee conditions.
- `genesis.imdember.com` does not serve metadata yet. `open` refuses until it does; the tests use a stand-in host.

## 8. Files

The layout is the same as Submission 13: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json` reproduces the
build; `build/build-receipt.json` records it. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except
itself.
