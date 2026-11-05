// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Freely mintable local test token. Never use this as a real asset.
contract DemoToken is ERC20 {
    constructor() ERC20("Demo USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Disposable wrapped native token for local relay-worker tests.
contract DemoWrappedNative is ERC20 {
    constructor() ERC20("Demo wrapped native", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
}

contract Demo18Token is ERC20 {
    constructor() ERC20("Demo token", "DEMO") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract DemoTaxToken is ERC20 {
    constructor() ERC20("Tax token", "TAX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (amount > 0) _burn(to, 1);
    }
}
contract DemoNoReturnToken {
    string public constant symbol = "NORET";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address to, uint256 amount) external { allowance[msg.sender][to] = amount; }
    function transfer(address to, uint256 amount) external { _transfer(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external { allowance[from][msg.sender] -= amount; _transfer(from, to, amount); }
    function _transfer(address from, address to, uint256 amount) internal { balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}

/// @notice Disposable upgrade fixture; no production deployment.
contract DemoTokenProxy {
    bytes32 private constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address private immutable admin = msg.sender;
    constructor(address implementation) { assembly { sstore(SLOT, implementation) } }
    function setImplementation(address implementation) external { require(msg.sender == admin); assembly { sstore(SLOT, implementation) } }
    fallback() external {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), sload(SLOT), 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch success case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}
contract DemoHighDecimals is ERC20 {
    constructor() ERC20("High decimals", "HIGH") {}
    function decimals() public pure override returns (uint8) { return 200; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract DemoBareToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address to, uint256 amount) external { allowance[msg.sender][to] = amount; }
    function transfer(address to, uint256 amount) external { _transfer(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external { allowance[from][msg.sender] -= amount; _transfer(from, to, amount); }
    function _transfer(address from, address to, uint256 amount) internal { balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}
