// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {EmberEvoGenesisCandidate} from "../EmberEvoGenesisCandidate.sol";

contract FixtureToken is ERC20 {
    constructor(address user) ERC20("LOCAL ONLY EMBEO fixture", "LOCAL") { _mint(user, 1_000_000_000 * 10**18); }
}
contract FeeToken is ERC20 {
    constructor(address user) ERC20("LOCAL ONLY taxed fixture", "FEE") { _mint(user, 1_000_000_000 * 10**18); }
    function _update(address from, address to, uint256 value) internal override {
        if(from != address(0) && to != address(0) && value > 1) { super._update(from, to, value - 1); super._update(from, address(0), 1); }
        else super._update(from, to, value);
    }
}
contract CallbackReceiver is IERC721Receiver {
    bool public rejectNFT;
    bool public callbackAttemptSucceeded;
    address public target;
    bytes public callbackData;
    function setReject(bool value) external { rejectNFT = value; }
    function setCallback(address next, bytes calldata data) external { target = next; callbackData = data; }
    function invoke(address to, bytes calldata data) external {
        (bool ok, bytes memory result) = to.call(data);
        if(!ok) assembly { revert(add(result,32),mload(result)) }
    }
    function onERC721Received(address,address,uint256,bytes calldata) external returns(bytes4) {
        require(!rejectNFT, "FIXTURE_REJECT_NFT");
        if(target != address(0)) { (callbackAttemptSucceeded,) = target.call(callbackData); }
        return IERC721Receiver.onERC721Received.selector;
    }
}
/// Storage boundary seeding is test-only; it does not mint 887 real NFTs or add an admin mint path to the candidate.
contract SupplyBoundaryHarness is EmberEvoGenesisCandidate {
    constructor(address owner_,address token_,address signer_,uint256 cost_)
        EmberEvoGenesisCandidate(owner_,token_,signer_,cost_,1,"BOUNDARY_LOCAL") {}
    /// Seeds supply as if `count` tokens of `skin` were already minted, or (skin 6) `count` tokens in the total only, so
    /// the sold-out paths can be exercised without minting. The caller keeps the values in range.
    /// (One function, no checks: the harness must stay under the 24,576-byte code limit with the full contract inside.)
    /// (skinState: counts from bit 96, 16 bits per skin; totalMinted at bit 192. Seeded tokens count as paid.)
    function seedForTest(uint256 skin, uint256 count) external onlyOwner { skinState += (skin < 6 ? count << (96 + 16 * skin) : 0) + (count << 192); }
}
