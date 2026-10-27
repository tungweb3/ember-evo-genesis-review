# Audit report

> Review Submission4/ only. Read Submission4/AUDIT_README.md, then Submission4/FINDINGS_RESPONSE.md (how each finding of the third audit, job d726b1cd, was handled, plus the owner changes and a gas review). Primary scope: Submission4/contracts/EmberEvoGenesisCandidate.sol (verified on Sepolia 0xD5f3A0cdC26c3d19B7E657586f2eA2483A7Bf8Af, solc 0.8.38). Not in scope: contracts/test, contracts/testnet, OpenZeppelin.
>
> Check the fixes: an expiry re-arm moves only its own epoch, while a later epoch keeps the last commitment re-arm block (new revealState layout, bits 64-215); MAX_COMMIT_REARMS counted from the last two commitment blocks; the one-hour RevealCommitAcceptance window (one unchecked subtraction); readyReveals reads pinned to one block.
> New since Submission 3: payment goes to an immutable paymentRecipient (the treasury Safe) instead of a burn address. mintFree takes the wallet's free-list index and claims are one bit per index (leaf = keccak256(keccak256(abi.encode(index, wallet)))): can any wallet claim twice, use another wallet's slot, or block it? mintPaid verifies only a PaidAuthorization the contract rebuilds from the caller and its own recipient, prices and signer epoch (no Appearance signature, no order struct, no totalSupply check): is any binding lost compared with Submission 3? ERC-2981 royaltyInfo: 2.5% to the treasury, fixed.
> Secondary: the signer (free-approval snapshotTree and indexOf, paid-approval) and the GOLD book changes (registry recipient, domain version 7 accepted in world-gold-result.ts). Report severity, reproduction and fix.

| | |
|---|---|
| Repository | https://github.com/tungweb3/ember-evo-genesis-review.git |
| Commit | `b14f07d534fe9469532535bdac00e80094889411` |
| Job | `b0b1d96a-bd57-44c7-a43c-8b7d123b9bb2` |
| Judged | 2026-10-27 20:23 UTC |
| Findings | 2 low · 1 info |

Four agents audited the code as it is at `b14f07d`, each in one area (math, permissions, economics, control flow),
and a judge reproduced, merged and ranked what they found, then read the code once more itself. Nothing in the repository was changed or deployed.

## Findings

### 1. Low: RevealCommitAcceptance window bounds only deadline - now at use time, not the acceptance's lifetime: an acceptance signed with a far deadline becomes usable by the owner alone in its last hour (d726b1

`Submission4/contracts/EmberEvoGenesisCandidate.sol:289`

```
        unchecked { require(deadline - block.timestamp <= ACCEPTANCE_WINDOW, "REVEAL_ACCEPTANCE_EXPIRED"); }
```

Merged from audit_flow (d5ff4d7d) and audit_math (3b8ff7a3), which report the same mechanism. setRevealCommit (lines 283-305) checks `deadline - block.timestamp <= ACCEPTANCE_WINDOW` when it is called. RevealCommitAcceptance(commit, previous, signerEpoch, deadline) carries no issue time or nonce the contract can check, so the contract enforces a usable window in the last hour before the signer-chosen deadline, not a lifetime of at most one hour. The unchecked arithmetic itself is correct: a past deadline wraps and is refused, and deadline == now and deadline == now + 3600 are accepted. AUDIT_README line 13 ('valid for at most one hour'), line 98, line 223 ('valid for at most an hour, so a spare acceptance cannot be kept for later'), the code comment at lines 286-288 and FINDINGS_RESPONSE finding 4 all claim the stronger property. Off chain, signRevealCommit (offchain/signer/reveal-chain.mjs:46) signs any deadline it is given. Only tools/deploy-testnet.mjs passes latest block time + 3600. Consequence: a spare acceptance with deadline D can still be used by the owner alone in [D-1h, D], provided `previous` is still the contract's revealCommit. That is the d726b1cd finding-4 case: after a commitment re-arm, while the new chain's first secret is unopened, the owner holds an acceptance with D after REARM_COOLDOWN and replaces the chain again without asking the signer. Bounded: the signer must once have signed a deadline more than an hour ahead, and MAX_COMMIT_REARMS and REARM_COOLDOWN still apply.

**Reproduction**

Fresh deployment (owner = test, signer key 0xA11CE, chainId 11155111, paused, revealCommit = 0, signerEpoch = 1). At T the signer signs RevealCommitAcceptance(commit=C, previous=0, signerEpoch=1, deadline=T+30 days). setRevealCommit(C, T+30d, sig) at T reverts REVEAL_ACCEPTANCE_EXPIRED, which is what the project's test checks. vm.warp(T+30d-10min), with no new signer action. Expected per README 8.2: revert, because the acceptance is 30 days old. Actual: success, and revealCommit == C. I ran the attached proof with forge 1.8.3, solc 0.8.38 via-IR cancun, OZ from Submission4/build/standard-input.json. It fails on the current code with 'next call did not revert as expected'. Fix: bind the acceptance to something fresh the contract can check. One option: add `uint256 notBefore` (issue time) to the struct and require notBefore <= now <= deadline && deadline - notBefore <= ACCEPTANCE_WINDOW. Another: bind it to reveal state the owner cannot hold still, such as nextRevealIndex or a commit nonce. Also make signRevealCommit refuse deadline > latest block time + 3600. Otherwise restate README 1/5/8.2 so the guarantee is the signer's policy, not the contract's.

**Proof**: a Foundry test that fails on this code and passes once it is fixed.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EmberEvoGenesisCandidate} from "Submission4/contracts/EmberEvoGenesisCandidate.sol";

contract PayToken is ERC20 { constructor() ERC20("Test USD", "tUSD") { _mint(msg.sender, 1e30); } }

contract AcceptanceWindowTest is Test {
    EmberEvoGenesisCandidate g;
    uint256 constant SIGNER_PK = 0xA11CE;
    address signer;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(1_800_000_000);
        vm.roll(1000);
        signer = vm.addr(SIGNER_PK);
        PayToken t = new PayToken();
        g = new EmberEvoGenesisCandidate(address(this), address(t), signer, address(0xBEEF), 20e18, 1200, "tEEVO");
    }

    function _acceptance(bytes32 commit, bytes32 previous, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domainSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EmberEvoGenesisCandidate"), keccak256("7"), block.chainid, address(g)));
        bytes32 structHash = keccak256(abi.encode(
            keccak256("RevealCommitAcceptance(bytes32 commit,bytes32 previous,uint256 signerEpoch,uint256 deadline)"),
            commit, previous, uint256(g.signerEpoch()), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// The README (sections 1, 5, 8.2) and the d726b1cd finding-4 fix state that an acceptance is valid for at most one
    /// hour, so a spare one cannot be kept for later. An acceptance signed today with a 30-day deadline is refused today
    /// but accepted 30 days later, in the last hour before its deadline: the owner alone can hold it and use it then.
    function test_spareAcceptanceWithFarDeadlineIsUsableLater() public {
        bytes32 commit = keccak256("fresh chain anchor");
        uint256 signedAt = block.timestamp;
        uint256 deadline = signedAt + 30 days;
        bytes memory acceptance = _acceptance(commit, bytes32(0), deadline);

        vm.expectRevert(bytes("REVEAL_ACCEPTANCE_EXPIRED"));
        g.setRevealCommit(commit, deadline, acceptance);   // refused on the day it was signed (the tested behaviour)

        vm.warp(deadline - 10 minutes);                    // 30 days later; the signer has not been asked again
        // Expected (README: "valid for at most an hour ... cannot be kept for later"): still refused.
        // Actual: accepted, the owner alone replaces the commitment with a 30-day-old acceptance.
        vm.expectRevert();
        g.setRevealCommit(commit, deadline, acceptance);
    }
}
```

### 2. Low: An expiry re-arm still re-draws, or offers a keep-or-redraw choice on, every later closed epoch whose seed block expires during the same withhold: one withheld secret buys more than 'one fresh draw fo

`Submission4/contracts/EmberEvoGenesisCandidate.sol:623`

```
            if (h == bytes32(0)) { _rearm(e, true); return progressed; }
```

Merged from audit_permissions (48e083b9) and audit_economics (25e1a446), which report the same mechanism. The Submission 4 layout is implemented as described: _rearm(e, true) writes only bits 144-215, and epochSeedBlock (line 445) applies the expiry block only to epoch uint32(rs >> 184). But the property the package claims for it does not hold. The claims are in the code comment at lines 324-325 ('a withheld secret buys one fresh draw for its own epoch only'), in AUDIT_README line 225 ('later epochs keep their own seed blocks ... and each needs its own 27-hour withhold for its own one fresh draw'), line 227 ('only the expired epoch is exposed'), and FINDINGS_RESPONSE finding 2. Later epochs' secrets sit deeper in the same chain (x[i-1] = keccak(x[i])), so nobody but the signer can settle them while it withholds the epoch ahead. Their seed blocks age in parallel with the withheld one. (a) Epochs that share the last commitment re-arm block expire at the same moment: once the epoch ahead is sealed, the next secret published for the epoch behind hits h == 0 at line 623 and re-arms it. Its outcome, fixed since that block, is discarded with no second withhold. This is the Submission 3 backlog effect, reached through each epoch's own expiry. (b) Epochs on natural seed blocks (n, n+25, ...): when the epoch ahead is sealed, the signer, who already knows the next epoch's outcome, can publish its secret to keep that outcome, or wait about 25 more blocks per epoch (not another 8,191) and get a fresh draw. That is a per-epoch keep-or-redraw choice for every random epoch that closed during one visible ~27 h withhold. Random mints are not stopped by a pending reveal (_checkMint, random branch), so the backlog can grow to ~8,191/25 epochs. This is signer trust only: no minter or owner gains a lever, and per epoch the expiry draw still cannot repeat while the secret is private.

**Reproduction**

I ran Foundry (forge 1.8.3, solc 0.8.38 via-IR cancun, OZ from build/standard-input.json) against the unmodified contract. There is no EIP-2935 code, so the window is 256 blocks instead of 8,191. Setup: chain x0 = keccak(x1), x1 = keccak(x2); free random mints at S+1 (epoch 0, seed S+25) and S+26 (epoch 1, seed S+50). Case (b): at S+282, settle([x1]) gives epochSecretOpened(0) == true. At S+284, settle([]) seals epoch 0, and epochSeedBlock(1) == S+50. From that state, option A: settle([x2]) at S+284 seals epoch 1 on hash(S+50), which the signer already knew (nextRevealIndex == 2). Option B: roll to S+307 and settle([x2]) gives an expiry re-arm, epochSecretOpened(1) == true and epochSeedBlock(1) == S+308, a fresh draw for 23 extra blocks. Case (a): pause, roll to S+50+7201, setRevealCommit(y0, previous=x0). Now epochSeedBlock(0) == epochSeedBlock(1) == c1. At c1+257, settle([y1]) re-arms epoch 0 alone. At c1+259, settle([]) seals it. Then settle([y2]), published at once. Expected per README 8.2: epoch 1 seals on hash(c1), because its secret was not withheld. Actual: nextRevealIndex stays 1, epochSecretOpened(1) == true, epochSeedBlock(1) == c1+260, so epoch 1 is re-drawn. Both tests pass, which confirms the behaviour. Fix (owner decision, since this is the trust model): restate the code comment, README 5/8.2 and FINDINGS_RESPONSE finding 2. One withhold of the next epoch forces a re-draw on every later epoch sharing a commitment re-arm block, and gives the signer a keep-or-redraw choice on every epoch that closed during the withhold, at ~25 blocks each. Have the keeper treat a ready epoch with no published secret as affecting the whole backlog. Optionally stop random mints while a ready epoch has waited more than N blocks, to cap the backlog. Or, on an expiry re-arm, also move every later closed epoch once, so the re-draw is forced rather than optional (without compounding). If that bound is unacceptable for the 48 gold skins, use the VRF option from 8.2.

### 3. Info: GOLD book stored-hold validator accepts domain version 5 or 7 and any non-zero recipient for every deployment, not the registry's values its comment names

`Submission4/offchain/gold-book/server/world-gold-result.ts:70`

```
   if(!record(o)||!record(d)||!record(c)||d.name!=='EmberEvoGenesisCandidate'||!['5','7'].includes(d.version as string)||d.chainId!==binding.chainId||!sameAddress(d.verifyingContract,binding.contract)
```

From audit_permissions (678495c7). encodeMintAuth's binding (line 41: id, wallet, gold, deadline, chainId, contract, chainInstance) carries no registry entry. So the genesis-r5-paid-v1 branch checks d.version against the fixed set {'5','7'} (line 70) and o.recipient only for being a lowercase non-zero address (line 73). The comment at lines 66-68 says 'Domain version 5, or the registry's domainVersion 7'. For the recipient it already says parseOrder enforces the registry value. Today genesis-gold.ts parseOrder (line 53) and genesisAuthDocument (line 63) build the document from the registry, so reserveGenesisGold stores no wrong hold. The stored-document check is a weaker second line than documented, and it gives no protection to any other writer of this schema. There is no on-chain impact: a mismatched domain or recipient fails the contract's PaidAuthorization signature check.

**Reproduction**

Call encodeMintAuth(auth, {chainInstance:'sepolia-r6-rehearsal-2', chainId:11155111, contract:<a deployment whose registry entry has no domainVersion, so v5>, ...}) with a genesis-r5-paid-v1 document whose domain.version is '7' and whose order.recipient is any non-zero lowercase address other than that deployment's. Expected per the comment: rejected (throw, giving INVALID_MINT_AUTH). Actual: accepted, because line 70 tests only ['5','7'].includes(d.version) and line 73 only for a non-zero recipient. I verified this by reading the code; it is not executed. Fix: add domainVersion and recipient (from the registry entry) to the binding at world-gold.ts:135 and require d.version === (entry.domainVersion ?? '5') and o.recipient === (entry.recipient ?? GENESIS_DEAD). Otherwise reword the comment to say that only parseOrder enforces these values.

---

Judge's submission `c9d3d60fec6865b8cc80c61792e100d10e4b2eee3bca42db5c908acf498d9658`, accepted on the IdentityMD network. Acceptance means the report met the job's checks;
it is not a guarantee that the code has no other defects.
