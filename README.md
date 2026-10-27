# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters).

**Current: [Submission3](Submission3/AUDIT_README.md) — third pre-audit (2026-10-27), answering the second audit
(explorer.imd.fun job 388b71cb).** Read [Submission3/AUDIT_README.md](Submission3/AUDIT_README.md) first, then
[Submission3/FINDINGS_RESPONSE.md](Submission3/FINDINGS_RESPONSE.md) (each Submission 2 finding, what changed, which
test covers it).

- Primary scope: [`Submission3/contracts/EmberEvoGenesisCandidate.sol`](Submission3/contracts/EmberEvoGenesisCandidate.sol)
  (ERC-721, OpenZeppelin 5.4.0, solc 0.8.38, viaIR, optimizer 200, EVM cancun).
- Deployed on Sepolia and verified on Etherscan (exact match):
  https://sepolia.etherscan.io/address/0x0FB5B6E5c1B026c611900a864755faC86dAd4085#code
- `Submission3/build/standard-input.json` is the exact standard-JSON input that reproduces the deployed bytecode.
- Secondary scope (trust model): `Submission3/offchain/` (approval signer and off-chain GOLD ledger).

[Submission1](Submission1/AUDIT_README.md) and [Submission2](Submission2/AUDIT_README.md) are the earlier pre-audits,
kept unchanged as history (their Sepolia contracts `0x8ce6…2efa` and `0xb972…a836` are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
