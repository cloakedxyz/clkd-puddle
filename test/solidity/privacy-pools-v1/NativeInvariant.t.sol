// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {TestPool} from "../shared/DepositFixture.sol";
import {V1PoolStub, PrivacyPoolsV1Deposit, PrivacyPoolsV1DepositFactory, DepositBase,
    DepositConfig, DepositQuote, IERC20, TokenPolicy, V1RagequitProof} from "./Fixture.sol";

contract V1NativeHandler is Test {
    V1PoolStub public pool;
    PrivacyPoolsV1DepositFactory internal factory;
    DepositConfig internal config;
    address internal deposit;
    address internal owner;
    address internal relayer;
    address internal fees;
    uint256 internal constant AMOUNT = 1 ether;
    uint256 internal funded;
    uint256 internal returned;
    uint256 internal poolRemaining;
    uint256 internal paidFees;
    bool internal settled;
    constructor() {
        owner = makeAddr("owner"); relayer = makeAddr("relayer"); fees = makeAddr("fees");
        pool = new V1PoolStub(IERC20(address(0)));
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(IERC20(address(0)), 0, 0);
        factory = new PrivacyPoolsV1DepositFactory(address(pool), policies);
        config = DepositConfig(abi.encode(address(0), address(pool), uint256(123)), owner, relayer, fees);
        deposit = factory.computeAddress(bytes32(0), config);
    }
    function fund(uint96 seed) public {
        uint256 amount = bound(seed, 1, 3 ether);
        vm.deal(deposit, deposit.balance + amount);
        funded += amount;
    }
    function relay(bool rejectPool) public {
        bool fails = settled || deposit.balance < AMOUNT || rejectPool;
        pool.configure(rejectPool ? TestPool.Mode.Reject : TestPool.Mode.Normal);
        if (fails) vm.expectRevert(settled ? DepositBase.AlreadyExecuted.selector
            : deposit.balance < AMOUNT ? DepositBase.InvalidBalance.selector : TestPool.PoolRejected.selector);
        vm.prank(relayer);
        factory.deployAndExecute(bytes32(0), config, DepositQuote(IERC20(address(0)), AMOUNT, 0, block.timestamp), "");
        if (!fails) { settled = true; paidFees = AMOUNT / 1000; poolRemaining = AMOUNT - paidFees; }
        pool.configure(TestPool.Mode.Normal);
    }
    function recoverAddress() public {
        factory.deploy(bytes32(0), config);
        uint256 amount = deposit.balance;
        vm.prank(owner);
        DepositBase(deposit).recoverNative();
        returned += amount;
    }
    function withdrawPartial(uint96 seed) public {
        if (poolRemaining == 0) return;
        uint256 amount = bound(seed, 1, poolRemaining);
        vm.prank(owner);
        pool.withdrawPartial(deposit, amount);
        poolRemaining -= amount; returned += amount;
    }
    function recoverPool() public {
        factory.deploy(bytes32(0), config);
        V1RagequitProof memory proof;
        proof.pubSignals[2] = poolRemaining;
        if (!settled || poolRemaining == 0) vm.expectRevert(DepositBase.InvalidBalance.selector);
        vm.prank(owner);
        PrivacyPoolsV1Deposit(payable(deposit)).ragequit(proof);
        returned += poolRemaining; poolRemaining = 0;
    }
    function unauthorized() public {
        factory.deploy(bytes32(0), config);
        V1RagequitProof memory proof;
        proof.pubSignals[2] = poolRemaining;
        vm.expectRevert(DepositBase.NotRecoveryOwner.selector);
        vm.prank(relayer);
        PrivacyPoolsV1Deposit(payable(deposit)).ragequit(proof);
    }
    function assertAccounting() public view {
        assertEq(deposit.balance + returned + paidFees + poolRemaining, funded);
        assertEq(owner.balance, returned);
        assertEq(fees.balance, paidFees);
        assertEq(address(pool).balance, poolRemaining);
        assertLe(pool.calls(), 1);
        if (deposit.code.length != 0) assertEq(DepositBase(deposit).spent(), settled);
    }
    function drain() public {
        if (poolRemaining > 0) recoverPool();
        recoverAddress();
        assertAccounting();
        assertEq(returned + paidFees, funded);
    }
}

contract V1NativeInvariantTest is Test {
    V1NativeHandler internal handler;
    function setUp() public {
        handler = new V1NativeHandler();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.relay.selector;
        selectors[2] = handler.recoverAddress.selector;
        selectors[3] = handler.withdrawPartial.selector;
        selectors[4] = handler.recoverPool.selector;
        selectors[5] = handler.unauthorized.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector(address(handler), selectors));
    }
    function invariant_AllFundsAccountedFor() public view { handler.assertAccounting(); }
    function afterInvariant() public { handler.drain(); }
    function test_FullSequence() public {
        handler.fund(uint96(2 ether)); handler.relay(true); handler.relay(false);
        handler.withdrawPartial(uint96(0.2 ether)); handler.unauthorized(); handler.recoverPool();
        handler.fund(123); handler.relay(false); handler.drain();
    }
}
