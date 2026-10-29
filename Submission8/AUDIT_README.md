# Ember Evo Genesis — audit package, Submission 8 (2026-10-29)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters). This is the
**eighth pre-audit** of the release candidate. It answers the Swarm audit of Submission 7
(job `e9fc751f`, 1 Low, 2 Info). **The contract is unchanged from Submission 7** (same source, same runtime, 24,427
bytes); only the approval signer, its README and the GOLD-book copy changed. Everything not described here is unchanged
from [Submission7/AUDIT_README.md](../Submission7/AUDIT_README.md), [Submission6/AUDIT_README.md](../Submission6/AUDIT_README.md)
and [Submission5/AUDIT_README.md](../Submission5/AUDIT_README.md).

**This version is not deployed on any chain.** `build/standard-input.json` and `build/build-receipt.json` are rebuilt
from the same sources and match Submission 7 (`build/build-receipt.json` names the runtime hash). Every changed file is in
[build/offchain.Submission7-to-8.diff](build/offchain.Submission7-to-8.diff).

## 1. Findings of audit e9fc751f and what changed

| # | Severity | Finding | Change |
|---|---|---|---|
| 1 | Low | `allowedTokens` (`PAYMENT_TOKENS`) was enforced in prepare only: an order prepared before a token was excluded, or a retried approve, still got a GOLD hold and a PaidAuthorization | Fixed: `approve` checks `allowedTokens` against `order.token` right after the ticket and URI checks, before the consent check, the GOLD hold and the signature. An excluded token gets `PAYMENT_TOKEN_UNAVAILABLE`, nothing is held and nothing is signed. An order the book already holds is released at its deadline as before. |
| 2 | Info | A malformed `PAYMENT_TOKENS` entry was reported to every buyer as 400 `WALLET_INVALID`, with nothing logged | Fixed: a malformed or zero address in `allowedTokens` fails the constructor with 500 `CONFIG_PAYMENT_TOKENS`, like every other configuration check. |
| 3 | Info | `PAYMENT_TOKENS` and `PAID_TTL_SECONDS` were not documented in the signer README | Fixed: `offchain/signer/README.md` documents both variables, that the policy is applied at prepare and approve, and that rotating `TICKET_SECRET` with it voids every outstanding ticket. |

## 2. Please attack

1. **Signer policy.** With `allowedTokens` set, can any request still get a GOLD hold or a PaidAuthorization for a token
   outside it (a ticket from before the change, a retried approve, letter case of `order.token`, a ticket made for
   another token)?
2. **Configuration.** Can any `PAYMENT_TOKENS` value (empty entries, spaces, a zero address, duplicates) still be
   reported as the buyer's error, or silently allow every token?
3. **GOLD book (secondary scope, `offchain/gold-book/`, World source `6be9ef3`, under review separately as World
   Submission21).** Settlement now also requires the order's own token to have paid: a `Transfer` log emitted by
   `order.token` from the order's wallet to the order's recipient in the same receipt. Is that the transfer `mintPaid`
   makes (`token.safeTransferFrom(msg.sender, paymentRecipient, amount)`) for every kind of wallet (EOA, Safe, ERC-4337,
   EIP-7702)?

## 3. Tests

The full local suite passes (Node 24, local in-process chain): **99 tests, 96 pass, 0 fail, 3 skipped** (the same 3 kept
on purpose as in Submission 7).

Changed: `tests/signer/paid.test.mjs`: an order prepared by an unrestricted signer is refused by a signer limited to
imdUSD at approve, twice, and the GOLD book stub records no hold; a `PAYMENT_TOKENS` list with a malformed address or the
zero address fails with 500 `CONFIG_PAYMENT_TOKENS`. Deleting the new approve check fails that test (mutation checked on
the private tree). `tests/gold-book/genesis-gold.test.mjs` is the World copy at `6be9ef3` (33 tests).

## 4. Not verified

- Not deployed, not on Sepolia, not on mainnet.
- The Worker was not redeployed with the new signer; nothing changed on the old Sepolia test site.

## 5. Files

Same layout as Submission 7: `contracts/`, `build/`, `tests/`, `offchain/` (signer and the GOLD-book code they exercise),
`tools/`. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except itself.
