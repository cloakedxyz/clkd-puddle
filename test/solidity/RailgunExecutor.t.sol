// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {Kernel, IEntryPoint} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
import {RailgunExecutor, IERC20Deposit, IRailgunShield} from "../../contracts/RailgunExecutor.sol";

contract TestAsset {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public mode;

    function setMode(uint256 value) external {
        mode = value;
    }

    function mint(address owner, uint256 amount) external {
        balanceOf[owner] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode != 2 || amount != 0) allowance[msg.sender][spender] = amount;
        return mode != 1;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += mode == 3 && amount != 0 ? amount - 1 : amount;
        return true;
    }

    function transferFrom(address owner, address to, uint256 amount) external returns (bool) {
        if (mode != 2) allowance[owner][msg.sender] -= amount;
        balanceOf[owner] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TestPool is IRailgunShield {
    bool public reject;
    bytes32 public receivedNpk;

    function setReject(bool value) external {
        reject = value;
    }

    function shield(Request[] calldata requests) external {
        require(!reject, "rejected");
        require(requests.length == 1, "one note");
        receivedNpk = requests[0].preimage.npk;
        TestAsset(requests[0].preimage.token.tokenAddress)
            .transferFrom(msg.sender, address(this), requests[0].preimage.value);
    }
}

contract RailgunExecutorTest is Test {
    KernelFactory factory;
    ECDSAValidator validator;
    RailgunExecutor executor;
    TestAsset asset;
    TestPool pool;
    address owner = address(0x1111);
    address relayer = address(0x2222);
    address fees = address(0x3333);
    bytes recipient;
    bytes initData;
    bytes32 salt;
    address account;

    function setUp() public {
        factory = new KernelFactory(address(new Kernel(IEntryPoint(address(0)))));
        validator = new ECDSAValidator();
        asset = new TestAsset();
        pool = new TestPool();
        executor = new RailgunExecutor(factory, address(pool), IERC20Deposit(address(asset)), 2_000_000);
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
            abi.encodePacked(owner),
            bytes(""),
            installs
        );
        account = factory.getAddress(initData, salt);
    }

    function testFuzz_variableAmountFeesAndExcess(uint120 amount, uint120 gasFee, uint120 excess) public {
        amount = uint120(bound(amount, 2, type(uint120).max));
        uint256 cap = uint256(amount) - amount / 1000 - 1;
        if (cap > 2_000_000) cap = 2_000_000;
        gasFee = uint120(bound(gasFee, 0, cap));
        asset.mint(account, uint256(amount) + excess);
        vm.prank(relayer);
        executor.deployAndExecute(
            initData, salt, recipient, RailgunExecutor.Quote(amount, gasFee, uint48(block.timestamp))
        );
        assertEq(asset.balanceOf(account), excess);
        assertEq(asset.balanceOf(fees), uint256(amount) / 1000 + gasFee);
        assertEq(asset.balanceOf(address(pool)), uint256(amount) - amount / 1000 - gasFee);
        assertEq(asset.allowance(account, address(pool)), 0);
        assertEq(pool.receivedNpk(), bytes32(uint256(123)));
        assertTrue(executor.spent(account));
    }

    function test_rejectedPoolRollsBackDeploymentFeesAndUseFlag() public {
        asset.mint(account, 10_000_000);
        pool.setReject(true);
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecute(
            initData, salt, recipient, RailgunExecutor.Quote(10_000_000, 200_000, uint48(block.timestamp))
        );
        assertEq(account.code.length, 0);
        assertEq(asset.balanceOf(account), 10_000_000);
        assertEq(asset.balanceOf(fees), 0);
        assertFalse(executor.spent(account));
        pool.setReject(false);
        vm.prank(relayer);
        executor.deployAndExecute(
            initData, salt, recipient, RailgunExecutor.Quote(10_000_000, 200_000, uint48(block.timestamp))
        );
        assertTrue(executor.spent(account));
    }

    function testFuzz_badTokenResultsCannotChargeFees(uint8 mode) public {
        mode = uint8(bound(mode, 1, 3));
        asset.setMode(mode);
        asset.mint(account, 10_000_000);
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecute(
            initData, salt, recipient, RailgunExecutor.Quote(10_000_000, 200_000, uint48(block.timestamp))
        );
        assertEq(account.code.length, 0);
        assertEq(asset.balanceOf(account), 10_000_000);
        assertEq(asset.balanceOf(fees), 0);
        assertFalse(executor.spent(account));
    }

    function test_onlyCompleteBoundDepositIsExposed() public {
        asset.mint(account, 10_000_000);
        vm.prank(address(0xbad));
        vm.expectRevert();
        executor.deployAndExecute(
            initData, salt, recipient, RailgunExecutor.Quote(10_000_000, 200_000, uint48(block.timestamp))
        );
        vm.prank(relayer);
        vm.expectRevert();
        executor.deployAndExecute(
            initData,
            salt,
            abi.encode(bytes32(uint256(456)), bytes32[4]([bytes32(0), bytes32(0), bytes32(0), bytes32(0)])),
            RailgunExecutor.Quote(10_000_000, 200_000, uint48(block.timestamp))
        );
        assertEq(asset.balanceOf(fees), 0);
        assertEq(asset.balanceOf(account), 10_000_000);
    }
}
