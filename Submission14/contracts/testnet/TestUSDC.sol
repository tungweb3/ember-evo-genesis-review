// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST TOKEN for the Sepolia rehearsal only (2026-10-29): stands in for USDC, the token added after deployment
///         with addPaymentToken at its own GOLD price. 6 decimals like USDC. It has no value and is not USDC. Mainnet
///         deployment is refused.
contract TestUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 6;
    constructor(address holder) ERC20("TEST USDC (Sepolia rehearsal, no value)", "tUSDC") {
        require(block.chainid != 1, "TESTNET_ONLY");
        _mint(holder, 1_000_000 * 10 ** 6);
    }
    function decimals() public pure override returns (uint8) { return 6; }
    /// Anyone may take test tokens to try the paid route (50 mints at 20 each).
    function faucet() external { _mint(msg.sender, FAUCET_AMOUNT); }
}
