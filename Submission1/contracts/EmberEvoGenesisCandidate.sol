// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
///      Owner 2026-10-27 (gas): a chosen-skin token no longer stores its metadata URI at mint. Its URI is derived like a
///      revealed random token's (revealBaseURI + lookKey hex + "/" + skin), saving three or four storage slots per mint.
///      The signed `uri` is still checked at mint, so the approval format is unchanged; setTokenURI remains an owner
///      override until lockTokenURIs.
///      Pre-audit review 2026-10-27 (owner's choice): random seeds mix the epoch's seed-block hash with the next secret
///      of a hash chain the approval signer commits to before minting opens (setRevealCommit); every mint carries the
///      secrets its reveal needs (`reveals`); expired block hashes come from EIP-2935, else the secret alone decides (no
///      re-arm on expiry). Minting cannot open before the snapshot, the locked reveal URIs and the commitment are set.
contract EmberEvoGenesisCandidate is ERC721, IERC4906, Ownable2Step, ReentrancyGuard, EIP712 {
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
    /// skin: 0 = not revealed yet (random only); otherwise skin index + 1.
    struct TokenLook {
        bytes32 lookKey;
        uint8 choice;
        uint8 skin;
        uint64 epoch;
    }
    bytes32 private constant PAID_AUTH_TYPEHASH = keccak256("PaidAuthorization(bytes32 orderId,address wallet,bytes32 lookKey,uint8 choice,bytes32 uriHash,address recipient,uint256 embeoCost,uint256 goldCost,uint256 deadline,uint256 signerEpoch)");
    bytes32 private constant APPEARANCE_TYPEHASH = keccak256("Appearance(address wallet,bytes32 lookKey,uint8 choice,bytes32 uriHash,uint256 deadline,uint256 signerEpoch)");
    bytes32 private constant SIGNER_ACCEPTANCE_TYPEHASH = keccak256("SignerAcceptance(address signer,uint256 signerEpoch,uint256 proposalNonce,uint256 deadline)");
    bytes32 private constant PAID_TX_SLOT_PREFIX = keccak256("emberevo.genesis.paid-wallet-per-transaction.v1");
    IERC20 public immutable paymentToken;
    uint256 public immutable paidCost;
    uint256 public immutable paidGoldCost;
    uint256 public immutable startBlock;
    mapping(bytes32 => uint256) public paidOrderTokenId;
    mapping(bytes32 => bool) public paidOrderRevoked;
    address public appearanceSigner;
    address public pendingAppearanceSigner;
    uint256 public signerEpoch = 1;
    uint256 public signerProposalNonce;
    bool public mintPaused = true;
    bool public paidPriceApproved;
    bool public snapshotConfigured;
    bytes32 public snapshotRoot;
    uint256 public eligibleWalletCount;
    uint256 public snapshotAt;
    uint256 public freeStartAt;
    uint256 public totalMinted;
    uint256 public freeMinted;
    uint256 public paidMinted;
    mapping(address => bool) public freeClaimed;

    // ---- supply: set at deployment, changeable by the owner until minting opens, then fixed ----
    uint256 public maxSupply;
    uint256[6] private skinCaps;                       // sum is always maxSupply, so every random finds a skin
    bool public supplyLocked;

    // ---- look and skin state ----
    uint256[6] public skinCount;                       // skins fixed so far (direct picks + revealed randoms)
    uint256 public pendingRandom;                      // random tokens minted but not revealed yet
    mapping(uint256 => TokenLook) public tokenLook;
    mapping(uint256 => uint256[]) private epochRandomTokens;
    mapping(uint256 => uint256) public epochCursor;
    mapping(uint256 => bytes32) public epochSeed;
    /// Epochs that hold random tokens, in mint order; they are revealed strictly in this order.
    uint256[] private randomEpochs;
    uint256 public nextRevealIndex;
    /// Replacement seed block for the next epoch to reveal when the owner replaces the reveal commitment (setRevealCommit),
    /// so the new secrets cannot be chosen against a block hash that is already known.
    mapping(uint256 => uint256) public epochRearmBlock;
    // ---- reveal commitment (owner 2026-10-27; replaces the block-hash-only seed after the pre-audit review) ----
    /// The approval signer commits before minting opens to a hash chain x0 = keccak(x1), x1 = keccak(x2), ...; the
    /// contract stores the last public value. Each epoch reveal consumes the next secret: keccak(secret) must equal
    /// revealCommit, then revealCommit = secret. The seed mixes that secret with the epoch's seed-block hash, so a block
    /// producer cannot grind the outcome (the secret is unknown to it) and the signer cannot pick it (the secrets are
    /// fixed before the block exists).
    bytes32 public revealCommit;
    uint256 public revealedSecrets;
    /// EIP-2935 block-hash history (Prague): hashes of the last 8,191 blocks; used once blockhash() has expired.
    address public constant BLOCK_HASH_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    bool public tokenURIsLocked;
    mapping(uint256 => string) private metadataURIs;   // owner overrides for chosen-skin tokens (setTokenURI); empty by default
    string public pendingURI;
    string public revealBaseURI;
    bool public revealURIsLocked;

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
    /// blockHash is zero when the seed block is older than the EIP-2935 window: the committed secret alone decides then.
    event EpochSealed(uint256 indexed epoch, bytes32 seed, uint256 seedBlock, bytes32 blockHash, bytes32 secret);
    event EpochRearmed(uint256 indexed epoch, uint256 newSeedBlock);
    event RevealCommitSet(bytes32 commit, uint256 rearmedEpochs, uint256 newSeedBlock);
    event TokenURIsLocked();
    event SkinRevealed(uint256 indexed tokenId, uint8 skin, uint256 indexed epoch);
    event SupplyConfigured(uint256 maxSupply, uint256[6] skinCaps);
    event SupplyLocked(uint256 maxSupply);

    constructor(address owner_, address token_, address signer_, uint256 cost_, uint256 goldCost_, string memory symbol_)
        ERC721("Ember Evo Genesis", symbol_) Ownable(owner_) EIP712("EmberEvoGenesisCandidate", "6")
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

    function skinCap(uint256 skin) public view returns (uint256) {
        require(skin < SKIN_COUNT, "SKIN_INVALID");
        return skinCaps[skin];
    }
    /// Kept for tooling compatibility (R5 had a constant of this name).
    function MAX_SUPPLY() external view returns (uint256) { return maxSupply; }
    /// True once the supply can no longer change: locked by the owner or by the first mint, or minting has opened.
    function supplyFixed() public view returns (bool) {
        return supplyLocked || totalMinted != 0 || (snapshotConfigured && block.timestamp >= freeStartAt);
    }
    /// Resets the six skin caps (and so the total) before minting opens. Each skin keeps at least one, the total
    /// stays within SUPPLY_CEILING and never below the free-mint list.
    function configureSupply(uint256[6] calldata caps) external onlyOwner {
        require(!supplyFixed(), "SUPPLY_FIXED");
        _setSupply(caps);
        require(maxSupply >= eligibleWalletCount, "SUPPLY_BELOW_SNAPSHOT");
    }
    /// Irreversible: fixes the current supply before minting opens (the first mint fixes it anyway).
    function lockSupply() external onlyOwner {
        require(!supplyLocked, "SUPPLY_LOCKED");
        supplyLocked = true; emit SupplyLocked(maxSupply);
    }
    function _setSupply(uint256[6] memory caps) private {
        uint256 total;
        for (uint256 i; i < SKIN_COUNT; ++i) { require(caps[i] != 0, "SKIN_CAP_ZERO"); total += caps[i]; }
        require(total <= SUPPLY_CEILING, "SUPPLY_CEILING");
        skinCaps = caps; maxSupply = total;
        emit SupplyConfigured(total, caps);
    }
    /// Kept for tooling compatibility: the fixed burn address.
    function paymentRecipient() public pure returns (address) { return BURN_ADDRESS; }

    /// Snapshot root/count is sealed once. Dates are supplied only after the real snapshot has been verified.
    function configureSnapshot(bytes32 root, uint256 eligible, uint256 takenAt, uint256 start) external onlyOwner {
        require(!snapshotConfigured && totalMinted == 0, "SNAPSHOT_ALREADY_FIXED");
        require(eligible <= maxSupply && (eligible == 0 || root != bytes32(0)), "SNAPSHOT_CAPACITY");
        require(takenAt != 0 && takenAt <= block.timestamp && start >= block.timestamp && start >= takenAt, "SNAPSHOT_TIME");
        snapshotConfigured = true; snapshotRoot = root; eligibleWalletCount = eligible; snapshotAt = takenAt;
        freeStartAt = start;
        emit SnapshotConfigured(root, eligible, takenAt, start);
    }
    function setMintPaused(bool paused) external onlyOwner nonReentrant {
        require(paused || pendingAppearanceSigner == address(0), "SIGNER_PROPOSAL_PENDING");
        // review 2026-10-27: minting cannot open without what every reveal needs, or the first random epoch would stall
        require(paused || (snapshotConfigured && revealURIsLocked && revealCommit != bytes32(0)), "OPEN_NOT_READY");
        mintPaused = paused; emit MintPauseChanged(paused);
    }
    /// Sets the reveal commitment (the public end of the signer's secret chain). Only while paused. Replacing it later
    /// (a lost chain) re-arms the next epoch to reveal to a future block, so the new secrets were fixed before that
    /// block's hash existed.
    function setRevealCommit(bytes32 commit) external onlyOwner nonReentrant {
        require(mintPaused, "PAUSE_REQUIRED");
        require(commit != bytes32(0) && commit != revealCommit, "REVEAL_COMMIT_INVALID");
        revealCommit = commit;
        // every unsealed epoch whose seed block is already mined moves to the next block
        uint256 rearmed;
        for (uint256 i = nextRevealIndex; i < randomEpochs.length; ++i) {
            uint256 e = randomEpochs[i];
            if (epochSeed[e] != bytes32(0)) continue;
            if (epochSeedBlock(e) > block.number) break;
            epochRearmBlock[e] = block.number + 1; ++rearmed; emit EpochRearmed(e, block.number + 1);
        }
        emit RevealCommitSet(commit, rearmed, rearmed == 0 ? 0 : block.number + 1);
    }
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
        uint256 epoch = signerEpoch + 1;
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
        _requireOwned(id); require(tokenLook[id].choice != CHOICE_RANDOM, "RANDOM_URI_IS_DERIVED");
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
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
    }
    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == bytes4(0x49064906) || super.supportsInterface(id);
    }
    /// Chosen and revealed random tokens share one layout: revealBaseURI + lookKey hex + "/" + skin index. A chosen-skin
    /// token answers with its owner override if one was set. Before the reveal URIs are set there is nothing to derive.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        TokenLook storage t = tokenLook[id];
        if (t.choice != CHOICE_RANDOM) {
            string memory overrideURI = metadataURIs[id];
            if (bytes(overrideURI).length != 0) return overrideURI;
        }
        if (t.skin == 0 || bytes(revealBaseURI).length == 0) return pendingURI;
        return string.concat(revealBaseURI, Strings.toHexString(uint256(t.lookKey), 32), "/", Strings.toString(uint256(t.skin) - 1));
    }
    function tokenDisplayName(uint256 id) public view returns (string memory) { _requireOwned(id); return string.concat("Ember Evo ", Strings.toString(id)); }
    function remainingFreeReservation() public pure returns (uint256) {
        return 0;
    }
    function paidAvailability() public view returns (uint256) {
        if (!snapshotConfigured || block.timestamp < freeStartAt) return 0;
        return maxSupply - totalMinted;
    }
    /// Compatibility view: the token's look key (skin not included).
    function appearanceKey(uint256 id) external view returns (bytes32) { return tokenLook[id].lookKey; }
    /// Revealed skin of a token: (skin index, true) or (0, false) while a random skin is still pending.
    function skinOf(uint256 id) external view returns (uint8 skin, bool revealed) {
        _requireOwned(id); uint8 s = tokenLook[id].skin; return s == 0 ? (0, false) : (s - 1, true);
    }
    function currentEpoch() public view returns (uint256) { return (block.number - startBlock) / EPOCH_BLOCKS; }
    /// The first block after epoch `e` ends; its hash seeds the epoch.
    function epochSeedBlock(uint256 e) public view returns (uint256) {
        uint256 rearmed = epochRearmBlock[e];
        return rearmed != 0 ? rearmed : startBlock + (e + 1) * EPOCH_BLOCKS;
    }
    /// The epoch that must be revealed next, and whether it is ready (its seed block is mined: then every chosen-skin
    /// mint must reveal it first, with its committed secret).
    function nextRevealEpoch() public view returns (bool exists, uint256 epoch, bool seedKnown) {
        if (nextRevealIndex >= randomEpochs.length) return (false, 0, false);
        epoch = randomEpochs[nextRevealIndex];
        return (true, epoch, block.number > epochSeedBlock(epoch));
    }
    /// Epochs that hold random tokens, in reveal order (the signer reads these to know which secrets a reveal needs).
    function randomEpochCount() external view returns (uint256) { return randomEpochs.length; }
    function randomEpochAt(uint256 i) external view returns (uint256) { return randomEpochs[i]; }
    function epochRandomCount(uint256 e) external view returns (uint256) { return epochRandomTokens[e].length; }
    function epochRandomToken(uint256 e, uint256 i) external view returns (uint256) { return epochRandomTokens[e][i]; }

    function _approval(bytes32 lookKey, uint8 choice, string calldata uri, uint256 deadline, bytes calldata signature) private view {
        require(!mintPaused && snapshotConfigured, "MINT_NOT_READY");
        // Looks may repeat (R6): any number of tokens can share a look, in any skin.
        require(lookKey != bytes32(0) && choice <= CHOICE_RANDOM, "APPEARANCE_INVALID");
        if (choice == CHOICE_RANDOM) {
            // a random token's skin is unknown until the epoch reveal. It does not change the skin counts a reveal draws
            // from, so it may be minted while an earlier epoch waits for its reveal (review 2026-10-27).
            require(bytes(uri).length == 0, "RANDOM_URI_NOT_ALLOWED");
            require(epochRandomTokens[currentEpoch()].length < MAX_RANDOM_PER_EPOCH, "EPOCH_RANDOM_FULL");
        } else {
            // Once an epoch is ready, no chosen skin may change the skin counts until that epoch is fully revealed (the
            // mint's own `reveals` normally settle it just before).
            (, , bool seedKnown) = nextRevealEpoch();
            require(!seedKnown, "REVEAL_PENDING");
            require(bytes(uri).length != 0, "METADATA_REQUIRED");
            require(skinCount[choice] < skinCap(choice), "SKIN_SOLD_OUT");
        }
        require(block.timestamp <= deadline, "APPEARANCE_EXPIRED");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(APPEARANCE_TYPEHASH, msg.sender, lookKey, choice, keccak256(bytes(uri)), deadline, signerEpoch)));
        require(SignatureChecker.isValidSignatureNow(appearanceSigner, digest, signature), "APPEARANCE_AUTHORITY");
    }
    function _mintOne(bytes32 lookKey, uint8 choice, bool paid, uint256 cost) private {
        require(totalMinted < maxSupply, "SOLD_OUT");
        if (!supplyLocked) { supplyLocked = true; emit SupplyLocked(maxSupply); }   // the first mint fixes the supply
        uint256 id = ++totalMinted;
        uint64 epoch = uint64(currentEpoch());
        uint8 skin;
        if (choice == CHOICE_RANDOM) {
            tokenLook[id] = TokenLook(lookKey, choice, 0, epoch);
            if (epochRandomTokens[epoch].length == 0) randomEpochs.push(epoch);
            epochRandomTokens[epoch].push(id);
            ++pendingRandom;
            skin = SKIN_COUNT;
        } else {
            ++skinCount[choice];
            tokenLook[id] = TokenLook(lookKey, choice, choice + 1, epoch);   // its URI is derived in tokenURI
            skin = choice;
        }
        _safeMint(msg.sender, id); emit GenesisMinted(msg.sender, id, lookKey, choice, skin, paid, cost);
    }
    function mintFree(bytes32 lookKey, uint8 choice, string calldata uri, uint256 deadline, bytes calldata signature, bytes32[] calldata proof, bytes32[] calldata reveals) external nonReentrant {
        _settleReady(reveals);
        _approval(lookKey, choice, uri, deadline, signature);
        require(block.timestamp >= freeStartAt, "SALE_NOT_STARTED");
        require(!freeClaimed[msg.sender] && freeMinted < eligibleWalletCount, "FREE_ALREADY_CLAIMED");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        require(MerkleProof.verifyCalldata(proof, snapshotRoot, leaf), "NOT_IN_SNAPSHOT");
        freeClaimed[msg.sender] = true; ++freeMinted; _mintOne(lookKey, choice, false, 0);
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
        _approval(lookKey, choice, uri, deadline, signature);
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
        paidOrderTokenId[order.orderId] = totalMinted + 1;
        uint256 payerBefore = paymentToken.balanceOf(msg.sender);
        uint256 burnBefore = paymentToken.balanceOf(BURN_ADDRESS);
        uint256 supplyBefore = paymentToken.totalSupply();
        ++paidMinted;
        // nonReentrant guards both mint paths while the external token call is in progress.
        require(payerBefore >= paidCost, "BALANCE_REQUIRED");
        paymentToken.safeTransferFrom(msg.sender, BURN_ADDRESS, paidCost);
        require(paymentToken.balanceOf(msg.sender) == payerBefore - paidCost && paymentToken.balanceOf(BURN_ADDRESS) == burnBefore + paidCost, "EXACT_PAYMENT_REQUIRED");
        require(paymentToken.totalSupply() == supplyBefore, "TOKEN_SUPPLY_CHANGED");
        _mintOne(lookKey, choice, true, paidCost);
        emit PaidOrderConsumed(order.orderId, msg.sender, totalMinted, paidGoldCost);
        require(appearanceSigner == signer && signerEpoch == epoch && !mintPaused, "MINT_CONTEXT_CHANGED");
    }
    /// Prevent a still-valid authorization from spending a reservation after cancellation.
    /// GOLD release requires an authoritative consumed/revoked/expired read, not a UI timeout.
    function revokePaidOrder(bytes32 orderId) external onlyOwner nonReentrant {
        require(orderId != bytes32(0) && paidOrderTokenId[orderId] == 0, "PAID_ORDER_ALREADY_CONSUMED");
        paidOrderRevoked[orderId] = true;
        emit PaidOrderRevoked(orderId);
    }

    // ---- reveal: nobody (including the owner) can choose a token's skin ----
    /// Any mint first settles every epoch that is ready (its seed block is mined), using the committed secrets it carries
    /// (`reveals`, in order; the signer adds them to each approval): seals the epoch and reveals all of its random tokens
    /// in token order, before the mint changes any skin count. A chosen-skin mint that leaves a ready epoch unrevealed
    /// stops with REVEAL_PENDING (a random mint goes ahead: it changes no skin count). Secrets that do not open the current commitment are skipped (a concurrent transaction may have
    /// used them already: each used secret hashes to an earlier commitment, never the current one); extra ones are ignored.
    function _settleReady(bytes32[] calldata reveals) private returns (bool progressed) {
        uint256 used;
        for (uint256 guard; guard < 8; ++guard) {
            if (nextRevealIndex >= randomEpochs.length) return progressed;
            uint256 e = randomEpochs[nextRevealIndex];
            if (block.number <= epochSeedBlock(e)) return progressed;
            if (epochSeed[e] == bytes32(0)) {
                bytes32 commit = revealCommit;
                while (used < reveals.length && keccak256(abi.encode(reveals[used])) != commit) ++used;
                if (used == reveals.length) return progressed;    // its secret was not supplied
                _seal(e, reveals[used++]);
                progressed = true;
            }
            if (!revealURIsLocked) return progressed;             // unreachable once minting is open (setMintPaused)
            _revealRange(e, 0);
            progressed = true;
        }
    }
    /// The manual reveal button: seals and reveals every ready epoch with the given secrets (the signer publishes them
    /// once each epoch's seed block is mined).
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
    /// Seals epoch e with the next committed secret and the hash of its seed block (the first block after the epoch
    /// ends, or the re-armed one). Once that hash is out of reach the secret alone decides, so waiting gains nothing.
    function _seal(uint256 e, bytes32 secret) private {
        require(keccak256(abi.encode(secret)) == revealCommit, "REVEAL_SECRET_INVALID");
        revealCommit = secret; ++revealedSecrets;
        uint256 seedBlock = epochSeedBlock(e);
        bytes32 h = _blockHash(seedBlock);
        bytes32 seed = keccak256(abi.encode(h, secret, e, address(this)));
        if (seed == bytes32(0)) seed = bytes32(uint256(1));
        epochSeed[e] = seed;
        emit EpochSealed(e, seed, seedBlock, h, secret);
    }
    function _revealRange(uint256 e, uint256 maxCount) private returns (uint256 revealed) {
        bytes32 seed = epochSeed[e];
        uint256[] storage list = epochRandomTokens[e];
        uint256 i = epochCursor[e];
        uint256 end = list.length;
        if (maxCount != 0 && maxCount < end - i) end = i + maxCount;
        if (i < end) {
            // review 2026-10-27 (gas): the skin counts are read once and written back once per call, not per token; each
            // token still draws from what is left after the tokens before it, exactly as one-by-one reveals would.
            uint256[6] memory count;
            uint256[6] memory remaining;
            uint256 total;
            for (uint256 c; c < SKIN_COUNT; ++c) { count[c] = skinCount[c]; remaining[c] = skinCaps[c] - count[c]; total += remaining[c]; }
            for (; i < end; ++i) {
                uint256 id = list[i];
                require(total != 0, "NO_SKIN_LEFT"); // unreachable: sum of caps equals maxSupply
                uint256 r = uint256(keccak256(abi.encode(seed, id))) % total;
                uint256 skin;
                for (; skin < SKIN_COUNT; ++skin) { if (r < remaining[skin]) break; r -= remaining[skin]; }
                ++count[skin]; --remaining[skin]; --total;
                tokenLook[id].skin = uint8(skin) + 1;
                emit SkinRevealed(id, uint8(skin), e);
                emit MetadataUpdate(id);
                ++revealed;
            }
            for (uint256 c; c < SKIN_COUNT; ++c) if (count[c] != skinCount[c]) skinCount[c] = count[c];
            pendingRandom -= revealed;
        }
        epochCursor[e] = i;
        if (i == list.length) ++nextRevealIndex;
    }
    /// Anyone may seal the next epoch to reveal with its committed secret (settle does this together with the reveal).
    function sealEpoch(uint256 e, bytes32 secret) external nonReentrant {
        require(epochSeed[e] == bytes32(0), "EPOCH_ALREADY_SEALED");
        (bool exists, uint256 next, ) = nextRevealEpoch();
        require(exists && e == next, "EPOCH_OUT_OF_ORDER");
        require(block.number > epochSeedBlock(e), "EPOCH_NOT_READY");
        _seal(e, secret);
    }
    /// Anyone may reveal up to `maxCount` random tokens (0 = all) of the next sealed epoch, in token order.
    function revealEpoch(uint256 e, uint256 maxCount) external nonReentrant returns (uint256) {
        require(epochSeed[e] != bytes32(0), "EPOCH_NOT_SEALED");
        (bool exists, uint256 next, ) = nextRevealEpoch();
        require(exists && e == next, "EPOCH_OUT_OF_ORDER");
        require(revealURIsLocked, "REVEAL_URIS_NOT_LOCKED");
        return _revealRange(e, maxCount);
    }
}
