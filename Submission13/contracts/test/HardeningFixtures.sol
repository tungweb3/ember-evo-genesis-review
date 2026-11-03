// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Synthetic test authority only; its setters are not a production multi-signature implementation.
contract ContractAuthority is IERC1271 {
    address public authority;
    bool public enabled = true;
    constructor(address signer) { authority = signer; }
    function setEnabled(bool value) external { enabled = value; }
    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return enabled && err == ECDSA.RecoverError.NoError && recovered == authority
            ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// Synthetic batch/catch wallet; no real account-control or wallet implementation claim.
contract HardeningWallet is IERC721Receiver {
    bool public firstSucceeded;
    bool public secondSucceeded;
    bytes public secondError;
    function invoke(address target, bytes calldata data) external {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly { revert(add(result,32),mload(result)) }
    }
    function batch(address target, bytes[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory result) = target.call(calls[i]);
            if (!ok) assembly { revert(add(result,32),mload(result)) }
        }
    }
    function batchTargets(address[] calldata targets, bytes[] calldata calls) external {
        require(targets.length == calls.length, "FIXTURE_LENGTH");
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory result) = targets[i].call(calls[i]);
            if (!ok) assembly { revert(add(result,32),mload(result)) }
        }
    }
    function catchSecond(address target, bytes calldata first, bytes calldata second) external {
        (firstSucceeded,) = target.call(first);
        (secondSucceeded,secondError) = target.call(second);
    }
    function retryAfterApproval(address target, bytes calldata first, address token, bytes calldata approval, bytes calldata second) external {
        (firstSucceeded,) = target.call(first);
        (bool approved,) = token.call(approval);
        require(approved, "FIXTURE_APPROVAL_FAILED");
        (secondSucceeded,secondError) = target.call(second);
    }
    function onERC721Received(address,address,uint256,bytes calldata) external pure returns(bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
