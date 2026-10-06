// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositBehavior} from "../shared/DepositBehavior.sol";
import {V1Fixture, V1PoolStub, PrivacyPoolsV1Deposit, PrivacyPoolsV1DepositFactory, DepositBase,
    DepositConfig, DepositQuote, IERC20, TokenPolicy, V1RagequitProof} from "./Fixture.sol";
import {Test} from "forge-std/Test.sol";
import {TestPool} from "../shared/DepositFixture.sol";

contract V1DepositTest is DepositBehavior, V1Fixture {
    function test_RecoveryDoesNotDependOnPoolAvailability() public {
        config.recipient = abi.encode(address(token), address(0xdead), uint256(123));
        depositAddress = _predict();
        token.mint(depositAddress, quote);
        _deploy(); // Even an invalid/unavailable pool cannot obstruct pre-deposit recovery.
        vm.prank(recovery);
        DepositBase(depositAddress).recover(token);
        assertEq(token.balanceOf(recovery), quote);
    }
    function test_TokenAndPoolAreBoundAndNoArbitraryCalldataIsAccepted() public {
        token.mint(depositAddress, quote);
        vm.startPrank(relayer);
        vm.expectRevert(DepositBase.WrongDepositCall.selector);
        factory.deployAndExecute(salt, config, _execution(gasCharge), hex"1234");
        V1PoolStub(address(pool)).remove();
        vm.expectRevert(DepositBase.WrongDepositCall.selector);
        _relay(true);
        vm.stopPrank();
        assertEq(token.balanceOf(depositAddress), quote);
    }
}

contract V1NativeTest is Test {
    V1PoolStub internal pool;
    PrivacyPoolsV1DepositFactory internal factory;
    DepositConfig internal config;
    address internal deposit;
    address internal owner;
    address internal relayer;
    address internal fees;
    uint256 internal constant AMOUNT = 1 ether;
    function setUp() public {
        owner = makeAddr("owner"); relayer = makeAddr("relayer"); fees = makeAddr("fees");
        pool = new V1PoolStub(IERC20(address(0)));
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(IERC20(address(0)), 0, 0);
        factory = new PrivacyPoolsV1DepositFactory(address(pool), policies);
        config = DepositConfig(abi.encode(address(0), address(pool), uint256(123)), owner, relayer, fees);
        deposit = factory.computeAddress(bytes32(0), config);
    }
    function testFuzz_NativeFeesExitAndExcess(uint96 extra) public {
        vm.deal(deposit, AMOUNT + extra);
        vm.prank(relayer);
        factory.deployAndExecute(bytes32(0), config, DepositQuote(IERC20(address(0)), AMOUNT, 0, block.timestamp), "");
        assertEq(fees.balance, AMOUNT / 1000);
        assertEq(deposit.balance, extra);
        V1RagequitProof memory proof;
        proof.pubSignals[2] = AMOUNT - AMOUNT / 1000;
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        PrivacyPoolsV1Deposit(payable(deposit)).ragequit(proof);
        vm.prank(owner);
        PrivacyPoolsV1Deposit(payable(deposit)).ragequit(proof);
        assertEq(owner.balance, AMOUNT - AMOUNT / 1000);
        assertEq(deposit.balance, extra);
        vm.prank(owner);
        DepositBase(deposit).recoverNative();
        assertEq(owner.balance + fees.balance, AMOUNT + extra);
        vm.expectRevert(); vm.prank(owner);
        PrivacyPoolsV1Deposit(payable(deposit)).ragequit(proof);
    }
    function testFuzz_FailedNativeDepositRollsBack(bool partialConsumption) public {
        pool.configure(partialConsumption ? TestPool.Mode.Partial : TestPool.Mode.Reject);
        vm.deal(deposit, AMOUNT);
        vm.expectRevert(); vm.prank(relayer);
        factory.deployAndExecute(bytes32(0), config, DepositQuote(IERC20(address(0)), AMOUNT, 0, block.timestamp), "");
        assertEq(deposit.balance, AMOUNT);
        assertEq(fees.balance, 0);
        assertEq(deposit.code.length, 0);
    }
}
