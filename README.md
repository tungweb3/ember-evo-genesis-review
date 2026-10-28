# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission6](Submission6/AUDIT_README.md) — sixth pre-audit (2026-10-29): more payment tokens at the
same $20, each with its own GOLD price (imdUSD v1 and later v2: 1,200 GOLD; USDC: 1,600 GOLD), added by the owner at
most twice, usable two days after being added.** Not deployed on any chain; `Submission6/build/standard-input.json`
reproduces it (solc 0.8.38, runtime 24,353 bytes). Everything else is unchanged from Submission5, whose AUDIT_README
stays the reference for the rest of the design.

- Primary scope: [`Submission6/contracts/EmberEvoGenesisCandidate.sol`](Submission6/contracts/EmberEvoGenesisCandidate.sol);
  the change from Submission5 is [Submission6/build/EmberEvoGenesisCandidate.Submission5-to-6.diff](Submission6/build/EmberEvoGenesisCandidate.Submission5-to-6.diff).
- Secondary scope: `Submission6/offchain/` (approval signer and the GOLD book's per-token price list).

[Submission5](Submission5/AUDIT_README.md) (Sepolia `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`, verified on Etherscan; the
fourth audit b0b1d96a handled) and [Submission1](Submission1/AUDIT_README.md) to [Submission4](Submission4/AUDIT_README.md)
are the earlier pre-audits, kept unchanged as history (the Sepolia contracts of Submissions 1-4, `0x8ce6…2efa`,
`0xb972…a836`, `0x0FB5…4085` and `0xD5f3…F8Af`, are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
