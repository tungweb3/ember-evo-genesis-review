# Ember Evo Genesis: remediation package, Submission 9 (2026-10-29)

Ember Evo Genesis is an **unofficial, community-made** NFT collection of 1,688 3D "Pepe" characters. This package
answers the Swarm audit of Submission 8 (job `d1c83d3d`: 1 Low, 4 Info). It also carries the GOLD-book fixes from World
audit `93dae57f` (World `7d09bda`, World Submission22).

**Published for the record. The owner has not asked for another external review.** None of the reviews of Submissions
6, 7 and 8 found a Medium or higher issue.

**The contract is unchanged from Submission 8**: same source, same runtime, 24,427 bytes.
`build/standard-input.json` and `build/build-receipt.json` are rebuilt and match Submission 8. Only the approval signer,
its README and the GOLD-book copy changed, and every change is in
[build/offchain.Submission8-to-9.diff](build/offchain.Submission8-to-9.diff). **This version is not deployed on any chain.**

## 1. Findings of audit d1c83d3d and what changed

| # | Severity | Finding | Change |
|---|---|---|---|
| 1 | Low | `PAYMENT_TOKENS` set to an empty string or `0` was treated as unset and allowed every token, while the README promised 500 `CONFIG_PAYMENT_TOKENS`. | Fixed. The new `paymentTokensFromEnv` in `paid-approval.mjs` returns "no policy" only when the variable is absent. `""`, `0`, `"0"`, `" "`, `","`, `" , "` and a lone newline are now an empty list, which the constructor refuses with 500 `CONFIG_PAYMENT_TOKENS`. `worker-entry.mjs` uses it in place of the truthiness test. |
| 2 | Info | A malformed, zero or untrimmed `CONTRACT_ADDRESS` was reported to buyers as 400 `WALLET_INVALID`, and nothing was logged. | Fixed in both signers. A bad contract address is now 500 `CONFIG_CONTRACT_ADDRESS`, and `worker-entry.mjs` trims `CONTRACT_ADDRESS`, as it already does for secrets. `worker.mjs` logs every `ApprovalError` with status 500 or higher as `approval config <code>`. |
| 3 | Info | GOLD consent is ECDSA only, so a Safe or an ERC-4337 account can never be `order.wallet`. | Documented in the header of `paid-approval.mjs` and in the signer README. Paid orders need an EOA or an EIP-7702 account; a contract wallet gets `INVALID_GOLD_CONSENT` before any GOLD is held. ERC-1271 support was not added. |
| 4 | Info | The GOLD book did not compare the payment amount. | Fixed in the book (World audit `93dae57f` finding 1, World `7d09bda`). Every registry token names the exact amount `mintPaid` charges, read back from `paymentTokens(token)`, and the `Transfer` must carry exactly that amount. The README requires every token added on chain to emit the standard 3-topic `Transfer`. |
| 5 | Info | `PAYMENT_TOKENS` cannot recall a PaidAuthorization that approve already returned. | Documented in the signer README. The policy stops new orders only. An order signed before the change stays mintable until its deadline (at most `PAID_TTL_SECONDS`, 900 s). The recall is on chain: `revokePaidOrder(orderId)`, or `setMintPaused(true)`. The Submission 8 sentence "an order the book already holds is released at its deadline" applies only to an order whose approve response never reached the buyer. |

## 2. Tests

The full local suite (Node 24, local in-process chain) gives **99 tests: 96 pass, 0 fail, 3 skipped**. The 3 skips are
the same ones kept on purpose since Submission 7.

`tests/signer/paid.test.mjs` adds these checks:

- `PAYMENT_TOKENS` set but empty, in every form listed in finding 1, is 500 `CONFIG_PAYMENT_TOKENS`.
- An absent variable means no policy.
- Surrounding spaces and a trailing comma are accepted.
- A bad `CONTRACT_ADDRESS` (`0xabc`, the zero address, a trailing newline, a broken checksum) is 500 `CONFIG_CONTRACT_ADDRESS` in both signers.
- The Worker logs the configuration error.

The end-to-end tests run the real contract against the World book at `7d09bda`, with the registry amount read back from
`paymentTokens(token)`. Paid mints in imdUSD (18 decimals) and USDC (6 decimals) settle under the new amount check.

Mutation checks on the private tree:

- Restoring the truthiness test fails the new test.
- Removing the configuration log fails it too.

`tests/gold-book/genesis-gold.test.mjs` is the World copy at `7d09bda` (35 tests).

## 3. Not verified

- Not deployed, not on Sepolia, not on mainnet.
- The Worker was not redeployed with the new signer, and nothing changed on the old Sepolia test site.

## 4. Files

The layout is the same as Submission 8: `contracts/`, `build/`, `tests/`, `offchain/` (the signer and the GOLD-book code it
exercises) and `tools/`. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder
except itself.
