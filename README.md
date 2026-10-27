# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,288 3D "Pepe" characters).

**Current: [Submission1](Submission1/AUDIT_README.md) — pre-audit of the release candidate (2026-10-27, revision 3).**
Read [Submission1/AUDIT_README.md](Submission1/AUDIT_README.md) first: scope, build, roles, flows, intended
properties, known risks and open questions (section 8), tests.

- Primary scope: [`Submission1/contracts/EmberEvoGenesisCandidate.sol`](Submission1/contracts/EmberEvoGenesisCandidate.sol)
  (ERC-721, OpenZeppelin 5.4.0, solc 0.8.38, viaIR, optimizer 200, EVM cancun).
- Deployed on Sepolia and verified on Etherscan (exact match):
  https://sepolia.etherscan.io/address/0x8ce67008570ED41F64e4Be149ecAA66d1aBE2efa#code
- `Submission1/build/standard-input.json` is the exact standard-JSON input that reproduces the deployed bytecode.
- Secondary scope (trust model): `Submission1/offchain/` (approval signer and off-chain GOLD ledger).

`SHA256SUMS` covers every file in this repository except itself; `Submission1/SHA256SUMS.txt` covers the package.
No keys, seeds or credentials are included.