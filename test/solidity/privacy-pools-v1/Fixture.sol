// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {DepositFixture, TestPool, IERC20} from "../shared/DepositFixture.sol";
import {PrivacyPoolsV1Deposit, PrivacyPoolsV1DepositFactory, DepositFactory, TokenPolicy,
    V1RagequitProof, V1_NATIVE} from "../../../contracts/protocols/PrivacyPoolsV1Deposit.sol";
import {DepositBase, DepositConfig, DepositQuote} from "../../../contracts/DepositBase.sol";

// Deliberately does not verify cryptographic proofs. The integration suite uses real upstream verifiers.
contract V1PoolStub is TestPool {
    mapping(address => uint256) public balances;
    uint256 public withdrawals;
    bool public removed;

    constructor(IERC20 asset) TestPool(asset) {}
    function ASSET() external view returns (address) { return address(token) == address(0) ? V1_NATIVE : address(token); }
    function ENTRYPOINT() external view returns (address) { return address(this); }
    function assetConfig(address) external view returns (address, uint256, uint256, uint256) {
        return (removed ? address(0) : address(this), 1, 0, 0);
    }
    function remove() external { removed = true; }
    function deposit(IERC20 asset, uint256 amount, uint256) external returns (uint256) {
        require(asset == token);
        _take(amount);
        balances[msg.sender] += amount;
        return amount;
    }
    function deposit(uint256) external payable returns (uint256) {
        if (mode == Mode.Reject) revert PoolRejected();
        if (mode == Mode.Reenter) {
            (bool ok,) = msg.sender.call(callbackData);
            reentryBlocked = !ok;
        }
        calls++;
        uint256 amount = msg.value;
        if (mode == Mode.Partial) { payable(msg.sender).transfer(1); amount--; }
        balances[msg.sender] += amount;
        return amount;
    }
    function ragequit(V1RagequitProof calldata proof) external {
        uint256 amount = proof.pubSignals[2];
        require(amount > 0 && amount == balances[msg.sender], "Bad or spent note");
        balances[msg.sender] = 0;
        withdrawals++;
        if (address(token) == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
        } else require(token.transfer(msg.sender, amount));
    }
    // Test-only partial withdrawal for randomized accounting sequences.
    function withdrawPartial(address depositor, uint256 amount) external {
        require(address(token) == address(0) && amount <= balances[depositor]);
        balances[depositor] -= amount;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
}

abstract contract V1Fixture is DepositFixture {
    function _setUpProtocol() internal override {
        pool = new V1PoolStub(token);
        TokenPolicy[] memory policies = new TokenPolicy[](1);
        policies[0] = TokenPolicy(token, uint120(gasCharge), 0);
        factory = new PrivacyPoolsV1DepositFactory(address(pool), policies);
        factoryAddress = address(factory);
        config = DepositConfig(abi.encode(address(token), address(pool), uint256(123)), recovery, relayer, feeRecipient);
    }
    function _protocolData() internal pure override returns (bytes memory) { return ""; }
    function _expectedCallHash(uint256 consumed) internal view override returns (bytes32) {
        return keccak256(abi.encodeWithSignature("deposit(address,uint256,uint256)", address(token),
            consumed - consumed / 1000 - gasCharge, uint256(123)));
    }
}
