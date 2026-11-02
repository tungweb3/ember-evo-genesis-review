# Ember Evo Genesis: remediation of audit 90ae2f92, Submission 11 (2026-11-03)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package is the
build intended for Ethereum mainnet and the tools that will deploy it, after audit `90ae2f92` of Submission 10 (4 Medium,
3 Low, 2 Info, all in the tools). The owner asked for this review before the deployment. **This version is not deployed on
any chain.**

Submissions 5 to 10 stay the reference for everything unchanged.

## 1. What changed from Submission 10

**The contract.** Only the `@notice` comment (finding 8). See
[build/EmberEvoGenesisCandidate.Submission10-to-11.diff](build/EmberEvoGenesisCandidate.Submission10-to-11.diff).
[build/bytecode-comparison.Submission10-to-11.json](build/bytecode-comparison.Submission10-to-11.json) compares the two public
standard inputs, compiled with the same solc 0.8.38 payload: the runtime (24,427 bytes) and the creation code (27,489 bytes) are
identical once the trailing CBOR metadata is removed, and the ABI is identical.

**The tools** changed a lot: `tools/deploy-mainnet.ps1`, `tools/deploy-mainnet.mjs`, `tools/safe-batch.mjs` and the new
`tools/tool-errors.mjs`. **The signer** changed in `offchain/signer/paid-approval.mjs`, `free-approval.mjs` (one export) and
`worker-entry.mjs`. All of it is in
[build/tools-and-tests.Submission10-to-11.diff](build/tools-and-tests.Submission10-to-11.diff). The GOLD-book copy is unchanged.

## 2. The audit's findings

| # | Finding | What was done | Where |
|---|---|---|---|
| 1 M | The artifact was not compared with the reviewed build; read-backs were missing | Initcode, runtime, ABI and size are pinned and checked before anything is sent. New read-backs: `usableAt`, `startBlock`, `signerEpoch`, EIP-712 chain and contract, deployed code against the runtime template (only 32-byte zero runs may differ) | `MAINNET.reviewed`, `verifyBuild`, `runtimeMatches`, `expect` in `deployMainnet` |
| 2 M | Nonce, commit block and receipts came from a load-balanced RPC with no retry; no resume | Every step has a fixed nonce; a resend replaces it with a fee at least 1.25x higher; the block must be visible over several reads; the commit block is read twice; every run writes a partial record and `--resume` sends only what the chain does not show | `send`, `settled`, `recentBlock`, `stableNonce`, `runGuard` |
| 3 M | No upper bound on the opening time; 11-digit unix time accepted | Exactly 10 digits or an ISO date with a zone; more than 60 days ahead needs `--far-opening`; the owner types the UTC date and the free-list count before the batch is written | `unix`, `openBatch`, CLI `open` |
| 4 M | RPC URL in errors; "copy to Claude" line; children inherit `RPC_URL` | All errors go through a redacting summary; the line is gone; `RPC_URL` is set only around the two node calls that need it | `tool-errors.mjs`, `deploy-mainnet.ps1` |
| 5 L | URIs locked in transaction 2 without validation | Strings validated; transaction 2 stores them unlocked; the Safe's `open` batch locks them, after `GET` of the pending URI and of one derived URI (`--sample-look=<lookKey>/<skin>`, required when the batch locks) | `validateUris`, `checkPendingServed`, `checkSampleServed` |
| 6 L | Deployer window | `status` prints who owns the contract; `accept` and `open` read owner, pendingOwner, snapshot, pause, URIs, commitment, signer, caps and price approval first and refuse a difference; loud reminder at the end of the script; the pre-check refuses a wallet that has already sent transactions | `chainState`, `checkAccept`, `checkOpen`, `checkRecord`, `preflight` |
| 7 L | Nothing tied the on-chain root to `snapshot-wallets.json` | `open` compares the batch's root with the list the Worker bundles; the paid route now also fails `SNAPSHOT_MISMATCH` (503) as the free route does; addresses with contract code are warned about | `checkWorkerList`, `paid-approval.mjs`, `worker-entry.mjs`, `contractWallets` |
| 8 I | NatSpec said test networks only | Reworded; receipt and comparison regenerated | contract, `build/` |
| 9 I | Builder file lacked the app's checksum and decoded methods | Both added, written from the app's source (`apps/tx-builder/src/lib/checksum.ts`, `transactionLibraryContext.tsx` of safe-global/safe-react-apps) | `batchChecksum`, `builderTx` |

**Partly done.** Finding 9 asks for one real import on Sepolia before mainnet: not done yet, it needs the owner's Safe. Finding 7
asks for a check at Worker start-up: the check runs per request, and `open` compares the local file, not the deployed Worker. A
stale Worker fails closed.

## 3. Found after the audit, also fixed

A second round of checks on the fixes: a run through separate processes, a real `Wallet` + `JsonRpcProvider` over HTTP and a lagging
RPC stand-in (`tests/contract/deploy-mainnet-cli.test.mjs`), and an independent review.

- A rerun after a finished run could deploy a second contract, and so could a run from a copy that lost `contract/deployments`.
  `runGuard` covers the first, the nonce check in `preflight` the second.
- ethers' 250 ms provider cache could answer a repeated read, which defeats the repeated reads (`mainnetProvider`, `cacheTimeout:-1`).
- A resume could trust stale reads, or take an RPC error for "no code". It now waits for the record's last block and retries.
- A resume did not outbid a transaction the stopped run left waiting (`pending` in the partial record).
- One lagging read could fail the whole read-back, or a `safe-batch` state read: each read now retries on its own.
- `safe-batch` crashed on a null count when the RPC refused the log range.
- A record with `readBackMismatch` could still produce Safe files by hand: refused (`RECORD_HAS_MISMATCH`).
- A key mistyped into the script's prompt could be echoed by an ethers error: the inline checks print a fixed message.
- A lagging node's estimate of a plain transfer could run a step out of gas: `gasLimit` is the estimate x 1.2, at least 300,000.
- The replacement fee could round to no increase at a tip of a few wei (`+1n`).
- The list written next to the record is named by its root, so a list and a batch cannot disagree after a rerun.
- `runtime-local.mjs` (the unpublished stand-in, see section 7) imports Hardhat only for a test chain, not in the mainnet process.

## 4. The sequence now

Fixed values in `deploy-mainnet.mjs` (`MAINNET`) are unchanged from Submission 10, section 2. Six deployer transactions:

1. Deploy, with the deployer as temporary owner. Minting starts paused.
2. `setRevealURIs(pending, base, locked=false)`.
3. `setRevealCommit`, with an acceptance signed over a block 2 below the head (every resend signs a fresh one).
4. `addPaymentToken(USDC, 1600)`.
5. `approvePaidPrice()`.
6. `transferOwnership(Safe)`.

Then two Safe batches: `accept` (`acceptOwnership()`, straight after the deployment), and later `open`
(`setRevealURIs(pending, base, locked=true)` + `configureSnapshot` + `setMintPaused(false)`, as one batch). A dry run used
5,917,334 gas in total.

## 5. What to look at hardest

1. **Resume.** Can any order of stops, resends, lagging reads and a killed process deploy a second contract, skip a step, record a
   reverted step as done, or leave a partial record that misleads the next run?
2. **Nonce and fees.** Fixed nonces, the outbid logic and `stableNonce`: can a resend be stuck, or use a nonce the deployer has
   since spent? Does the gas floor or margin cause a new failure?
3. **Lock move.** Minting cannot open without `revealURIsLocked`, a snapshot and a commitment (`setMintPaused`). Does moving the lock
   into the `open` batch add a way to open or mint with URIs that can still change? Does the batch's order and its checks hold when
   it executes late?
4. **Read-back and state checks.** Can a stale read pass a check it should fail, in the deploy tool or in `chainState`?
5. **Secrets.** Can the deployer key, RPC URL, signer key or reveal seed reach stdout, stderr, the partial record, the deployment
   record or a child process that does not need it? What can `redact` miss?
6. **Builder file.** Does the file match what Transaction Builder 1.16.5 accepts and shows? `calldataOf` is our copy of how the app
   encodes; the batch decodes bool from the string `true`.
7. **Paid root check.** Does `SNAPSHOT_MISMATCH` come at the right point in `prepare`, and could it stop a valid order?

Report severity, reproduction and fix. Not in scope: artwork, the Mint web page, World 3D.

## 6. Known and accepted, or not yet done

- A broadcast can succeed while the RPC errors on the calls ethers makes right after it, and the hash is then lost. The run stops
  after its attempts or carries on at the same nonce; a resume recovers from the chain. The record may then miss that step's
  block, so `startBlock` is compared with itself or `usableAt` is not compared. The contract sets both itself.
- A reorg that moves the deploy or `addPaymentToken` to another block leaves a false mismatch in the record. It stops the script
  (exit 2) and no funds are at risk; it needs a person to check. `steps[].blockNumber` is not re-read.
- A wallet that has already sent transactions can pass the pre-check with `ALLOW_USED_DEPLOYER=1`. The script does not set it.
- `open` writes the list next to the record before its checks, on purpose: the `WORKER_LIST_DIFFERS` message tells the owner to copy it.
- The deployer stays owner until the Safe signs `acceptOwnership()`. The plan is to sign straight after the deployment.
- Not built yet, all planned before opening: the metadata and image host, the mainnet signer Worker, the keeper, the final free
  list, and the production GOLD book entry (`genesis-deployments.ts` is still empty).

## 7. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **123 tests: 120 pass, 0 fail, 3
skipped**. The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy
(35 tests), unchanged.

New in `tests/contract/deploy-mainnet-cli.test.mjs`: the tools as separate processes, with a real private key and JSON-RPC over HTTP,
through a stand-in RPC with a URL secret that lags on 12% of the calls (old head and nonce, no receipt, no block, no code for a new
contract), on a local chain with chainId 1 and fixture token code at the mainnet addresses. The run is killed after the fourth
transaction, refused a fresh start, resumed (exactly two more transactions), refused again, then `status`, `accept` and `open`
are run and their batches executed as the Safe. Every output and file is scanned for the key and the URL secret.

The tools import `./runtime.mjs`, a local stand-in that supplies the pinned ethers 6.15 build and the test chain. As in earlier
submissions, it is not published.

`deploy-mainnet.ps1` has no test in this package. It was run once locally on a temp copy, in a temp home folder, with real
node and canned answers: success with the real tools against the local chain (6 transactions), then a refused second run; with
stand-in tools exiting 1 or 2: resume, cancel, pre-check failure, stop, read-back mismatch, Safe file failure; a key for another
address, a bad address, an RPC URL typed as the key and a bad signer file. All stopped as written, and no secret reached the console.

## 8. Not verified

- Never run against mainnet or a real load-balanced RPC. The lag is our model of one; it does not cover `eth_estimateGas`.
- The real Safe Transaction Builder import. The checksum test uses our copy of the app's algorithm.
- The local chain runs Cancun, not the current mainnet rules. The `~40M if EIP-8037 is live` allowance in `preflight` is not exercised.
- `genesis.imdember.com` does not serve metadata yet. `open` refuses until it does; the tests use a stand-in host.
- The Sepolia rehearsal (contract `0x630CF8c1D20697d28D2a54d4e4a4612B7bEA5b30`) covered the Submission 9 build with `deploy-testnet.mjs`,
  not these tools.

## 9. Files

The layout is the same as Submission 10: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json`
reproduces the build; `build/build-receipt.json` records it, and `MAINNET.reviewed` pins the same values. No keys, seeds or
credentials are included. `SHA256SUMS.txt` covers every file in this folder except itself.
