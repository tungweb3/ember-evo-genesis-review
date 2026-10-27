# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission4](Submission4/AUDIT_README.md) — fourth pre-audit (2026-10-28), answering the third audit
(explorer.imd.fun job d726b1cd), plus the owner's changes (payment to a treasury Safe in a stable token, 1,688 supply,
2.5% royalty) and a gas review.** Read [Submission4/AUDIT_README.md](Submission4/AUDIT_README.md) first, then
[Submission4/FINDINGS_RESPONSE.md](Submission4/FINDINGS_RESPONSE.md) (each Submission 3 finding, what changed, which
test covers it; the owner changes and the gas review).

- Primary scope: [`Submission4/contracts/EmberEvoGenesisCandidate.sol`](Submission4/contracts/EmberEvoGenesisCandidate.sol)
  (ERC-721, OpenZeppelin 5.4.0, solc 0.8.38, viaIR, optimizer 200, EVM cancun).
- Deployed on Sepolia and verified on Etherscan (exact match):
  https://sepolia.etherscan.io/address/0xD5f3A0cdC26c3d19B7E657586f2eA2483A7Bf8Af#code
- `Submission4/build/standard-input.json` is the exact standard-JSON input that reproduces the deployed bytecode.
- Secondary scope (trust model): `Submission4/offchain/` (approval signer and off-chain GOLD ledger).

[Submission1](Submission1/AUDIT_README.md), [Submission2](Submission2/AUDIT_README.md) and
[Submission3](Submission3/AUDIT_README.md) are the earlier pre-audits, kept unchanged as history (their Sepolia contracts
`0x8ce6…2efa`, `0xb972…a836` and `0x0FB5…4085` are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
