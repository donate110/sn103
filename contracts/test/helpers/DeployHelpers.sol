// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Deploys an ERC1967 proxy wrapping an implementation with an initializer call.
///      Usage: ContractType c = ContractType(_deployProxy(address(new ContractType()), initData));
function _deployProxy(address implementation, bytes memory initData) returns (address) {
    return address(new ERC1967Proxy(implementation, initData));
}
