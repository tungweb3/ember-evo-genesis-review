# Ember Evo Genesis: mainnet build and deployment tools, Submission 10 (2026-11-02)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package is the
build intended for Ethereum mainnet and the tools that will deploy it. The owner asked for this review before the
deployment. **This version is not deployed on any chain.**

Submissions 5 to 9 stay the reference for the design. Submission 9's README lists the last audit findings handled.

## 1. What changed from Submission 9

**The contract.** One statement is removed from the constructor, `require(block.chainid != 1, "MAINNET_NOT_REVIEWED")`, and
its comment is rewritten. See [build/EmberEvoGenesisCandidate.Submission9-to-10.diff](build/EmberEvoGenesisCandidate.Submission9-to-10.diff).

[build/bytecode-comparison.Submission9-to-10.json](build/bytecode-comparison.Submission9-to-10.json) compares the two public
standard inputs, compiled with the same solc 0.8.38 payload:

| | Submission 9 | Submission 10 |
|---|---|---|
| Runtime | 24,427 bytes | 24,427 bytes, identical once the trailing CBOR metadata is removed |
| ABI | | identical |
| Creation code | 27,565 bytes | 27,489 bytes; `bytecode-comparison` gives the differing span (constructor code only) |

**New tools**

- `tools/deploy-mainnet.ps1`: the owner runs it in their own terminal. It creates the two secret files if absent, asks for
  the deployer key and RPC URL, runs the on-chain pre-check, asks for the word `DEPLOY`, deploys, and writes the Safe file.
- `tools/deploy-mainnet.mjs`: the transactions, the on-chain pre-check, the read-backs and the World GOLD book entry.
- `tools/safe-batch.mjs`: Safe Transaction Builder files. `accept` is `acceptOwnership()`. `open` is
  `configureSnapshot` plus `setMintPaused(false)`. It signs and sends nothing.
- `tests/contract/deploy-mainnet.test.mjs`: the whole sequence on a simulated chainId 1.
- `offchain/signer/tools/new-signer-key.mjs`: published for the first time, because the deploy script uses it.

**Changed tools and tests.** See [build/tools-and-tests.Submission9-to-10.diff](build/tools-and-tests.Submission9-to-10.diff).
`deploy-testnet.mjs` gained the changes used for the Sepolia rehearsal, `verify-etherscan.mjs` now prints a mainnet link, and two
tests that expected the mainnet guard now expect a deployment. `contracts/testnet/TestUSDC.sol` is new and is used only by the rehearsal.

**Unchanged byte for byte:** the approval signer, its README and the GOLD-book copy. World moved from `7d09bda` to
`8e6f3e1`, which only records a wallet-lock hash.

## 2. The planned mainnet sequence

Fixed values in `deploy-mainnet.mjs` (`MAINNET`):

| Parameter | Value |
|---|---|
| Name, symbol, supply | `Ember Evo Genesis`, `EGEN`, 1,688 |
| Base payment | imdUSD v1 `0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25`, 20 tokens, 1,200 GOLD |
| Added payment | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 20 tokens, 1,600 GOLD, usable two days after it is added |
| Payment recipient and final owner | Safe `0x29e7c208481f648795f677b55F6ECb2bADc2F01E`, 2 of 3 |
| Metadata | `https://genesis.imdember.com/meta/`, pending `https://genesis.imdember.com/meta/pending.json`, locked at deployment |

Six deployer transactions, in order:

1. Deploy, with the deployer as temporary owner. Minting starts paused.
2. `setRevealURIs(pending, base, locked=true)`.
3. `setRevealCommit`, with an acceptance signed by the approval signer over a block 2 below the head. It must land within 256
   blocks, so it is done here and not through the Safe.
4. `addPaymentToken(USDC, 1600)`.
5. `approvePaidPrice()`.
6. `transferOwnership(Safe)`. The Safe then becomes owner through `acceptOwnership()`.

Later, the Safe runs the `open` batch: `configureSnapshot` (once only) and `setMintPaused(false)`, with the opening at least 6 hours
after the file is made.

A dry run on the simulated chain used about 5.94M gas in total.

## 3. What to look at hardest

1. **Removing the guard.** Does anything in the contract, signer or GOLD book rely on never running on chainId 1? Is any
   test-only behaviour reachable on mainnet? The EIP-712 name stays `EmberEvoGenesisCandidate`, version `7`, because the
   audited World GOLD book pins it.
2. **The deployer window.** Between step 1 and `acceptOwnership()`, what can the deployer key still do, including after step 6?
   Can anyone front-run or grief a step (minting is paused and no free list is set)? Could a partial run leave a contract that
   looks valid but is wrong?
3. **Order and permanence.** The metadata URIs lock at step 2, before the metadata host is live. Is the order right? Is a check
   missing before an irreversible call?
4. **Read-backs.** Does the `expect` list cover every value the next steps depend on? Does a mismatch stop the process safely?
   Note that it runs only after all six transactions.
5. **`preflight`.** Are the checks on imdUSD, USDC, the Safe's owners and threshold, the roles and the balance sufficient? Can
   a load-balanced RPC answering from a stale node give a wrong result, or send a wrong nonce?
6. **`safe-batch.mjs open`.** Does the root use the same dedupe and sort as the wallet file the signer serves? Are the time
   checks right? What if the batch executes after `start`, or the list contains a contract, zero or badly formatted address?
7. **Secrets.** The script keeps the deployer key and RPC URL in process environment variables and creates the two key files in the
   home folder. On Windows, `mode: 0o600` is not enforced. Does any secret reach a log, the deployment record or a child process
   that does not need it? Is signer key and reveal seed separation kept?
8. **World registry entry.** Does `mainnetGoldBookEntry` match what `offchain/gold-book/server/genesis-gold.ts` validates,
   including `deployBlock` taken from `startBlock`, the amounts and the lower-casing?

Report severity, reproduction and fix. Not in scope: artwork, the Mint web page, World 3D.

## 4. Known and accepted, or not yet done

- The deploy tool has no resume. If it stops part way, the script tells the owner not to run it again and to check first. The
  transaction hashes are printed as it goes, but the deployment record is written only after all six steps.
- The deployer stays owner until the Safe signs `acceptOwnership()`. The plan is to sign straight after the deployment.
- Not built yet, all planned before opening: the metadata and image host, the mainnet signer Worker, the keeper, the final free
  list, and the production GOLD book entry (`genesis-deployments.ts` is still empty).

## 5. Tests

The local suite for the contract and signer (Node 24, Hardhat EDR Cancun in-process chain) gives **101 tests: 98 pass, 0 fail, 3
skipped**. The 3 skips are the ones kept on purpose since Submission 7. `tests/gold-book/genesis-gold.test.mjs` is the World copy
(35 tests), unchanged.

The tools import `./runtime.mjs`, a local stand-in that supplies the pinned ethers 6.15 build and the test chain. As in earlier
submissions, it is not published.

## 6. Not verified

- Never run against mainnet. The mainnet sequence has run only on a simulated chainId 1 with local stand-ins: fixture tokens in
  place of imdUSD and USDC, and a plain test account in place of the Safe. `preflight` and the real Safe Transaction Builder import
  are not exercised by the tests.
- The Sepolia rehearsal (contract `0x630CF8c1D20697d28D2a54d4e4a4612B7bEA5b30`) covered the Submission 9 build with `deploy-testnet.mjs`:
  free and paid mints in both tokens, GOLD settlement, a discounted order paid in the wrong token, a disabled token, and an expired
  order. It did not use `deploy-mainnet.mjs` or `safe-batch.mjs`.

## 7. Files

The layout is the same as Submission 9: `contracts/`, `build/`, `tests/`, `offchain/` and `tools/`. `build/standard-input.json`
reproduces the build; `build/build-receipt.json` records it. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers
every file in this folder except itself.
