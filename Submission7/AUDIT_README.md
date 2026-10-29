# Ember Evo Genesis — audit package, Submission 7 (2026-10-29)

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters). This is the
**seventh pre-audit** of the release candidate. It answers the Swarm audit of Submission 6
(job `944905c3`, 2 Low, 3 Info). Everything not described here is unchanged from
[Submission6/AUDIT_README.md](../Submission6/AUDIT_README.md) (multi-token payment, per-token GOLD price) and
[Submission5/AUDIT_README.md](../Submission5/AUDIT_README.md) (the rest of the design).

**This version is not deployed on any chain.** `build/standard-input.json` reproduces it with solc 0.8.38
(Submission 6's settings and OpenZeppelin 5.4.0 sources; only `contracts/*.sol` replaced); see `build/build-receipt.json`
(runtime 24,427 bytes, limit 24,576). Contract diff: [build/EmberEvoGenesisCandidate.Submission6-to-7.diff](build/EmberEvoGenesisCandidate.Submission6-to-7.diff).

## 1. Findings of audit 944905c3 and what changed

| # | Severity | Finding | Change |
|---|---|---|---|
| 1 | Low | PaidAuthorization bound the GOLD price, not the token: imdUSD v1 and v2 (both 1,200 GOLD) were interchangeable for one signature | Fixed: `address token` added to the PaidAuthorization type string (after `recipient`) and to the digest in `mintPaid`. The signer, the wallet's GOLD consent (`GenesisGoldHold`) and the GOLD book's stored order name the token too. The EIP-712 domain version stays "7": the type hash changed, so no Submission 6 signature verifies. |
| 2 | Low | A listed token can never be disabled; only `setMintPaused` (which stops everything) is left | Fixed off chain, owner choice (b): because the signature now names the token, the signer can stop issuing orders for a token by policy (`allowedTokens`, Worker variable `PAYMENT_TOKENS`) while the other tokens and the free route go on. On-chain entries stay "never removed", as designed. |
| 3 | Info | No event names the paying token; `GenesisMinted.cost` is the dollar price in 18 decimals | Documented (contract header): the token that paid is the one in the same receipt's `Transfer` log. Not changed in code (code size; the GOLD book settles exactly from the current events). |
| 4 | Info | The signer's approve answer did not carry the token | Fixed: the order (and so the HMAC ticket) holds the token, and approve returns `mintPaid.token`, the last argument of `mintPaid`. |
| 5 | Info | `usableAt` could be truncated after the year 36812 | Fixed: `addPaymentToken` requires `usableAt >> 40 == 0`. |

## 2. Please attack

1. **Token binding.** With v1, USDC and v2 listed, can an order signed for one token be paid in another, at the same or a
   different GOLD price? Does any field of the order, the wallet's consent or the PaidAuthorization fail to bind
   the token (`token` vs `address(token)`, letter case, a token that is not listed)?
2. **Signer policy.** With `allowedTokens` set, can a buyer still get an order for a token outside it (prepare, approve,
   a ticket made for another token, a retried approve)?
3. **GOLD book (secondary scope, `offchain/gold-book/`, World source `0727200`, under review separately as World
   Submission20).** The registry now lists `paymentToken`/`goldCost` and `addedTokens: [{token, goldCost}]`; an order is
   held only when its `goldCost` is the price listed for its `token`. Can a hold be made at a price no listed token
   charges, or for a token the entry does not list?
4. **Code size and the new check.** Any path where `usableAt >> 40 == 0` refuses a valid add, or where the larger
   digest changes `mintPaid`'s behaviour other than adding the token?

## 3. Tests

The full local suite passes (Node 24, local in-process chain): **99 tests, 96 pass, 0 fail, 3 skipped** (the same 3 kept
on purpose as in Submission 6).

New or changed:
- `tests/contract/second-token.test.mjs`: every order is signed for the token it pays in; new test: an order signed for
  imdUSD v2 is refused in v1 and the reverse (same GOLD price), and a USDC-priced order signed for imdUSD is refused.
- `tests/contract/concurrent.test.mjs`: changing the signed `token` field alone fails the signature.
- `tests/signer/paid.test.mjs`: approve returns `mintPaid.token`; a signer limited to imdUSD refuses USDC; a v2 order
  does not pay in v1 or the reverse; the USDC mint is held and settled by the World book at USDC's price.
- `tests/gold-book/genesis-gold.test.mjs` (29 tests): orders name the token; wrong token/price pairs refused; the
  consent binds the token; registry list validation.

A local end-to-end run of the Mint page (dev server) minted once in each token through prepare, consent, GOLD hold,
approval and `mintPaid`.

## 4. Not verified

- Not deployed, not on Sepolia, not on mainnet. Gas was not re-measured.
- USDC's real proxy behaviour is not in the tests; a 6-decimal fixture token stands in for it.

## 5. Files

Same layout as Submission 6: `contracts/`, `build/`, `tests/`, `offchain/` (signer and the GOLD-book code they exercise),
`tools/`. No keys, seeds or credentials are included. `SHA256SUMS.txt` covers every file in this folder except itself.
