# Ember Evo Genesis — audit submissions

Ember Evo Genesis is an **unofficial, community-made** NFT collection (1,688 3D "Pepe" characters).

**Current: [Submission9](Submission9/AUDIT_README.md): remediation of the Swarm audit of Submission8 (job
d1c83d3d), published for the record; the owner has not asked for another external review (2026-10-29).** The contract is
unchanged from Submission8. An empty `PAYMENT_TOKENS` is now a configuration error, a bad `CONTRACT_ADDRESS` is
reported as configuration, and the GOLD book requires the exact payment amount. The README documents the EOA/EIP-7702
requirement and the on-chain recall. Not deployed on any chain; `Submission9/build/standard-input.json` reproduces it
(solc 0.8.38, runtime 24,427 bytes, same as Submission7 and 8). Every change is in
[Submission9/build/offchain.Submission8-to-9.diff](Submission9/build/offchain.Submission8-to-9.diff).

[Submission8](Submission8/AUDIT_README.md) (the signer applies its token policy at approve too; audit d1c83d3d handled in
Submission9), [Submission7](Submission7/AUDIT_README.md) (the paid authorization names the payment token; audit e9fc751f handled in
Submission8), [Submission6](Submission6/AUDIT_README.md) (multi-token payment with a GOLD price per token; audit 944905c3 handled in
Submission7), [Submission5](Submission5/AUDIT_README.md) (Sepolia `0x6A7626c15C4746DA348E4D11F6f38228C743d25d`, verified on Etherscan; the
fourth audit b0b1d96a handled) and [Submission1](Submission1/AUDIT_README.md) to [Submission4](Submission4/AUDIT_README.md)
are the earlier pre-audits, kept unchanged as history (the Sepolia contracts of Submissions 1-4, `0x8ce6…2efa`,
`0xb972…a836`, `0x0FB5…4085` and `0xD5f3…F8Af`, are retired).

`SHA256SUMS` covers every file in this repository except itself; each `SubmissionN/SHA256SUMS.txt` covers its package.
No keys, seeds or credentials are included.
