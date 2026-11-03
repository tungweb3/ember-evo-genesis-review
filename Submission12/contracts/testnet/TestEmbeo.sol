// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST TOKEN for the Sepolia rehearsal only. It has no value and is not EMBEO. Mainnet deployment is refused.
contract TestEmbeo is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000_000 * 10 ** 18;
    constructor(address holder) ERC20("TEST EMBEO (Sepolia rehearsal, no value)", "tEMBEO") {
        require(block.chainid != 1, "TESTNET_ONLY");
        _mint(holder, 1_000_000_000 * 10 ** 18);
    }
    /// Anyone may take test tokens to try the paid route.
    function faucet() external { _mint(msg.sender, FAUCET_AMOUNT); }
}
