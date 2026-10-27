// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Synthetic callback token and owner forwarding adapter, only for the R3 payment regression.
contract R3HookToken is ERC20 {
    address public hook;
    bytes public hookData;
    bool public hookSucceeded;
    bytes public hookResult;
    constructor(address holder) ERC20("LOCAL R3 HOOK", "R3HOOK") { _mint(holder, 1000000000 ether); }
    function setHook(address target, bytes calldata data) external { hook = target; hookData = data; }
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        super.transferFrom(from, to, value);
        if (hook != address(0)) (hookSucceeded, hookResult) = hook.call(hookData);
        return true;
    }
}

contract R3OwnerForwarder {
    address public immutable controller = msg.sender;
    mapping(address => bool) public authorizedInvoker;
    function authorizeInvoker(address who) external { require(msg.sender == controller, "FIXTURE_CONTROLLER"); authorizedInvoker[who] = true; }
    function invoke(address target, bytes calldata data) external {
        require(msg.sender == controller || authorizedInvoker[msg.sender], "FIXTURE_INVOKER");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}
