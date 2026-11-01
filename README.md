# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission10](Submission10/AUDIT_README.md): the build intended for Ethereum mainnet and its deployment
tools, submitted for review before the deployment (2026-11-02).** One constructor statement, the rehearsal guard against chainId 1, is
removed; the runtime is identical to Submission9 once the trailing metadata is removed. New: `tools/deploy-mainnet.ps1`,
`tools/deploy-mainnet.mjs` and `tools/safe-batch.mjs`. Not deployed on any chain; `Submission10/build/standard-input.json`
reproduces it (solc 0.8.38, runtime 24,427 bytes). The contract change is in
[Submission10/build/EmberEvoGenesisCandidate.Submission9-to-10.diff](Submission10/build/EmberEvoGenesisCandidate.Submission9-to-10.diff).

[Submission9](Submission9/AUDIT_README.md) (remediation of audit d1c83d3d, published for the record; Sepolia rehearsal
`0x630CF8c1D20697d28D2a54d4e4a4612B7bEA5b30`), [Submission8](Submission8/AUDIT_README.md) (the signer applies its token policy at approve too; audit d1c83d3d handled in
Submission9), [Submission7](Submission7/AUDIT_README.md) (the paid authorization names the payment token; audit e9fc751f handled in
Submission8), [Submission6](Submission6/AUDIT_README.md) (multi-token payment with a GOLD price per token; audit 944905c3 handled in
Submission7), [Submission5](Submission5/AUDIT_README.md) (Sepolia `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`, verified on Etherscan; the
fourth audit b0b1d96a handled) and [Submission1](Submission1/AUDIT_README.md) to [Submission4](Submission4/AUDIT_README.md)
are the earlier pre-audits, kept unchanged as history (the Sepolia contracts of Submissions 1-4, `0x8ce6…2efa`,
`0xb972…a836`, `0x0FB5…4085` and `0xD5f3…F8Af`, are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
