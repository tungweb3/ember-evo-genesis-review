# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission15](Submission15/AUDIT_README.md): remediation of audit 56694dc1 on the deployment tools for Ethereum
mainnet, published without a further review request (2026-11-04).** The contract is the build of Submission14, byte for byte. The tool
`tools/deploy-mainnet.mjs` changed. Not deployed on any chain;
`Submission15/build/standard-input.json` reproduces it (solc 0.8.38, runtime 24,427 bytes). The differences are in
[Submission15/build/](Submission15/build/).

[Submission14](Submission14/AUDIT_README.md) (remediation of audit 8b5de2de on the deployment tools; audit 56694dc1 handled in Submission15),
[Submission13](Submission13/AUDIT_README.md) (remediation of audit 161d71af on the deployment tools; audit 8b5de2de handled in Submission14),
[Submission12](Submission12/AUDIT_README.md) (remediation of audit 358f7f40 on the deployment tools; audit 161d71af handled in Submission13),
[Submission11](Submission11/AUDIT_README.md) (remediation of audit 90ae2f92 on the mainnet build and tools; audit 358f7f40 handled in Submission12),
[Submission10](Submission10/AUDIT_README.md) (the mainnet build and first version of the tools; audit 90ae2f92 handled in Submission11),
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
