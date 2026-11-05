// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {RailgunExecutor, IERC20Deposit, IRailgunShield} from "./RailgunExecutor.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {IERC7579Account, Execution, ExecMode} from "kernel/interfaces/IERC7579Account.sol";

interface IWrappedNative {
    function deposit() external payable;
}

interface IPoolFee {
    function shieldFee() external view returns (uint256);
}

/// @notice The same one-deposit Kernel rules, with token selection after funding.
/// @dev `asset` is the chain's reviewed wrapped native token. No arbitrary calls or swaps.
contract MultiAssetRailgunExecutor is RailgunExecutor {
    uint256 public constant maxTokenGasFeeBps = 500;

    struct AssetQuote {
        address token;
        bool native;
        uint120 amount;
        uint120 gasFee;
        uint48 deadline;
    }

    constructor(KernelFactory factory_, address pool_, IERC20Deposit wrappedNative_, uint120 maxNativeGasFee_)
        RailgunExecutor(factory_, pool_, wrappedNative_, maxNativeGasFee_)
    {}

    // Disable the inherited WETH entry points so every deposit uses the same 5% policy.
    function deployAndExecute(bytes calldata, bytes32, bytes calldata, Quote calldata)
        external
        pure
        override
        returns (address)
    {
        revert InvalidQuote();
    }

    function execute(address, bytes calldata, Quote calldata) external pure override {
        revert InvalidQuote();
    }

    function multiAsset() external pure returns (bool) {
        return true;
    }

    function deployAndExecuteAsset(
        bytes calldata initData,
        bytes32 salt,
        bytes calldata recipient,
        AssetQuote calldata q
    ) external nonReentrant returns (address account) {
        account = factory.createAccount(initData, salt);
        _executeAsset(account, recipient, q);
    }

    function executeAsset(address account, bytes calldata recipient, AssetQuote calldata q) external nonReentrant {
        _executeAsset(account, recipient, q);
    }

    function _executeAsset(address account, bytes calldata recipient, AssetQuote calldata q) private {
        if (!installed[account]) revert NotInitialized(account);
        Terms memory t = terms[account];
        if (msg.sender != t.relayer) revert Unauthorized();
        if (spent[account]) revert AlreadySpent();
        if (recipient.length != 160 || keccak256(recipient) != t.recipientHash) revert WrongRecipient();
        uint256 fee = uint256(q.amount) / 1000 + q.gasFee;
        if (
            q.token.code.length == 0 || q.token == account || q.token == pool || q.token == t.feeRecipient
                || q.amount == 0 || fee >= q.amount || q.deadline < block.timestamp
                || q.gasFee > uint256(q.amount) * maxTokenGasFeeBps / 10000
                || (q.token == address(asset) && q.gasFee > maxGasFee) || (q.native && q.token != address(asset))
        ) revert InvalidQuote();
        IERC20Deposit token = IERC20Deposit(q.token);
        uint256 beforeAccount = token.balanceOf(account);
        uint256 beforeNative = account.balance;
        uint256 beforeFee = token.balanceOf(t.feeRecipient);
        uint256 beforePool = token.balanceOf(pool);
        uint256 poolFeeBps = IPoolFee(pool).shieldFee();
        if (poolFeeBps >= 10000) revert InvalidQuote();
        if (q.native ? beforeNative < q.amount : beforeAccount < q.amount) revert InsufficientFunding();
        spent[account] = true;
        (bytes32 npk, IRailgunShield.Ciphertext memory ciphertext) =
            abi.decode(recipient, (bytes32, IRailgunShield.Ciphertext));
        uint256 poolAmount = q.amount - fee;
        IRailgunShield.Request[] memory requests = new IRailgunShield.Request[](1);
        requests[0] = IRailgunShield.Request(
            IRailgunShield.Preimage(npk, IRailgunShield.TokenData(0, q.token, 0), uint120(poolAmount)), ciphertext
        );
        uint256 offset = q.native ? 1 : 0;
        Execution[] memory calls = new Execution[](5 + offset);
        if (q.native) calls[0] = Execution(q.token, q.amount, abi.encodeCall(IWrappedNative.deposit, ()));
        calls[offset] = Execution(q.token, 0, abi.encodeCall(IERC20Deposit.approve, (pool, 0)));
        calls[offset + 1] = Execution(q.token, 0, abi.encodeCall(IERC20Deposit.approve, (pool, poolAmount)));
        calls[offset + 2] = Execution(pool, 0, abi.encodeCall(IRailgunShield.shield, (requests)));
        calls[offset + 3] = Execution(q.token, 0, abi.encodeCall(IERC20Deposit.approve, (pool, 0)));
        calls[offset + 4] = Execution(q.token, 0, abi.encodeCall(IERC20Deposit.transfer, (t.feeRecipient, fee)));
        bytes[] memory result =
            IERC7579Account(account).executeFromExecutor(ExecMode.wrap(bytes32(uint256(1) << 248)), abi.encode(calls));
        if (result.length != calls.length) revert IncorrectSettlement();
        for (uint256 i = offset; i < result.length; ++i) {
            if (i != offset + 2 && result[i].length != 0 && !abi.decode(result[i], (bool))) {
                revert IncorrectSettlement();
            }
        }
        // Exact credits reject transfer taxes and inconsistent settlement. Rebasing tokens
        // must additionally be excluded by operator policy; one transaction cannot prove that property.
        if (
            token.allowance(account, pool) != 0
                || token.balanceOf(account) != (q.native ? beforeAccount : beforeAccount - q.amount)
                || account.balance != (q.native ? beforeNative - q.amount : beforeNative)
                || token.balanceOf(t.feeRecipient) != beforeFee + fee
                || token.balanceOf(pool) != beforePool + poolAmount - poolAmount * poolFeeBps / 10000
        ) {
            revert IncorrectSettlement();
        }
        emit DepositCompleted(account, q.amount, fee);
    }
}
