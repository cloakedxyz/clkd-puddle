// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {IExecutor} from "kernel/interfaces/IERC7579Modules.sol";
import {IERC7579Account, Execution, ExecMode} from "kernel/interfaces/IERC7579Account.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

interface IERC20Deposit {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IRailgunShield {
    struct TokenData {
        uint8 tokenType;
        address tokenAddress;
        uint256 tokenSubID;
    }

    struct Preimage {
        bytes32 npk;
        TokenData token;
        uint120 value;
    }

    struct Ciphertext {
        bytes32[3] encryptedBundle;
        bytes32 shieldKey;
    }

    struct Request {
        Preimage preimage;
        Ciphertext ciphertext;
    }
    function shield(Request[] calldata requests) external;
}

/// @notice RAILGUN deposit rules for an unmodified ZeroDev Kernel account.
/// @dev The Kernel owner retains recovery. This module cannot accept arbitrary calls.
contract RailgunExecutor is IExecutor, ReentrancyGuard {
    struct Terms {
        address relayer;
        address feeRecipient;
        bytes32 recipientHash;
    }

    struct Quote {
        uint120 amount;
        uint120 gasFee;
        uint48 deadline;
    }

    KernelFactory public immutable factory;
    address public immutable pool;
    IERC20Deposit public immutable asset;
    uint120 public immutable maxGasFee;
    mapping(address => Terms) public terms;
    mapping(address => bool) public installed;
    // Survives uninstall/reinstall. A failed deposit reverts this flag too.
    mapping(address => bool) public spent;
    bytes32 private constant BATCH = bytes32(uint256(1) << 248);

    error InvalidConfiguration();
    error InvalidQuote();
    error Unauthorized();
    error AlreadySpent();
    error WrongRecipient();
    error InsufficientFunding();
    error IncorrectSettlement();
    event DepositCompleted(address indexed account, uint256 amount, uint256 fee);

    constructor(KernelFactory factory_, address pool_, IERC20Deposit asset_, uint120 maxGasFee_) {
        if (address(factory_).code.length == 0 || pool_.code.length == 0 || address(asset_).code.length == 0) {
            revert InvalidConfiguration();
        }
        factory = factory_;
        pool = pool_;
        asset = asset_;
        maxGasFee = maxGasFee_;
    }

    function isModuleType(uint256 moduleType) external pure returns (bool) {
        return moduleType == 2;
    }

    function isInitialized(address account) external view returns (bool) {
        return installed[account];
    }

    function onInstall(bytes calldata data) external payable {
        if (installed[msg.sender]) revert AlreadyInitialized(msg.sender);
        Terms memory t = abi.decode(data, (Terms));
        if (
            t.relayer == address(0) || t.relayer == msg.sender || t.feeRecipient == address(0)
                || t.feeRecipient == msg.sender || t.feeRecipient == pool || t.recipientHash == bytes32(0)
        ) {
            revert InvalidConfiguration();
        }
        terms[msg.sender] = t;
        installed[msg.sender] = true;
    }

    function onUninstall(bytes calldata) external payable {
        if (!installed[msg.sender]) revert NotInitialized(msg.sender);
        delete installed[msg.sender];
        delete terms[msg.sender];
    }

    function deployAndExecute(bytes calldata initData, bytes32 salt, bytes calldata recipient, Quote calldata quote)
        external
        virtual
        nonReentrant
        returns (address account)
    {
        account = factory.createAccount(initData, salt);
        _execute(account, recipient, quote);
    }

    function execute(address account, bytes calldata recipient, Quote calldata quote) external virtual nonReentrant {
        _execute(account, recipient, quote);
    }

    function _execute(address account, bytes calldata recipient, Quote calldata quote) private {
        if (!installed[account]) revert NotInitialized(account);
        Terms memory t = terms[account];
        if (msg.sender != t.relayer) revert Unauthorized();
        if (spent[account]) revert AlreadySpent();
        if (recipient.length != 160 || keccak256(recipient) != t.recipientHash) revert WrongRecipient();
        uint256 fee = uint256(quote.amount) / 1000 + quote.gasFee;
        if (quote.amount == 0 || fee >= quote.amount || quote.gasFee > maxGasFee || quote.deadline < block.timestamp) {
            revert InvalidQuote();
        }
        uint256 beforeAccount = asset.balanceOf(account);
        uint256 beforeFee = asset.balanceOf(t.feeRecipient);
        if (beforeAccount < quote.amount) revert InsufficientFunding();
        spent[account] = true;

        (bytes32 npk, IRailgunShield.Ciphertext memory ciphertext) =
            abi.decode(recipient, (bytes32, IRailgunShield.Ciphertext));
        IRailgunShield.Request[] memory requests = new IRailgunShield.Request[](1);
        requests[0] = IRailgunShield.Request(
            IRailgunShield.Preimage(npk, IRailgunShield.TokenData(0, address(asset), 0), uint120(quote.amount - fee)),
            ciphertext
        );
        Execution[] memory calls = new Execution[](5);
        calls[0] = Execution(address(asset), 0, abi.encodeCall(IERC20Deposit.approve, (pool, 0)));
        calls[1] = Execution(address(asset), 0, abi.encodeCall(IERC20Deposit.approve, (pool, quote.amount - fee)));
        calls[2] = Execution(pool, 0, abi.encodeCall(IRailgunShield.shield, (requests)));
        calls[3] = Execution(address(asset), 0, abi.encodeCall(IERC20Deposit.approve, (pool, 0)));
        calls[4] = Execution(address(asset), 0, abi.encodeCall(IERC20Deposit.transfer, (t.feeRecipient, fee)));
        bytes[] memory result = IERC7579Account(account).executeFromExecutor(ExecMode.wrap(BATCH), abi.encode(calls));
        if (result.length != 5) revert IncorrectSettlement();
        for (uint256 i; i < result.length; ++i) {
            if (i != 2 && result[i].length != 0 && !abi.decode(result[i], (bool))) revert IncorrectSettlement();
        }
        if (
            asset.allowance(account, pool) != 0 || asset.balanceOf(account) != beforeAccount - quote.amount
                || asset.balanceOf(t.feeRecipient) != beforeFee + fee
        ) revert IncorrectSettlement();
        emit DepositCompleted(account, quote.amount, fee);
    }
}
