# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission7](Submission7/AUDIT_README.md) — seventh pre-audit (2026-10-29): the fixes for the Swarm audit
of Submission6 (job 944905c3). The paid authorization now names the payment token, so an order pays only in the token
it was prepared for, and the signer can stop issuing orders for a token by policy.** Not deployed on any chain;
`Submission7/build/standard-input.json` reproduces it (solc 0.8.38, runtime 24,427 bytes).

- Primary scope: [`Submission7/contracts/EmberEvoGenesisCandidate.sol`](Submission7/contracts/EmberEvoGenesisCandidate.sol);
  the change from Submission6 is [Submission7/build/EmberEvoGenesisCandidate.Submission6-to-7.diff](Submission7/build/EmberEvoGenesisCandidate.Submission6-to-7.diff).
- Secondary scope: `Submission7/offchain/` (approval signer and the GOLD book).

[Submission6](Submission6/AUDIT_README.md) (multi-token payment with a GOLD price per token; audit 944905c3 handled in
Submission7), [Submission5](Submission5/AUDIT_README.md) (Sepolia `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`, verified on Etherscan; the
fourth audit b0b1d96a handled) and [Submission1](Submission1/AUDIT_README.md) to [Submission4](Submission4/AUDIT_README.md)
are the earlier pre-audits, kept unchanged as history (the Sepolia contracts of Submissions 1-4, `0x8ce6…2efa`,
`0xb972…a836`, `0x0FB5…4085` and `0xD5f3…F8Af`, are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
