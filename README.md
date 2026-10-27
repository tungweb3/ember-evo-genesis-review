# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters).

**Current: [Submission2](Submission2/AUDIT_README.md) — second pre-audit (2026-10-27), answering the first audit
(explorer.imd.fun job 31bb373a).** Read [Submission2/AUDIT_README.md](Submission2/AUDIT_README.md) first, then
[Submission2/FINDINGS_RESPONSE.md](Submission2/FINDINGS_RESPONSE.md) (each Submission 1 finding, what changed, which
test covers it).

- Primary scope: [`Submission2/contracts/EmberEvoGenesisCandidate.sol`](Submission2/contracts/EmberEvoGenesisCandidate.sol)
  (ERC-721, OpenZeppelin 5.4.0, solc 0.8.38, viaIR, optimizer 200, EVM cancun).
- Deployed on Sepolia and verified on Etherscan (exact match):
  https://sepolia.etherscan.io/address/0xb972164188e5164402EDbaCBa3f6f95Decfba836#code
- `Submission2/build/standard-input.json` is the exact standard-JSON input that reproduces the deployed bytecode.
- Secondary scope (trust model): `Submission2/offchain/` (approval signer and off-chain GOLD ledger).

[Submission1](Submission1/AUDIT_README.md) is the first pre-audit, kept unchanged as history (its Sepolia contract
`0x8ce6…2efa` is retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
