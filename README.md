# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission5](Submission5/AUDIT_README.md) — fifth pre-audit (2026-10-28), answering the fourth audit
(explorer.imd.fun job b0b1d96a: a reveal-commitment acceptance now signs a recent block instead of a deadline; the
withholding trust model restated; a stricter GOLD-book check).** Read [Submission5/AUDIT_README.md](Submission5/AUDIT_README.md)
first, then [Submission5/FINDINGS_RESPONSE.md](Submission5/FINDINGS_RESPONSE.md) (each Submission 4 finding, what
changed, which test covers it).

- Primary scope: [`Submission5/contracts/EmberEvoGenesisCandidate.sol`](Submission5/contracts/EmberEvoGenesisCandidate.sol)
  (ERC-721, OpenZeppelin 5.4.0, solc 0.8.38, viaIR, optimizer 200, EVM cancun).
- Deployed on Sepolia and verified on Etherscan (exact match):
  https://sepolia.etherscan.io/address/0x6A7626c15C4746DA348E4D11F6f38228C743d25d#code
- `Submission5/build/standard-input.json` is the exact standard-JSON input that reproduces the deployed bytecode.
- Secondary scope (trust model): `Submission5/offchain/` (approval signer and off-chain GOLD ledger).

[Submission1](Submission1/AUDIT_README.md) to [Submission4](Submission4/AUDIT_README.md) are the earlier pre-audits,
kept unchanged as history (their Sepolia contracts `0x8ce6…2efa`, `0xb972…a836`, `0x0FB5…4085` and `0xD5f3…F8Af` are
retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
