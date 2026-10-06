// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;
import {DepositHandler, DepositInvariantTest} from "../shared/DepositInvariant.sol";
import {V1Fixture} from "./Fixture.sol";

contract V1Handler is DepositHandler, V1Fixture {
    constructor() { _initialize(1_000_000, 1_000); }
}
contract V1InvariantTest is DepositInvariantTest {
    function _createHandler() internal override returns (DepositHandler) { return new V1Handler(); }
}
