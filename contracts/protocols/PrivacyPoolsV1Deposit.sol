// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBase, DepositQuote, IERC20, InvalidConfiguration} from "../DepositBase.sol";
import {DepositFactory, TokenPolicy} from "../DepositFactory.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

uint256 constant V1_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
address constant V1_NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

struct V1RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals;
}

interface IV1Entrypoint {
    function assetConfig(address asset) external view returns (address, uint256, uint256, uint256);
    function deposit(uint256 precommitment) external payable returns (uint256);
    function deposit(IERC20 asset, uint256 value, uint256 precommitment) external returns (uint256);
}

interface IV1Pool {
    function ragequit(V1RagequitProof calldata proof) external;
    function ASSET() external view returns (address);
    function ENTRYPOINT() external view returns (address);
}

function validatePrivacyPoolsV1Recipient(bytes memory recipient) pure {
    if (recipient.length != 96) revert InvalidConfiguration();
    (, address assetPool, uint256 precommitment) = abi.decode(recipient, (address, address, uint256));
    if (assetPool == address(0) || precommitment == 0 || precommitment >= V1_FIELD) revert InvalidConfiguration();
}

/// @notice Recipient-generated deposit hash; no private secrets are sent to this contract.
/// @dev pool is the entrypoint. assetPool is fixed separately so removal from the registry cannot block ragequit.
contract PrivacyPoolsV1Deposit is DepositBase {
    using SafeERC20 for IERC20;
    using Address for address;

    address public asset;
    address public assetPool;
    uint256 public precommitment;

    event PoolRecovered(address indexed asset, uint256 amount, uint256 label);

    constructor(address target) DepositBase(target) {}

    function _initializeRecipient(bytes calldata recipient) internal override {
        validatePrivacyPoolsV1Recipient(recipient);
        (asset, assetPool, precommitment) = abi.decode(recipient, (address, address, uint256));
    }

    function _poolAsset() private view returns (address) { return asset == address(0) ? V1_NATIVE : asset; }

    function _poolCall(IERC20 token, uint256 amount, bytes calldata data) internal view override returns (bytes memory) {
        (address registered,,,) = IV1Entrypoint(pool).assetConfig(_poolAsset());
        if (address(token) != asset || data.length != 0 || registered != assetPool) revert WrongDepositCall();
        if (IV1Pool(assetPool).ASSET() != _poolAsset() || IV1Pool(assetPool).ENTRYPOINT() != pool) {
            revert InvalidConfiguration();
        }
        return asset == address(0)
            ? abi.encodeWithSignature("deposit(uint256)", precommitment)
            : abi.encodeWithSignature("deposit(address,uint256,uint256)", asset, amount, precommitment);
    }

    function _settle(DepositQuote calldata quote, uint256 serviceFee, uint256 poolAmount, bytes memory callData)
        internal override
    {
        if (asset != address(0)) { super._settle(quote, serviceFee, poolAmount, callData); return; }
        uint256 beforeBalance = address(this).balance;
        if (beforeBalance < quote.amount) revert InvalidBalance();
        uint256 fee = serviceFee + quote.gasFee;
        if (fee != 0) Address.sendValue(payable(feeRecipient), fee);
        pool.functionCallWithValue(callData, poolAmount);
        if (address(this).balance != beforeBalance - quote.amount) revert IncompleteDeposit();
    }

    /// @notice Public exit to the fixed recovery owner. The owner must also possess the current note's secrets.
    /// @dev No arbitrary target, calldata, or recipient. Failed forwarding rolls back the pool withdrawal too.
    function ragequit(V1RagequitProof calldata proof) external nonReentrant {
        if (msg.sender != recovery) revert NotRecoveryOwner();
        if (!spent) revert InvalidBalance();
        uint256 amount = proof.pubSignals[2];
        if (amount == 0) revert InvalidBalance();
        uint256 beforeBalance = _balance();
        IV1Pool(assetPool).ragequit(proof);
        if (_balance() != beforeBalance + amount) revert IncompleteDeposit();
        if (asset == address(0)) Address.sendValue(payable(recovery), amount);
        else {
            uint256 ownerBefore = IERC20(asset).balanceOf(recovery);
            IERC20(asset).safeTransfer(recovery, amount);
            if (IERC20(asset).balanceOf(recovery) != ownerBefore + amount) revert UnsupportedToken();
        }
        if (_balance() != beforeBalance) revert IncompleteDeposit();
        emit PoolRecovered(asset, amount, proof.pubSignals[3]);
    }

    function _balance() private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    receive() external payable {}
}

contract PrivacyPoolsV1DepositFactory is DepositFactory {
    constructor(address target, TokenPolicy[] memory policies)
        DepositFactory(target, policies, type(PrivacyPoolsV1Deposit).creationCode) {}

    function _validateRecipient(bytes calldata recipient) internal pure override {
        validatePrivacyPoolsV1Recipient(recipient);
    }

    function _supportsNative() internal pure override returns (bool) { return true; }
}
