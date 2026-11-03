# Ember Evo Genesis: remediation of audit 161d71af, Submission 13 (2026-11-03)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package holds the build
intended for Ethereum mainnet and the tools that will deploy it, after audit `161d71af` of Submission 12 (1 Medium, 5 Low, 3 Info, all
in the tools). The owner asked for this review before the deployment. **This version is not deployed on any chain.**

Submissions 5 to 12 stay the reference for everything unchanged. The sequence of transactions is in Submission 11, section 4.

## 1. What changed from Submission 12

**The contract.** Nothing. [build/bytecode-comparison.Submission12-to-13.json](build/bytecode-comparison.Submission12-to-13.json)
compiles both public standard inputs with the same solc 0.8.38 payload: runtime (24,427 bytes), creation code (27,489 bytes) and ABI are
identical, metadata included. `build/EmberEvoGenesisCandidate.Submission12-to-13.diff` is empty on purpose. `MAINNET.reviewed` pins the
same values.

**The tools.** `tools/deploy-mainnet.ps1`, `tools/deploy-mainnet.mjs` and `tools/safe-batch.mjs`. All of it, with the tests, is in
[build/tools-and-tests.Submission12-to-13.diff](build/tools-and-tests.Submission12-to-13.diff). The signer did not change.

## 2. The audit's findings

| # | Finding | What was done | Where |
|---|---|---|---|
| 1 M | The default RPC refuses logs older than about 10,000 blocks, so `open` always hit `LOGS_UNAVAILABLE` and the flag skipped the check | The count is read with `eth_getStorageAt` at the pinned head, from the slot in the reviewed build's storage layout (11). No logs are read. `LOGS_UNAVAILABLE` and `--logs-checked-on-etherscan` are gone, so nothing can skip the check. A read that keeps failing stops the run | `EXTRA_TOKEN_COUNT_SLOT`, `chainState`, `checkRecord` |
| 2 L | A last recorded hash a reorg replaced blocked every resume with `RECEIPT_NOT_VISIBLE` | A step records all its hashes and a receipt for any of them is accepted. A node past the block that answers and has none of them takes the entry out of the record, and the gates and read-back decide from the chain. A node behind the block or not answering still stops the run, and the record is not rewritten | `record`, `recordedReceipt`, the `if(resume)` block |
| 3 L | A reverted transaction's nonce was not in the record | `failed[]` holds every reverted transaction. The floor is `planNonce + steps + failed`, and `totalGas` counts them. Each revert is checkpointed before a retry | `record`, `state`, `send` |
| 4 L | A waiting transaction landing during the gate reads gave `RESUME_OUT_OF_ORDER` | When a gate (or the code check for the deploy) says done for the waiting step, its receipt is awaited and recorded and the run moves past it. The error, which remains for the stale case, names the hashes | `seedLanded`, `notDone` |
| 5 L | Every send error raised the bid, with no ceiling | The bid to beat rises only after a placed transaction or an error that can mean a bid is held: `REPLACEMENT_UNDERPRICED`, `TIMEOUT`, "already known", "known transaction", "underpriced". A bid stops at the higher of 3x today's suggested tip and 2 gwei, across resumes too | `mayHoldBid`, `fees`, `send` |
| 6 L | A transient log failure ended `accept`/`open` on the first pass | No logs are read now, so the path is gone. `holds` has no special case left | `holds` |
| 7 I | A wrong-chain RPC reported `HEAD_BEHIND_RECORD` | `checkChain` runs in the CLI before the first head read | `checkChain` |
| 8 I | The RPC URL and key were read before the `try` | All the prompts are inside the `try`, so the `finally` clears them on every exit | `deploy-mainnet.ps1` |
| 9 I | `REPLACEMENT_GAS` was not tied to the step's limit | The limit of the last send is kept and stored as `pending.gasLimit`, and a replacement reuses it. `REPLACEMENT_GAS` remains only for a record without it | `knownLimit`, `waiting` |

## 3. Added beyond the report

These are new code the audit has not seen. An independent review of the first version of these fixes found the last three bugs below, and
they are fixed here. That review ran before these three fixes; they have not had a second independent review.

- **A bid above the ceiling is only waited for.** With no higher bid allowed, the run waits for the placed transaction and ends in
  `STEP_STUCK` with the reason, keeping the record.
- **A bid no node holds is not waited for.** When the ceiling is hit, `getTransaction` is read for every hash. If none is known and the bid to
  beat is a placed one, it is dropped and the next attempt bids at the market. Without this, an evicted transaction with a high recorded fee
  blocked a free nonce on every resume. A stale null here sends a market bid, which the node holding the real one refuses, and the bids
  climb again up to the ceiling.
- **`seedLanded` with no receipt reads the nonce.** A gate saying done with no receipt means the step landed under another hash, at a nonce
  only the chain knows. Assuming `seed.nonce + 1` left a nonce gap on every resume.
- **A dropped entry does not bound the nonce through the waiting transaction.** When the recorded step below a waiting transaction leaves the
  chain, the waiting transaction's nonce is not the floor: the freed nonce is filled first.

## 4. What to look at hardest

1. **`recordedReceipt` and dropping an entry.** Can an entry leave the record when the step is on the chain, in a way the gates cannot
   recover? Can a stale node reach the drop? What does a later resume lose? Only one entry is dropped per resume.
2. **`failed[]` and the floor.** Can the floor exceed the real nonce and leave a run on a nonce gap? See section 5 for the one case we accept.
3. **`seedLanded`.** A true gate is treated as final. Can it fire for the wrong step or after a reorg, and is its nonce right on both branches?
4. **The storage slot.** `EXTRA_TOKEN_COUNT_SLOT = 11` is a constant tied to the reviewed build. A test pins it against the real contract
   (1, then 2 after a second token, and 1 again at the earlier block). Is anything else needed?
5. **Fee logic.** Can `mayHoldBid` miss an error that means a bid is held, or match one that does not? Is the ceiling too low to get a
   transaction mined? Can a replacement under the ceiling fail to reach the 10% a node asks for and stop a valid run?
6. **The new stops and waits.** Can `TIP_CEILING` or `STEP_STUCK` block a valid run for good?
7. **`deploy-mainnet.ps1`.** Every prompt is now in the `try`. Is any exit path left?
8. **Anything in audit 161d71af not actually fixed.**

Report severity, reproduction and fix. Not in scope: artwork, the Mint web page, World 3D.

## 5. Known and accepted, or not yet done

- Submission 12, section 5 still applies, except its lines on `LOGS_UNAVAILABLE` and `--logs-checked-on-etherscan`, which are gone.
- A reorg deeper than the last recorded entry: only one entry is dropped per resume. An older recorded step that left the chain is not sent
  again, the read-back reports a mismatch, and a person must check. A nonce floor above the chain from such a reorg ends in `STEP_STUCK`.
- A live transaction at the ceiling whose `maxFeePerGas` falls below the base fee cannot be replaced, because a replacement must raise the
  tip as well. The run ends in `STEP_STUCK`. It clears when the base fee falls or the market tip rises.
- A stale gate can still say "not done" about a step that landed under a lost hash and is not in the record. The next send then fails on the
  estimate, reverts or gets `NONCE_MOVED`. It cannot deploy a second contract or skip a step.
- `holds` lowers the chance of a stale pass in `safe-batch` but cannot prove freshness: a change newer than the agreed head is not seen. The
  contract's own guards and the all-or-nothing batch remain the last check.
- Finding 8: the key is still in the PowerShell process memory until the script ends.
- Not built yet, all planned before opening: the metadata and image host, the mainnet signer Worker, the keeper, the final free list and the
  production GOLD book entry (`genesis-deployments.ts` is still empty).

## 6. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **146 tests: 143 pass, 0 fail, 3 skipped**.
The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy (35 tests), unchanged.

New in `tests/contract/deploy-mainnet-cli.test.mjs`, over real JSON-RPC with a real `Wallet` (names start with `audit 161d71af`): a replaced
hash, a dropped entry, a node behind the block, a reverted deploy, a reverted attempt with a retry, a transaction landing during the gates,
502s with no bid raise, the refused climb to the ceiling, a live bid above it, an evicted bid above it, known and unknown `gasLimit`, a
wrong-chain RPC, a gate with no receipt, a dropped step below a waiting transaction, and a timeout before anything is sent.

Run against the Submission 12 tools, 12 of these 14 fail. The 2 that pass on both are "a node that is behind the recorded block" and "a timeout
before anything is sent", which guard against regressions. The reorg tests script the receipts and nonce over a real chain; only the
independent review also ran a real `evm_revert` reorg, in its own harness, which is not in this package.

**On a real RPC.** Measured on 2026-11-03 against `https://ethereum-rpc.publicnode.com`: `eth_getLogs` older than about 10,000 blocks is refused
with "Archive requests require a personal token", and `eth_getStorageAt` at the head works. `safe-batch.mjs status` was run against the real Sepolia
rehearsal contract `0x630CF8c1D20697d28D2a54d4e4a4612B7bEA5b30` through `https://ethereum-sepolia-rpc.publicnode.com`, 34,343 blocks after its
deploy, twice: it finished in about 6 seconds and read `extraTokens: 1`. That contract has the same storage layout and one added token.
Slot 11 was also read directly there, with the same result.

`deploy-mainnet.ps1` has no test in this package. It was run again locally on a temp copy, in a temp home folder, with real node and canned
answers: success with the real tools against the local chain (6 transactions), then a refused second run; with stand-in tools exiting 1 or 2:
resume, cancel, pre-check failure, stop, read-back mismatch, Safe file failure; a key for another address, a bad address, a bad key and a bad
signer file. All stopped as written. New: a stop at the key prompt, on this script and the previous one. On the previous one the URL stayed set
and on this one the `finally` cleared it. The stand-ins logged that the pre-check process had no `DEPLOYER_PRIVATE_KEY`, and no secret reached
the console.

## 7. Not verified

- `deploy-mainnet.mjs` was never run against mainnet or a real load-balanced RPC. The lag is our model of one.
- `safe-batch.mjs accept` and `open` were not run on a real RPC. `status` shares their read path. `open` needs the metadata host.
- The real Safe Transaction Builder import, which audit 90ae2f92 asks for on Sepolia before mainnet.
- The local chain runs Cancun, not the current mainnet rules. The `~40M if EIP-8037 is live` allowance in `preflight` is not exercised.
- The tip ceiling was not tried against real mainnet fee conditions.
- `genesis.imdember.com` does not serve metadata yet. `open` refuses until it does; the tests use a stand-in host.

## 8. Files

The layout is the same as Submission 12: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json` reproduces the
build; `build/build-receipt.json` records it. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except
itself.
