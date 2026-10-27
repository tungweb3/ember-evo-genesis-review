// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice R6 testnet rehearsal build. Deployable on test networks; mainnet is refused until the final review removes
///         that guard. Snapshot, catalogue, price and administration still need final review.
/// @dev R6 over R5 (owner decisions 2026-10-22): looks may repeat (no look uniqueness at all); supply 1,288 with skin caps
///      768 / 168 / 168 / 68 / 68 / 48 (owner 2026-10-25), which the owner may reset with configureSupply until minting opens, after which
///      they are fixed for good. Unchanged from R5: six skins, four mint choices (green / ice / purple chosen at mint,
///      or random), random skins revealed later in 25-block epochs by anyone, paid EMBEO sent to a fixed burn address.
///      No IMD seat mapping, admin mint, NFT burn, rarity, royalties or treasury split.
///      Owner 2026-10-27 (gas): a chosen-skin token does not store its metadata URI. Its URI is derived like a revealed
///      random token's (revealBaseURI + lookKey hex + "/" + skin). The `uri` a mint carries is part of the signed
///      approval (the signer signs exactly that derived URI); the contract does not compare the two. setTokenURI remains an
///      owner override until lockTokenURIs.
///      Pre-audit review 2026-10-27 (owner's choice): random seeds mix the epoch's seed-block hash with the next secret
///      of a hash chain the approval signer commits to before minting opens (setRevealCommit); every mint carries the
///      secrets its reveal needs (`reveals`); expired block hashes come from EIP-2935. Minting cannot open before the
///      snapshot, the locked reveal URIs and the commitment are set.
///      Swarm audit 2026-10-27 (job 31bb373a): a new commitment needs the approval signer's EIP-712 acceptance, can never
///      be one the contract already held, and re-arms in O(1); a mint settles every ready epoch it has secrets for, in
///      any order, sealing and revealing in one call; Appearance names its route (free / paid).
///      Swarm audit 2026-10-27 (job 388b71cb): an expired seed block re-arms the epoch to the next block and keeps the
///      secret that was supplied (now public) for it, so nothing is ever sealed by a secret alone and no one, signer
///      included, is needed to settle it; once an epoch has closed, a new commitment waits REARM_COOLDOWN blocks after its
///      current seed block (a pending re-arm included) and may re-arm it at most MAX_COMMIT_REARMS times; chosen-skin
///      mints freeze from the epoch's own seed block whatever the re-arm; the held-value check covers 32 hashes above
///      every anchor.
///      Gas 2026-10-27 (owner: keep gas low): skin caps, skin counts, totalMinted and freeMinted share one slot; a token
///      is its look key plus 4 bits in a shared word; an epoch's random token ids are packed 16 bits each (two slots for
///      25); the reentrancy guard uses transient storage; one BatchMetadataUpdate per revealed epoch. Gas review
///      2026-10-27 (before deployment): the signer, its epoch, the sale flags, freeStartAt and eligibleWalletCount share
///      one slot; reveal progress and re-arm share another; the random-epoch list packs 8 epochs per word
///      (rearmBlock, rearmFromEpoch, revealedSecrets and paidMinted views removed for code size: epochSeedBlock,
///      chainSecrets and totalMinted - freeMinted give the same answers).
contract EmberEvoGenesisCandidate is ERC721, IERC4906, Ownable2Step, EIP712 {
    using SafeERC20 for IERC20;
    /// configureSupply can never go above this (guards against a mistyped number; owner decision 2026-10-22).
    uint256 public constant SUPPLY_CEILING = 2222;
    /// Paid EMBEO is sent here and can never be moved again (owner decision 2026-10-21). Not changeable after deployment.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// Mint choices 0..2 pick skins 0..2 directly; 3 is random over all six skins.
    uint8 public constant CHOICE_RANDOM = 3;
    uint8 public constant SKIN_COUNT = 6;
    /// About five minutes of Ethereum blocks per reveal epoch.
    uint256 public constant EPOCH_BLOCKS = 25;
    /// At most this many random mints per epoch, so the mint that reveals an epoch does a bounded amount of extra work.
    uint256 public constant MAX_RANDOM_PER_EPOCH = 25;
    /// A closed epoch can be re-armed by a new commitment only this many blocks (about a day) after its seed block, so
    /// nobody can use a replaced chain to re-roll an outcome that is already public (audit 2026-10-27, finding 1).
    uint256 public constant REARM_COOLDOWN = 7200;
    /// New commitments may re-arm the same closed epoch at most this many times (audit 388b71cb, finding 4). Two keep a
    /// way out if a chain is lost; after that the epoch can only be settled with the chain it has.
    uint256 public constant MAX_COMMIT_REARMS = 2;
    /// setRevealCommit refuses this many hashes above every anchor too: their preimages are public (audit 388b71cb,
    /// finding 5). A safeguard against operator error, not a proof that a chain is fresh.
    uint256 private constant HASHES_ABOVE_ANCHOR = 32;
    /// EIP-2935 block-hash history (Prague): hashes of the last 8,191 blocks; used once blockhash() has expired.
    address public constant BLOCK_HASH_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    struct PaidAuthorization {
        bytes32 orderId;
        address wallet;
        bytes32 lookKey;
        uint8 choice;
        bytes32 uriHash;
        address recipient;
        uint256 embeoCost;
        uint256 goldCost;
        uint256 deadline;
        uint256 signerEpoch;
    }
    struct RetiredChain { bytes32 last; uint256 opened; }
    bytes32 private constant PAID_AUTH_TYPEHASH = keccak256("PaidAuthorization(bytes32 orderId,address wallet,bytes32 lookKey,uint8 choice,bytes32 uriHash,address recipient,uint256 embeoCost,uint256 goldCost,uint256 deadline,uint256 signerEpoch)");
    /// `paid` binds an approval to one route: a paid approval cannot be used for mintFree and the other way round.
    bytes32 private constant APPEARANCE_TYPEHASH = keccak256("Appearance(address wallet,bytes32 lookKey,uint8 choice,bytes32 uriHash,uint256 deadline,uint256 signerEpoch,bool paid)");
    bytes32 private constant SIGNER_ACCEPTANCE_TYPEHASH = keccak256("SignerAcceptance(address signer,uint256 signerEpoch,uint256 proposalNonce,uint256 deadline)");
    /// The approval signer accepts a reveal commitment (the anchor of a hash chain it holds), so the owner cannot set or
    /// replace the chain without the current signer (a signer the owner installed itself is the trust case in the audit
    /// package, section 8.2).
    /// `previous` is the commitment being replaced (zero for the first): an acceptance covers exactly one replacement and
    /// cannot be kept and used later by the owner alone (pre-deployment review 2026-10-27).
    bytes32 private constant REVEAL_COMMIT_TYPEHASH = keccak256("RevealCommitAcceptance(bytes32 commit,bytes32 previous,uint256 signerEpoch,uint256 deadline)");
    bytes32 private constant PAID_TX_SLOT_PREFIX = keccak256("emberevo.genesis.paid-wallet-per-transaction.v1");
    bytes32 private constant REENTRANCY_SLOT = keccak256("emberevo.genesis.reentrancy.v1");
    // skinState layout: caps of skins 0..5 (16 bits each from bit 0), counts of skins 0..5 (from bit 96), totalMinted
    // (bit 192), freeMinted (bit 208). Every value is at most SUPPLY_CEILING.
    uint256 private constant COUNT_SHIFT = 96;
    uint256 private constant TOTAL_SHIFT = 192;
    uint256 private constant FREE_SHIFT = 208;

    IERC20 public immutable paymentToken;
    uint256 public immutable paidCost;
    uint256 public immutable paidGoldCost;
    uint256 public immutable startBlock;
    mapping(bytes32 => uint256) public paidOrderTokenId;
    mapping(bytes32 => bool) public paidOrderRevoked;
    // One slot holds everything a mint checks before the token itself (one cold read instead of five; gas review
    // 2026-10-27). signerEpoch fits 65,535 signer changes, freeStartAt any timestamp, eligibleWalletCount SUPPLY_CEILING.
    address public appearanceSigner;
    uint16 public signerEpoch = 1;
    bool public mintPaused = true;
    bool public paidPriceApproved;
    bool public snapshotConfigured;
    uint40 public freeStartAt;
    uint16 public eligibleWalletCount;
    address public pendingAppearanceSigner;
    /// Set by lockSupply only; minting fixes the supply as well (supplyFixed).
    bool public supplyLocked;
    bool public tokenURIsLocked;
    bool public revealURIsLocked;
    uint256 public signerProposalNonce;
    bytes32 public snapshotRoot;
    uint256 public snapshotAt;
    mapping(address => bool) public freeClaimed;

    // ---- supply, skins and tokens ----
    /// Caps, counts and mint totals in one slot (layout above): the sum of the caps is maxSupply, so every random token
    /// finds a skin.
    uint256 internal skinState;
    mapping(uint256 => bytes32) private lookKeyOf;
    /// 64 tokens per word, 4 bits each: bit 3 = random choice, bits 0-2 = skin + 1 (0 = not revealed yet).
    mapping(uint256 => uint256) private tokenBits;
    /// Random token ids of an epoch, 16 bits each: word 0 holds the count (bits 0-7) and ids 0..14 (from bit 8),
    /// word 1 ids 15..24.
    mapping(uint256 => uint256[2]) private epochTokens;
    /// Epochs that hold random tokens, in mint order (they are revealed strictly in this order): 32 bits each, 8 per word,
    /// so a new epoch writes a fresh word only every eighth time. An epoch number is below 2^32 for over 10^11 blocks.
    mapping(uint256 => uint256) private randomEpochWords;

    /// Reveal progress and re-arm in one slot, read by every mint. Bits 0-31: epochs revealed so far (the index of the
    /// next one in the list above); 32-63: epochs in the list (at most one per token). Re-arm (a replaced commitment, or
    /// an expired seed block), bits 64-127: the new seed block; 128-191: the first epoch it applies to (every unsealed
    /// epoch from there on takes it when it is later than its own); bit 192: that epoch's secret is already opened (it
    /// is revealCommit) because its seed block expired; bits 193-194: re-arms of that epoch by a new commitment. One slot
    /// instead of a loop over pending epochs (audit finding 7).
    uint256 private revealState;

    // ---- reveal commitment ----
    /// The approval signer commits before minting opens to a hash chain x0 = keccak(x1), x1 = keccak(x2), ...; the
    /// contract stores the last public value. Each epoch reveal consumes the next secret: keccak(secret) must equal
    /// revealCommit, then revealCommit = secret. The seed mixes that secret with the epoch's seed-block hash, so a block
    /// producer that does not know the secret cannot grind the outcome, and the secrets are fixed before the block exists.
    /// What the secret holder can still do (withhold, or build the seed block itself) is in the audit package, section 8.
    bytes32 public revealCommit;
    /// Secrets opened under the current chain; with the replaced chains (their last value and count) this tells
    /// setRevealCommit every value the contract has held (audit finding 6) without a storage write per reveal.
    uint256 public chainSecrets;
    RetiredChain[] private retiredChains;

    mapping(uint256 => string) private metadataURIs;   // owner overrides for chosen-skin tokens (setTokenURI); empty by default
    string public pendingURI;
    string public revealBaseURI;

    event SnapshotConfigured(bytes32 root, uint256 eligible, uint256 snapshotAt, uint256 commonStartAt);
    event PaidOrderConsumed(bytes32 indexed orderId, address indexed wallet, uint256 indexed tokenId, uint256 goldCost);
    event PaidOrderRevoked(bytes32 indexed orderId);
    event MintPauseChanged(bool paused);
    event PaidPriceApproved(uint256 cost);
    event AppearanceSignerProposed(address indexed proposed, uint256 nextEpoch, uint256 proposalNonce);
    event AppearanceSignerProposalCancelled(address indexed proposed, uint256 revokedProposalNonce);
    event AppearanceSignerChanged(address indexed previous, address indexed next, uint256 epoch);
    event MetadataUpdated(uint256 indexed tokenId, string uri);
    event RevealURIsSet(string pendingURI, string revealBaseURI, bool locked);
    /// skin is SKIN_COUNT (not a skin) for a random token: its skin is unknown at mint.
    event GenesisMinted(address indexed wallet, uint256 indexed tokenId, bytes32 indexed lookKey, uint8 choice, uint8 skin, bool paid, uint256 cost);
    /// seed = keccak256(abi.encode(blockHash, secret, epoch, contract)); blockHash is never zero.
    event EpochSealed(uint256 indexed epoch, bytes32 seed, uint256 seedBlock, bytes32 blockHash, bytes32 secret);
    /// `epoch` and every later unsealed epoch wait for newSeedBlock. expired: the seed block's hash was out of reach; the
    /// secret supplied for it is kept (revealCommit) and seals the epoch with newSeedBlock's hash, without anyone having
    /// to supply it again. Otherwise a new commitment was set.
    event EpochRearmed(uint256 indexed epoch, uint256 newSeedBlock, bool expired);
    event RevealCommitSet(bytes32 commit, uint256 newSeedBlock);
    event TokenURIsLocked();
    event SkinRevealed(uint256 indexed tokenId, uint8 skin, uint256 epoch);
    event SupplyConfigured(uint256 maxSupply, uint256[6] skinCaps);
    event SupplyLocked(uint256 maxSupply);

    /// Transient-storage guard on every state-changing entry point that can reach a token or receiver callback.
    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 entered;
        assembly ("memory-safe") { entered := tload(slot) }
        require(entered == 0, "REENTRANT_CALL");
        assembly ("memory-safe") { tstore(slot, 1) }
        _;
        assembly ("memory-safe") { tstore(slot, 0) }
    }

    constructor(address owner_, address token_, address signer_, uint256 cost_, uint256 goldCost_, string memory symbol_)
        ERC721("Ember Evo Genesis", symbol_) Ownable(owner_) EIP712("EmberEvoGenesisCandidate", "7")
    {
        // Rehearsal guard: remove only after the final review signs off a mainnet deployment.
        require(block.chainid != 1, "MAINNET_NOT_REVIEWED");
        require(token_.code.length != 0 && IERC20Metadata(token_).decimals() == 18, "TOKEN_IDENTITY_REQUIRED");
        require(signer_ != address(0) && signer_ != address(this), "INVALID_ROLE");
        require(cost_ != 0 && goldCost_ != 0 && bytes(symbol_).length != 0, "PARAMETERS_REQUIRED");
        paymentToken = IERC20(token_); appearanceSigner = signer_; paidCost = cost_; paidGoldCost = goldCost_;
        startBlock = block.number;
        // Skin caps at deployment (owner 2026-10-22): green 768, ice blue 168, nebula purple 168, sakura pink 68,
        // ember orange 68, molten gold 48; 1,288 in total (owner 2026-10-25; was 888 on 2026-10-22).
        _setSupply([uint256(768), 168, 168, 68, 68, 48]);
    }

    // ---- packed views ----
    function _field(uint256 s, uint256 shift) private pure returns (uint256) { return (s >> shift) & 0xFFFF; }
    function _maxOf(uint256 s) private pure returns (uint256 total) { for (uint256 i; i < SKIN_COUNT; ++i) total += _field(s, 16 * i); }
    function maxSupply() public view returns (uint256) { return _maxOf(skinState); }
    function totalMinted() public view returns (uint256) { return _field(skinState, TOTAL_SHIFT); }
    function freeMinted() external view returns (uint256) { return _field(skinState, FREE_SHIFT); }
    function skinCap(uint256 skin) public view returns (uint256) { require(skin < SKIN_COUNT, "SKIN_INVALID"); return _field(skinState, 16 * skin); }
    /// Skins fixed so far (direct picks + revealed randoms).
    function skinCount(uint256 skin) public view returns (uint256) { require(skin < SKIN_COUNT, "SKIN_INVALID"); return _field(skinState, COUNT_SHIFT + 16 * skin); }
    /// True once the supply can no longer change: locked by the owner, a token exists, or minting has opened.
    function supplyFixed() public view returns (bool) {
        return supplyLocked || totalMinted() != 0 || (snapshotConfigured && block.timestamp >= freeStartAt);
    }
    /// Resets the six skin caps (and so the total) before minting opens. Each skin keeps at least one, the total
    /// stays within SUPPLY_CEILING and never below the free-mint list.
    function configureSupply(uint256[6] calldata caps) external onlyOwner {
        require(!supplyFixed(), "SUPPLY_FIXED");
        _setSupply(caps);
        require(maxSupply() >= eligibleWalletCount, "SUPPLY_BELOW_SNAPSHOT");
    }
    /// Irreversible: fixes the current supply before minting opens (the first mint fixes it anyway).
    function lockSupply() external onlyOwner {
        require(!supplyLocked, "SUPPLY_LOCKED");
        supplyLocked = true; emit SupplyLocked(maxSupply());
    }
    /// Only before any mint (configureSupply checks supplyFixed), so the counts are zero.
    function _setSupply(uint256[6] memory caps) private {
        uint256 total;
        uint256 packed;
        for (uint256 i; i < SKIN_COUNT; ++i) { require(caps[i] != 0, "SKIN_CAP_ZERO"); total += caps[i]; packed |= caps[i] << (16 * i); }
        require(total <= SUPPLY_CEILING, "SUPPLY_CEILING");
        skinState = packed;
        emit SupplyConfigured(total, caps);
    }

    /// Snapshot root/count is sealed once. Dates are supplied only after the real snapshot has been verified.
    function configureSnapshot(bytes32 root, uint256 eligible, uint256 takenAt, uint256 start) external onlyOwner {
        require(!snapshotConfigured && totalMinted() == 0, "SNAPSHOT_ALREADY_FIXED");
        require(eligible <= maxSupply() && (eligible == 0 || root != bytes32(0)), "SNAPSHOT_CAPACITY");
        require(takenAt != 0 && takenAt <= block.timestamp && start >= block.timestamp && start >= takenAt && start <= type(uint40).max, "SNAPSHOT_TIME");
        // eligible <= maxSupply <= SUPPLY_CEILING fits uint16
        snapshotConfigured = true; snapshotRoot = root; eligibleWalletCount = uint16(eligible); snapshotAt = takenAt;
        freeStartAt = uint40(start);
        emit SnapshotConfigured(root, eligible, takenAt, start);
    }
    function setMintPaused(bool paused) external onlyOwner nonReentrant {
        require(paused || pendingAppearanceSigner == address(0), "SIGNER_PROPOSAL_PENDING");
        // review 2026-10-27: minting cannot open without what every reveal needs, or the first random epoch would stall
        require(paused || (snapshotConfigured && revealURIsLocked && revealCommit != bytes32(0)), "OPEN_NOT_READY");
        mintPaused = paused; emit MintPauseChanged(paused);
    }
    /// Sets the reveal commitment (the public end of the signer's secret chain). Only while paused, with the approval
    /// signer's acceptance, and never a value the contract held before or one of the first hashes above it (their
    /// preimages are public). If the next epoch to reveal has closed (its own seed block is reached), replacing the chain
    /// re-arms it, and every later epoch, to the next block, so the new secrets were fixed before that block's hash
    /// existed. That is allowed only REARM_COOLDOWN blocks after its current seed block (a pending re-arm counts: audit
    /// 388b71cb, finding 2), so anyone holding a published secret can settle first, and at most MAX_COMMIT_REARMS times
    /// per epoch, counting the re-arms a waiting epoch shared with the one before it (see _commitRearms).
    function setRevealCommit(bytes32 commit, uint256 deadline, bytes calldata acceptance) external onlyOwner nonReentrant {
        require(mintPaused, "PAUSE_REQUIRED");
        require(commit != bytes32(0) && !_heldBefore(commit), "REVEAL_COMMIT_INVALID");
        require(block.timestamp <= deadline, "REVEAL_ACCEPTANCE_EXPIRED");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVEAL_COMMIT_TYPEHASH, commit, revealCommit, signerEpoch, deadline)));
        require(SignatureChecker.isValidSignatureNow(appearanceSigner, digest, acceptance), "REVEAL_ACCEPTANCE_INVALID");
        if (revealCommit != bytes32(0)) retiredChains.push(RetiredChain(revealCommit, chainSecrets));
        revealCommit = commit; chainSecrets = 0;
        uint256 newSeedBlock;
        uint256 i = nextRevealIndex();
        if (i < randomEpochCount()) {
            uint256 e = _epochAt(i);
            if (_naturalSeedBlock(e) <= block.number) {
                require(block.number > epochSeedBlock(e) + REARM_COOLDOWN, "EPOCH_REARM_COOLDOWN");
                uint256 n = _commitRearms(e);
                require(n < MAX_COMMIT_REARMS, "EPOCH_REARM_LIMIT");
                newSeedBlock = _rearm(e, false, n + 1);
            }
        }
        emit RevealCommitSet(commit, newSeedBlock);
    }
    /// Whether `c` was held by the contract or is one of the first hashes above such a value (then its preimage is
    /// public): a chain's values are its last one and the hashes below it (x[i-1] = keccak(x[i])), one per secret opened
    /// plus the anchor, then HASHES_ABOVE_ANCHOR more. Only setRevealCommit pays for this walk.
    function _heldBefore(bytes32 c) private view returns (bool) {
        if (_onChain(c, revealCommit, chainSecrets)) return true;
        for (uint256 k; k < retiredChains.length; ++k) if (_onChain(c, retiredChains[k].last, retiredChains[k].opened)) return true;
        return false;
    }
    function _onChain(bytes32 c, bytes32 v, uint256 opened) private pure returns (bool) {
        if (v == bytes32(0)) return false;
        for (uint256 i; i <= opened + HASHES_ABOVE_ANCHOR; ++i) { if (v == c) return true; v = _hash(v); }
        return false;
    }
    /// keccak256(abi.encode(v)) without allocating memory.
    function _hash(bytes32 v) private pure returns (bytes32 h) {
        assembly ("memory-safe") { mstore(0, v) h := keccak256(0, 32) }
    }
    /// `commitRearms` is carried over by an expiry re-arm of the same epoch, so it never resets while the epoch waits.
    function _rearm(uint256 e, bool expired, uint256 count) private returns (uint256 seedBlock) {
        seedBlock = block.number + 1;
        revealState = uint64(revealState) | (seedBlock << 64) | (e << 128) | (expired ? uint256(1) << 192 : 0) | (count << 193);
        emit EpochRearmed(e, seedBlock, expired);
    }
    /// Commitment re-arms that moved epoch e's seed block: those of the last re-armed epoch, if e is that epoch or a later
    /// one that had already closed then (it was drawn again with it). So an epoch waiting behind others inherits their
    /// count instead of starting from zero once they are revealed (pre-deployment review 2026-10-27).
    function _commitRearms(uint256 e) private view returns (uint256) {
        uint256 rs = revealState;
        return (e >= uint64(rs >> 128) && uint64(rs >> 64) > _naturalSeedBlock(e)) ? (rs >> 193) & 3 : 0;
    }
    /// Whether epoch e's secret is already opened (its seed block expired): settling it then needs no secret.
    function epochSecretOpened(uint256 e) public view returns (bool) { uint256 rs = revealState; return (rs >> 192) & 1 == 1 && uint64(rs >> 128) == e; }
    /// Administrative controls are retained; ownership may still be transferred in two steps.
    function renounceOwnership() public view override onlyOwner { revert("OWNERSHIP_RENOUNCE_DISABLED"); }
    function proposeAppearanceSigner(address next) external onlyOwner nonReentrant {
        require(mintPaused, "PAUSE_REQUIRED");
        require(next != address(0) && next != address(this) && next != appearanceSigner, "INVALID_SIGNER");
        require(pendingAppearanceSigner == address(0), "SIGNER_PROPOSAL_PENDING");
        pendingAppearanceSigner = next;
        ++signerProposalNonce;
        emit AppearanceSignerProposed(next, signerEpoch + 1, signerProposalNonce);
    }
    /// New authority accepts this exact proposal. Cancelling invalidates its nonce permanently.
    function activateAppearanceSigner(uint256 deadline, bytes calldata acceptance) external onlyOwner nonReentrant {
        require(mintPaused && pendingAppearanceSigner != address(0), "SIGNER_PROPOSAL_REQUIRED");
        require(block.timestamp <= deadline, "SIGNER_ACCEPTANCE_EXPIRED");
        address next = pendingAppearanceSigner;
        uint16 epoch = signerEpoch + 1;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SIGNER_ACCEPTANCE_TYPEHASH, next, epoch, signerProposalNonce, deadline)));
        require(SignatureChecker.isValidSignatureNow(next, digest, acceptance), "SIGNER_ACCEPTANCE_INVALID");
        address previous = appearanceSigner;
        appearanceSigner = next; signerEpoch = epoch; pendingAppearanceSigner = address(0);
        emit AppearanceSignerChanged(previous, next, epoch);
    }
    function cancelAppearanceSignerProposal() external onlyOwner nonReentrant {
        address proposed = pendingAppearanceSigner;
        require(proposed != address(0), "SIGNER_PROPOSAL_REQUIRED");
        uint256 revokedNonce = signerProposalNonce;
        pendingAppearanceSigner = address(0);
        ++signerProposalNonce;
        emit AppearanceSignerProposalCancelled(proposed, revokedNonce);
    }
    /// Opens the paid route at the deploy-time price (paidCost / paidGoldCost are immutable). Cannot be undone.
    function approvePaidPrice() external onlyOwner { paidPriceApproved = true; emit PaidPriceApproved(paidCost); }
    /// Override for a chosen-skin token (by default its URI is derived, see tokenURI); a random token's URI follows the
    /// pending / reveal URIs below.
    function setTokenURI(uint256 id, string calldata uri) external onlyOwner {
        require(!tokenURIsLocked, "TOKEN_URIS_LOCKED");
        _requireOwned(id); require(_bits(id) & 8 == 0, "RANDOM_URI_IS_DERIVED");
        require(bytes(uri).length != 0, "METADATA_REQUIRED");
        metadataURIs[id] = uri; emit MetadataUpdated(id, uri); emit MetadataUpdate(id);
    }
    /// Irreversible: chosen-skin token URIs can never be changed again.
    function lockTokenURIs() external onlyOwner { tokenURIsLocked = true; emit TokenURIsLocked(); }
    /// Pending (mystery) URI and reveal base URI for random tokens; can be locked once and never changed again.
    function setRevealURIs(string calldata pending, string calldata base, bool lock) external onlyOwner {
        require(!revealURIsLocked, "REVEAL_URIS_LOCKED");
        require(bytes(pending).length != 0 && bytes(base).length != 0, "METADATA_REQUIRED");
        pendingURI = pending; revealBaseURI = base; revealURIsLocked = lock;
        emit RevealURIsSet(pending, base, lock);
        uint256 minted = totalMinted();
        if (minted != 0) emit BatchMetadataUpdate(1, minted);
    }
    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == bytes4(0x49064906) || super.supportsInterface(id);
    }
    /// The 4 bits of token id (see tokenBits).
    function _bits(uint256 id) private view returns (uint256) { return (tokenBits[id >> 6] >> ((id & 63) << 2)) & 0xF; }
    /// Chosen and revealed random tokens share one layout: revealBaseURI + lookKey hex + "/" + skin index. A chosen-skin
    /// token answers with its owner override if one was set. Before the reveal URIs are set there is nothing to derive.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        uint256 b = _bits(id);
        if (b & 8 == 0) {
            string memory overrideURI = metadataURIs[id];
            if (bytes(overrideURI).length != 0) return overrideURI;
        }
        uint256 skin = b & 7;
        if (skin == 0 || bytes(revealBaseURI).length == 0) return pendingURI;
        return string.concat(revealBaseURI, Strings.toHexString(uint256(lookKeyOf[id]), 32), "/", Strings.toString(skin - 1));
    }
    /// A token's look key, mint choice (3 = random) and skin + 1 (0 while a random skin is not revealed).
    function tokenLook(uint256 id) external view returns (bytes32 lookKey, uint8 choice, uint8 skin) {
        uint256 b = _bits(id);
        skin = uint8(b & 7);
        choice = b & 8 != 0 ? CHOICE_RANDOM : (skin == 0 ? 0 : skin - 1);
        lookKey = lookKeyOf[id];
    }
    function paidAvailability() public view returns (uint256) {
        if (!snapshotConfigured || block.timestamp < freeStartAt) return 0;
        uint256 s = skinState;
        return _maxOf(s) - _field(s, TOTAL_SHIFT);
    }
    /// Revealed skin of a token: (skin index, true) or (0, false) while a random skin is still pending.
    function skinOf(uint256 id) external view returns (uint8 skin, bool revealed) {
        _requireOwned(id); uint256 s = _bits(id) & 7; return s == 0 ? (0, false) : (uint8(s - 1), true);
    }
    function currentEpoch() public view returns (uint256) { return (block.number - startBlock) / EPOCH_BLOCKS; }
    /// The block whose hash seeds epoch `e`: the first block after the epoch ends, or the re-arm block if that is later
    /// (for an epoch at or after the re-arm's first epoch). Meaningful for unsealed epochs; a sealed one's is in EpochSealed.
    function epochSeedBlock(uint256 e) public view returns (uint256) {
        uint256 natural = _naturalSeedBlock(e);
        uint256 rs = revealState;
        uint256 r = uint64(rs >> 64);
        return (r > natural && e >= uint64(rs >> 128)) ? r : natural;
    }
    /// The first block after epoch e ends: the epoch has closed once it is reached. Never later than epochSeedBlock(e).
    function _naturalSeedBlock(uint256 e) private view returns (uint256) { return startBlock + (e + 1) * EPOCH_BLOCKS; }
    /// The epoch that must be revealed next, and whether it can be sealed now (its seed block is mined). Chosen-skin
    /// mints are frozen from the epoch's own seed block until it is revealed, whatever the re-arm (see _approval).
    function nextRevealEpoch() public view returns (bool exists, uint256 epoch, bool seedKnown) {
        uint256 i = nextRevealIndex();
        if (i >= randomEpochCount()) return (false, 0, false);
        epoch = _epochAt(i);
        return (true, epoch, block.number > epochSeedBlock(epoch));
    }
    /// Epochs that hold random tokens, in reveal order (the signer reads these to know which secrets a reveal needs).
    function randomEpochCount() public view returns (uint256) { return uint32(revealState >> 32); }
    /// Epochs revealed so far: the list index of the epoch to reveal next.
    function nextRevealIndex() public view returns (uint256) { return uint32(revealState); }
    function randomEpochAt(uint256 i) external view returns (uint256) { require(i < randomEpochCount(), "INDEX_OUT_OF_RANGE"); return _epochAt(i); }
    function _epochAt(uint256 i) private view returns (uint256) { return uint32(randomEpochWords[i >> 3] >> ((i & 7) << 5)); }
    function epochRandomCount(uint256 e) public view returns (uint256) { return epochTokens[e][0] & 0xFF; }
    function epochRandomToken(uint256 e, uint256 i) external view returns (uint256) {
        require(i < epochRandomCount(e), "INDEX_OUT_OF_RANGE");
        return i < 15 ? (epochTokens[e][0] >> (8 + 16 * i)) & 0xFFFF : (epochTokens[e][1] >> (16 * (i - 15))) & 0xFFFF;
    }
    /// Random tokens minted but not revealed yet.
    function pendingRandom() external view returns (uint256 n) {
        for (uint256 i = nextRevealIndex(); i < randomEpochCount(); ++i) n += epochRandomCount(_epochAt(i));
    }

    function _approval(bytes32 lookKey, uint8 choice, string calldata uri, uint256 deadline, bytes calldata signature, bool paid) private view {
        require(!mintPaused && snapshotConfigured, "MINT_NOT_READY");
        // Looks may repeat (R6): any number of tokens can share a look, in any skin.
        require(lookKey != bytes32(0) && choice <= CHOICE_RANDOM, "APPEARANCE_INVALID");
        if (choice == CHOICE_RANDOM) {
            // a random token's skin is unknown until the epoch reveal. It does not change the skin counts a reveal draws
            // from, so it may be minted while an earlier epoch waits for its reveal (review 2026-10-27).
            require(bytes(uri).length == 0, "RANDOM_URI_NOT_ALLOWED");
            require(epochRandomCount(currentEpoch()) < MAX_RANDOM_PER_EPOCH, "EPOCH_RANDOM_FULL");
        } else {
            // From the epoch's own seed block on (including transactions in that block: audit finding 4), no chosen skin
            // may change the skin counts until that epoch is revealed (the mint's own `reveals` normally settle it just
            // before). A re-arm never lifts this (audit 388b71cb, finding 3).
            uint256 i = nextRevealIndex();
            if (i < randomEpochCount()) require(block.number < _naturalSeedBlock(_epochAt(i)), "REVEAL_PENDING");
            require(bytes(uri).length != 0, "METADATA_REQUIRED");
            uint256 s = skinState;
            require(_field(s, COUNT_SHIFT + 16 * choice) < _field(s, 16 * choice), "SKIN_SOLD_OUT");
        }
        require(block.timestamp <= deadline, "APPEARANCE_EXPIRED");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(APPEARANCE_TYPEHASH, msg.sender, lookKey, choice, keccak256(bytes(uri)), deadline, signerEpoch, paid)));
        require(SignatureChecker.isValidSignatureNow(appearanceSigner, digest, signature), "APPEARANCE_AUTHORITY");
    }
    /// One slot write for the supply state, the look key, and a shared word for the token's 4 bits (plus, for a random
    /// token, the packed epoch list).
    function _mintOne(bytes32 lookKey, uint8 choice, bool paid, uint256 cost) private returns (uint256 id) {
        uint256 s = skinState;
        id = _field(s, TOTAL_SHIFT) + 1;
        require(id <= _maxOf(s), "SOLD_OUT");
        s += (uint256(1) << TOTAL_SHIFT) + (paid ? 0 : uint256(1) << FREE_SHIFT);
        uint256 b;
        uint8 skin;
        if (choice == CHOICE_RANDOM) {
            uint256 epoch = currentEpoch();
            uint256 w0 = epochTokens[epoch][0];
            uint256 n = w0 & 0xFF;                       // < MAX_RANDOM_PER_EPOCH (checked in _approval)
            if (n == 0) {
                uint256 k = randomEpochCount();
                randomEpochWords[k >> 3] |= uint256(uint32(epoch)) << ((k & 7) << 5);
                revealState += uint256(1) << 32;                 // at most one epoch per token: <= SUPPLY_CEILING
            }
            if (n < 15) epochTokens[epoch][0] = w0 + 1 + (id << (8 + 16 * n));
            else { epochTokens[epoch][1] |= id << (16 * (n - 15)); epochTokens[epoch][0] = w0 + 1; }
            b = 8;
            skin = SKIN_COUNT;
        } else {
            s += uint256(1) << (COUNT_SHIFT + 16 * uint256(choice));   // below its cap (checked in _approval)
            b = uint256(choice) + 1;                     // its URI is derived in tokenURI
            skin = choice;
        }
        skinState = s;
        lookKeyOf[id] = lookKey;
        tokenBits[id >> 6] |= b << ((id & 63) << 2);
        _safeMint(msg.sender, id); emit GenesisMinted(msg.sender, id, lookKey, choice, skin, paid, cost);
    }
    function mintFree(bytes32 lookKey, uint8 choice, string calldata uri, uint256 deadline, bytes calldata signature, bytes32[] calldata proof, bytes32[] calldata reveals) external nonReentrant {
        _settleReady(reveals);
        _approval(lookKey, choice, uri, deadline, signature, false);
        require(block.timestamp >= freeStartAt, "SALE_NOT_STARTED");
        require(!freeClaimed[msg.sender] && _field(skinState, FREE_SHIFT) < eligibleWalletCount, "FREE_ALREADY_CLAIMED");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        require(MerkleProof.verifyCalldata(proof, snapshotRoot, leaf), "NOT_IN_SNAPSHOT");
        freeClaimed[msg.sender] = true; _mintOne(lookKey, choice, false, 0);
    }
    /// A successful paid mint consumes this caller's marker for the rest of this transaction.
    /// Do not clear the transient slot on return: sequential smart-wallet calls must also be limited.
    function _claimPaidTransaction() private {
        bytes32 slot = keccak256(abi.encode(PAID_TX_SLOT_PREFIX, msg.sender));
        uint256 used;
        assembly ("memory-safe") { used := tload(slot) }
        require(used == 0, "ONE_PAID_MINT_PER_TRANSACTION");
        assembly ("memory-safe") { tstore(slot, 1) }
    }
    /// One paid token per caller per transaction; future transactions have no per-wallet total limit.
    function mintPaid(bytes32 lookKey, uint8 choice, string calldata uri, uint256 deadline, bytes calldata signature, address expectedRecipient, uint256 expectedCost, PaidAuthorization calldata order, bytes calldata goldSignature, bytes32[] calldata reveals) external nonReentrant {
        _settleReady(reveals);
        _approval(lookKey, choice, uri, deadline, signature, true);
        require(block.timestamp >= freeStartAt, "SALE_NOT_STARTED");
        require(paidPriceApproved && paidAvailability() != 0, "PAID_NOT_AVAILABLE");
        address signer = appearanceSigner;
        uint256 epoch = signerEpoch;
        require(expectedRecipient == BURN_ADDRESS && expectedCost == paidCost, "PAYMENT_CONTEXT_CHANGED");
        require(order.orderId != bytes32(0) && paidOrderTokenId[order.orderId] == 0 && !paidOrderRevoked[order.orderId], "PAID_ORDER_UNAVAILABLE");
        require(order.wallet == msg.sender && order.lookKey == lookKey && order.choice == choice && order.uriHash == keccak256(bytes(uri)) && order.recipient == BURN_ADDRESS && order.embeoCost == paidCost && order.goldCost == paidGoldCost && order.signerEpoch == epoch, "GOLD_AUTH_CONTEXT");
        require(block.timestamp <= order.deadline, "GOLD_AUTH_EXPIRED");
        bytes32 goldDigest = _hashTypedDataV4(keccak256(abi.encode(PAID_AUTH_TYPEHASH, order)));
        require(SignatureChecker.isValidSignatureNow(signer, goldDigest, goldSignature), "GOLD_RESERVATION_AUTHORITY");
        _claimPaidTransaction();
        // Off-chain GOLD was reserved before this authorization was signed.
        // This receipt and the NFT/payment revert together; it is not an on-chain GOLD token.
        paidOrderTokenId[order.orderId] = totalMinted() + 1;
        uint256 payerBefore = paymentToken.balanceOf(msg.sender);
        uint256 burnBefore = paymentToken.balanceOf(BURN_ADDRESS);
        uint256 supplyBefore = paymentToken.totalSupply();
        // nonReentrant guards both mint paths while the external token call is in progress.
        require(payerBefore >= paidCost, "BALANCE_REQUIRED");
        paymentToken.safeTransferFrom(msg.sender, BURN_ADDRESS, paidCost);
        require(paymentToken.balanceOf(msg.sender) == payerBefore - paidCost && paymentToken.balanceOf(BURN_ADDRESS) == burnBefore + paidCost, "EXACT_PAYMENT_REQUIRED");
        require(paymentToken.totalSupply() == supplyBefore, "TOKEN_SUPPLY_CHANGED");
        uint256 id = _mintOne(lookKey, choice, true, paidCost);
        emit PaidOrderConsumed(order.orderId, msg.sender, id, paidGoldCost);
        require(appearanceSigner == signer && signerEpoch == epoch && !mintPaused, "MINT_CONTEXT_CHANGED");
    }
    /// Prevent a still-valid authorization from spending a reservation after cancellation.
    /// GOLD release requires an authoritative consumed/revoked/expired read, not a UI timeout.
    function revokePaidOrder(bytes32 orderId) external onlyOwner nonReentrant {
        require(orderId != bytes32(0) && paidOrderTokenId[orderId] == 0, "PAID_ORDER_ALREADY_CONSUMED");
        paidOrderRevoked[orderId] = true;
        emit PaidOrderRevoked(orderId);
    }

    // ---- reveal: no minter can choose a token's skin; for what the secret holder and the owner can do, see the audit
    //      package, section 8.2 ----
    /// Any mint first settles every epoch that is ready (its seed block is mined), using the committed secrets it carries
    /// (`reveals`; the signer hands them out once each seed block is confirmed): seals the epoch and reveals all of its
    /// random tokens in token order, in the same call, before the mint changes any skin count. A chosen-skin mint that
    /// leaves a ready epoch unrevealed stops with REVEAL_PENDING (a random mint goes ahead: it changes no skin count).
    /// There is no fixed limit on epochs per call: the caller bounds the work by the secrets it passes (audit finding 3).
    /// For each epoch the whole list is searched, so order does not matter (finding 14); secrets that do not open the
    /// current commitment (already used by a concurrent transaction, or extra) are ignored. An epoch whose seed block
    /// expired already holds its (now public) secret and needs none. The seed is never stored: EpochSealed records it for
    /// anyone to check the draws.
    function _settleReady(bytes32[] calldata reveals) private returns (bool progressed) {
        for (uint256 i = nextRevealIndex(); i < randomEpochCount(); ++i) {   // _reveal moves nextRevealIndex on with i
            uint256 e = _epochAt(i);
            uint256 seedBlock = epochSeedBlock(e);
            if (block.number <= seedBlock) return progressed;
            bytes32 secret = revealCommit;
            if (!epochSecretOpened(e)) {
                uint256 j;
                while (j < reveals.length && _hash(reveals[j]) != secret) ++j;
                if (j == reveals.length) return progressed;       // its secret was not supplied
                secret = reveals[j];
                revealCommit = secret; ++chainSecrets;
            }
            progressed = true;
            bytes32 h = _blockHash(seedBlock);
            // Out of reach (older than the EIP-2935 window, or 256 blocks where there is none): re-armed to the next block
            // with the same secret, which is public from now on, so withholding it can never be repeated for this epoch
            // and no secret alone ever decides (audit 388b71cb, findings 1 and 2).
            if (h == bytes32(0)) { _rearm(e, true, _commitRearms(e)); return progressed; }
            bytes32 seed = keccak256(abi.encode(h, secret, e, address(this)));
            emit EpochSealed(e, seed, seedBlock, h, secret);
            _reveal(e, seed);
        }
    }
    /// The manual reveal button: seals and reveals every ready epoch with the given secrets (the signer publishes them
    /// once each epoch's seed block is confirmed). Works while minting is paused too.
    function settle(bytes32[] calldata reveals) external nonReentrant {
        require(_settleReady(reveals), "NOTHING_TO_SETTLE");
    }
    /// Hash of block n: blockhash() for the last 256 blocks, then the EIP-2935 history contract (8,191 blocks), else zero.
    function _blockHash(uint256 n) private view returns (bytes32 h) {
        h = blockhash(n);
        if (h != bytes32(0) || n >= block.number) return h;
        (bool ok, bytes memory r) = BLOCK_HASH_HISTORY.staticcall(abi.encode(n));
        if (ok && r.length == 32) h = abi.decode(r, (bytes32));
    }
    /// Reveals every random token of epoch e (at most 25) in token order, then moves on to the next epoch. The skin counts
    /// are read and written once (one slot); each token draws from what is left after the tokens before it.
    function _reveal(uint256 e, bytes32 seed) private {
        uint256 w0 = epochTokens[e][0];
        uint256 w1 = epochTokens[e][1];
        uint256 n = w0 & 0xFF;
        uint256 s = skinState;
        uint256[6] memory remaining;
        uint256 total;
        for (uint256 c; c < SKIN_COUNT; ++c) { remaining[c] = _field(s, 16 * c) - _field(s, COUNT_SHIFT + 16 * c); total += remaining[c]; }
        uint256 first;
        uint256 id;
        for (uint256 i; i < n; ++i) {
            id = i < 15 ? (w0 >> (8 + 16 * i)) & 0xFFFF : (w1 >> (16 * (i - 15))) & 0xFFFF;
            if (i == 0) first = id;
            require(total != 0, "NO_SKIN_LEFT"); // unreachable: sum of caps equals maxSupply
            uint256 r = uint256(keccak256(abi.encode(seed, id))) % total;
            uint256 skin;
            for (; skin < SKIN_COUNT; ++skin) { if (r < remaining[skin]) break; r -= remaining[skin]; }
            --remaining[skin]; --total;
            s += uint256(1) << (COUNT_SHIFT + 16 * skin);
            tokenBits[id >> 6] |= (skin + 1) << ((id & 63) << 2);   // its bits were 8 (random, not revealed)
            emit SkinRevealed(id, uint8(skin), e);
        }
        skinState = s;
        ++revealState;                         // nextRevealIndex (bits 0-31) + 1; it never reaches the epoch count bits
        emit BatchMetadataUpdate(first, id);   // the epoch's ids ascend; tokens in between that did not change re-read the same
    }
}
