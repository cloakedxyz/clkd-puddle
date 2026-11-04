// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @notice Local-only contract-wallet fixture: direct owner calls, no signature abstraction.
contract RecoveryWallet {
    address public immutable controller;
    constructor(address owner) { controller = owner; }
    receive() external payable {}
    function perform(address target, bytes calldata data) external {
        require(msg.sender == controller, "owner only");
        (bool success, bytes memory result) = target.call(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
    }
}
