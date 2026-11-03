# Ember Evo Genesis: remediation of audit 358f7f40, Submission 12 (2026-11-03)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package holds the build
intended for Ethereum mainnet and the tools that will deploy it, after audit `358f7f40` of Submission 11 (1 Medium, 3 Low, 4 Info, all
in the tools and the signer). The owner asked for this review before the deployment. **This version is not deployed on any chain.**

Submissions 5 to 11 stay the reference for everything unchanged. The sequence of transactions is in Submission 11, section 4.

## 1. What changed from Submission 11

**The contract.** Nothing. [build/bytecode-comparison.Submission11-to-12.json](build/bytecode-comparison.Submission11-to-12.json)
compiles both public standard inputs with the same solc 0.8.38 payload: runtime (24,427 bytes), creation code (27,489 bytes) and ABI are
identical, metadata included. `build/EmberEvoGenesisCandidate.Submission11-to-12.diff` is empty on purpose. `MAINNET.reviewed` pins the
same values.

**The tools and the signer.** `tools/deploy-mainnet.ps1`, `tools/deploy-mainnet.mjs`, `tools/safe-batch.mjs` and
`offchain/signer/paid-approval.mjs`. All of it, with the tests, is in
[build/tools-and-tests.Submission11-to-12.diff](build/tools-and-tests.Submission11-to-12.diff). The GOLD-book copy and `tools/tool-errors.mjs`
are unchanged.

## 2. The audit's findings

| # | Finding | What was done | Where |
|---|---|---|---|
| 1 M | A resume read the nonce before the record's last block was visible, a stale nonce erased the waiting transaction from the record, and refused sends kept the same fee | The resume waits for the last recorded step, then for the waiting transaction, and only then reads the nonce, bounded from below by `planNonce + steps.length` and by `pending.nonce`. Every attempt bids above the one before, refused or not. A spent nonce no hash explains stops the run. The record keeps only fees a node accepted | the `if(resume)` block after `settled`; `last` and `placed` in `send`; `NONCE_MOVED` |
| 2 L | A resume did not wait for the pending transaction; each gate was one read, retried only on error; the test lagger never gave a stale but valid answer | The receipt of the waiting transaction is read first, and if it landed the step goes into `steps[]`. A step in `steps[]` is not sent again. Other gates need every one of `visibleReads` reads to say "not done" on a resume. The lagger now answers `eth_call` and `eth_estimateGas` from the state one block back | `notDone`, `RESUME_OUT_OF_ORDER`, `lagger` in the CLI test |
| 3 L | `chainState` used unpinned reads and `holds()` returned on the first pass | One pass reads one block: the head two reads agree on, at or above the record's last block and never going back. `holds` needs the same result over 3 consecutive reads and still retries refusals | `stableHead`, `chainState(provider,d,head)`, `holds`, `recordBlock` |
| 4 L | The ISO path of `unix` had no upper bound | `unix` caps ISO dates at 10-digit seconds, and `openBatch` refuses a start above uint40 | `unix`, `openBatch` |
| 5 I | A refused log range passed `checkRecord` | `LOGS_UNAVAILABLE` refuses `accept` and `open` unless the owner passes `--logs-checked-on-etherscan`. The range is read from the start block to the pinned head, in chunks of 10,000 blocks | `checkRecord`, `tokenLogs` |
| 6 I | `tokenURIsLocked` and `supplyLocked` were not read | Read in `chainState`; `checkRecord` refuses when either is true | `READ`, `checkRecord` |
| 7 I | The pre-check received the deployer key | With `PREFLIGHT_ONLY=1` the tool takes `DEPLOYER_ADDRESS` and `SIGNER_ADDRESS` and no key. The script sets the key only around the key check and the deploy call, and the signer key file and commitment only around the deploy call | CLI block of `deploy-mainnet.mjs`, `deploy-mainnet.ps1` |
| 8 I | The paid signer read `snapshotRoot` in a second round trip | Read inside the same `Promise.all`, as the free route does | `paid-approval.mjs` `prepare` |

## 3. Added beyond the report

These are new code the audit has not seen, so they deserve a look.

- **`REPLACEMENT_GAS` (1,000,000).** A node may estimate on top of the pending transaction. The local chain does this: a replacement for a
  waiting `addPaymentToken` reverts in the estimate with `TOKEN_IDENTITY_REQUIRED`, and every attempt fails. When a step already has a
  hash and is not the deploy, a failed estimate falls back to this fixed limit. The replacement holds the same nonce, so at most one of the
  two lands. Real gas in a dry run: 169,104 / 67,088 / 74,816 / 30,506 / 49,561 for the five steps after the deploy.
- **`NONCE_MOVED`.** A step never moves to a new nonce unread. The run stops and a resume reads the chain. This also rules out a second
  deploy at a later nonce.
- **`RESUME_OUT_OF_ORDER`.** A step that would take the nonce of a waiting transaction of another step stops the run instead of replacing it.
- **`cacheTimeout:-1`** on the `safe-batch` provider, so repeated reads reach the RPC.

## 4. What to look at hardest

1. **The resume order.** Can `floor` be wrong and leave a run waiting on a nonce gap? Can dropping `seed` lose an outbid that was needed?
   Can a step be pushed into `steps[]` when it should not be? A reverted waiting transaction is not pushed, and its nonce is counted.
2. **`REPLACEMENT_GAS`.** Can the fallback send something that should have stopped? Is the limit too low for any step?
3. **The new stops.** Can `NONCE_MOVED`, `RESUME_OUT_OF_ORDER` or `HEAD_BEHIND_RECORD` block a valid run for good?
4. **A recorded step is not resent.** Does that hide anything the read-back does not catch, for example after a reorg?
5. **Fee logic.** A refused bid raises `last`, and only an accepted fee reaches the record. Can a run overpay badly or fall short?
   Bids are not capped: 8 attempts reach about 4.8x.
6. **`safe-batch` on a real RPC.** Can pinned reads, the head rule or the log chunks cause false refusals on a public load-balanced RPC? Can a
   stale state still pass three consecutive reads?
7. **Secrets.** The key now lives in a PowerShell variable between the prompts and the deploy call. Is the scoping right on every exit path?
8. **Anything in audit 358f7f40 not actually fixed.**

Report severity, reproduction and fix. Not in scope: artwork, the Mint web page, World 3D.

## 5. Known and accepted, or not yet done

- Submission 11, section 6 still applies, except that a single lagging read no longer loses a landed hash in the resume path above.
- The gates in `deploy-mainnet.mjs` use repeated reads, not pinned blocks. A node that stays behind for all of them can still say "not done"
  about a step that landed under a lost hash and is not in the record. The next send then fails on the estimate, reverts or gets `NONCE_MOVED`.
  It cannot deploy a second contract or skip a step.
- A recorded step that a reorg removes is not resent. If it does not land again, the read-back reports a mismatch and a person must check.
- `holds` lowers the chance of a stale pass in `safe-batch` but cannot prove freshness: a change newer than the agreed head is not seen.
  The contract's own guards and the all-or-nothing batch remain the last check.
- An RPC whose log limit is under 10,000 blocks gets `LOGS_UNAVAILABLE`. The default public RPC was not tried against this.
- `--logs-checked-on-etherscan` is the owner's own statement. The tool cannot check it.
- Finding 7: the key is still in the PowerShell process memory until the script ends.
- Not built yet, all planned before opening: the metadata and image host, the mainnet signer Worker, the keeper, the final free list and the
  production GOLD book entry (`genesis-deployments.ts` is still empty).

## 6. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **132 tests: 129 pass, 0 fail, 3 skipped**.
The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy (35 tests), unchanged.

New in `tests/contract/deploy-mainnet-cli.test.mjs`: a resume over real JSON-RPC with a real `Wallet`, so ethers maps the node's own errors. It
has scripted stale answers and a real waiting transaction in the mempool:

- two stale nonce reads, on a node estimating on the latest block and on the pending block;
- a record that lost the fee, where each bid is higher;
- a failed resume keeps the record;
- a stale gate with a stale receipt;
- a lost hash;
- `NONCE_MOVED`.

Run against the Submission 11 tool, these fail except "a failed resume keeps the record". With the estimate on the latest block, the old tool
fails with `NONCE_EXPIRED`, as in the audit's reproduction.

`tests/contract/deploy-mainnet.test.mjs` adds `holds`, `stableHead`, pinned reads, the two locks, the uint40 bound and `LOGS_UNAVAILABLE`.

The tools import `./runtime.mjs`, a local stand-in that supplies the pinned ethers 6.15 build and the test chain. As in earlier submissions, it
is not published.

`deploy-mainnet.ps1` has no test in this package. It was run again locally on a temp copy, in a temp home folder, with real node and canned
answers: success with the real tools against the local chain (6 transactions), then a refused second run; with stand-in tools exiting 1 or 2:
resume, cancel, pre-check failure, stop, read-back mismatch, Safe file failure; a key for another address, a bad address, a bad key and a bad
signer file. All stopped as written. The stand-ins logged that the pre-check process had no `DEPLOYER_PRIVATE_KEY`, and no secret reached the
console.

## 7. Not verified

- Never run against mainnet or a real load-balanced RPC. The lag is our model of one.
- The real Safe Transaction Builder import, which audit 90ae2f92 asks for on Sepolia before mainnet.
- The local chain runs Cancun, not the current mainnet rules. The `~40M if EIP-8037 is live` allowance in `preflight` is not exercised.
- `genesis.imdember.com` does not serve metadata yet. `open` refuses until it does; the tests use a stand-in host.
- These fixes had no independent review before this submission.

## 8. Files

The layout is the same as Submission 11: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json` reproduces the
build; `build/build-receipt.json` records it. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except
itself.
