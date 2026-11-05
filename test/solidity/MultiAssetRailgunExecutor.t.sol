// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {Kernel, IEntryPoint} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
import {RailgunExecutor, IERC20Deposit, IRailgunShield} from "../../contracts/RailgunExecutor.sol";
import {MultiAssetRailgunExecutor} from "../../contracts/MultiAssetRailgunExecutor.sol";
import {TestAsset, TestPool} from "./RailgunExecutor.t.sol";

contract WrappedTestAsset is TestAsset {
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

contract FeeTestPool is TestPool {
    function shieldFee() external pure returns (uint256) {
        return 0;
    }
}

contract MultiAssetRailgunExecutorTest is Test {
    KernelFactory factory;
    MultiAssetRailgunExecutor executor;
    WrappedTestAsset wrapped;
    TestAsset token;
    FeeTestPool pool;
    address account;
    address relayer = address(0x2222);
    address fees = address(0x3333);
    bytes initData;
    bytes recipient;

    function setUp() public {
        factory = new KernelFactory(address(new Kernel(IEntryPoint(address(0)))));
        ECDSAValidator validator = new ECDSAValidator();
        wrapped = new WrappedTestAsset();
        token = new TestAsset();
        pool = new FeeTestPool();
        executor = new MultiAssetRailgunExecutor(factory, address(pool), IERC20Deposit(address(wrapped)), 2_000_000);
        IRailgunShield.Ciphertext memory ciphertext;
        recipient = abi.encode(bytes32(uint256(123)), ciphertext);
        bytes[] memory installs = new bytes[](1);
        installs[0] = abi.encodeWithSignature(
            "installModule(uint256,address,bytes)",
            2,
            address(executor),
            abi.encodePacked(
                address(0),
                abi.encode(abi.encode(RailgunExecutor.Terms(relayer, fees, keccak256(recipient))), bytes(""))
            )
        );
        initData = abi.encodeWithSignature(
            "initialize(bytes21,address,bytes,bytes,bytes[])",
            bytes21(abi.encodePacked(bytes1(0x01), address(validator))),
            address(0),
            abi.encodePacked(address(0x1111)),
            bytes(""),
            installs
        );
        account = factory.getAddress(initData, bytes32(0));
    }

    function testFuzz_tokenSelectionAmountFeesAndExcess(uint120 amount, uint120 gasFee, uint120 excess) public {
        amount = uint120(bound(amount, 2, type(uint120).max));
        gasFee = uint120(bound(gasFee, 0, uint256(amount) / 20));
        token.mint(account, uint256(amount) + excess);
        vm.prank(relayer);
        executor.deployAndExecuteAsset(
            initData,
            bytes32(0),
            recipient,
            MultiAssetRailgunExecutor.AssetQuote(address(token), false, amount, gasFee, uint48(block.timestamp))
        );
        assertEq(token.balanceOf(account), excess);
        assertEq(token.balanceOf(fees), uint256(amount) / 1000 + gasFee);
        assertEq(token.balanceOf(address(pool)), uint256(amount) - amount / 1000 - gasFee);
        assertEq(token.allowance(account, address(pool)), 0);
        assertTrue(executor.spent(account));
    }

    function testFuzz_nativeWrapPreservesExistingWrappedTokens(uint120 amount, uint120 gasFee) public {
        amount = uint120(bound(amount, 2, 100 ether));
        uint256 cap = uint256(amount) / 20;
        if (cap > 2_000_000) cap = 2_000_000;
        gasFee = uint120(bound(gasFee, 0, cap));
        vm.deal(account, uint256(amount) + 123);
        wrapped.mint(account, 456);
        vm.prank(relayer);
        executor.deployAndExecuteAsset(
            initData,
            bytes32(0),
            recipient,
            MultiAssetRailgunExecutor.AssetQuote(address(wrapped), true, amount, gasFee, uint48(block.timestamp))
        );
        assertEq(account.balance, 123);
        assertEq(wrapped.balanceOf(account), 456);
        assertEq(wrapped.balanceOf(fees), uint256(amount) / 1000 + gasFee);
        assertEq(wrapped.allowance(account, address(pool)), 0);
    }

    function testFuzz_badTokenResultsRollBackEveryEffect(uint8 mode) public {
        token.setMode(uint8(bound(mode, 1, 3)));
        token.mint(account, 100_000_000);
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecuteAsset(
            initData,
            bytes32(0),
            recipient,
            MultiAssetRailgunExecutor.AssetQuote(address(token), false, 100_000_000, 200_000, uint48(block.timestamp))
        );
        assertEq(account.code.length, 0);
        assertEq(token.balanceOf(account), 100_000_000);
        assertEq(token.balanceOf(fees), 0);
        assertEq(token.balanceOf(address(pool)), 0);
        assertFalse(executor.spent(account));
    }

    function test_legacyEntryPointCannotBypassTheTokenFeePolicy() public {
        wrapped.mint(account, 1_000_000);
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecute(
            initData, bytes32(0), recipient, RailgunExecutor.Quote(1_000_000, 100_000, uint48(block.timestamp))
        );
        assertEq(account.code.length, 0);
        assertFalse(executor.spent(account));
    }

    function test_rejectsNativeTokenSubstitutionAndExcessiveTokenFee() public {
        token.mint(account, 100_000_000);
        vm.deal(account, 100_000_000);
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecuteAsset(
            initData,
            bytes32(0),
            recipient,
            MultiAssetRailgunExecutor.AssetQuote(address(token), true, 100_000_000, 0, uint48(block.timestamp))
        );
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecuteAsset(
            initData,
            bytes32(0),
            recipient,
            MultiAssetRailgunExecutor.AssetQuote(address(token), false, 100_000_000, 5_000_001, uint48(block.timestamp))
        );
        assertEq(account.code.length, 0);
        assertFalse(executor.spent(account));
    }
}
