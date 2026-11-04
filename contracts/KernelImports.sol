// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// Build unmodified upstream contracts. Puddle supplies no account or factory.
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
