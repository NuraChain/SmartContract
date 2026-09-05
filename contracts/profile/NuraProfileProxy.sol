// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title NuraProfileProxy
 * @notice The ERC-1967 proxy in front of {NuraProfile}. This is the address users, wallets
 *         and indexers talk to; it never changes across upgrades.
 *
 * @dev A verbatim OpenZeppelin ERC1967Proxy given a project-local name, so Hardhat emits an
 *      artifact Ignition can deploy and the explorer can be handed one flattened source. It
 *      adds no storage and no logic: the UUPS upgrade entry point lives in the
 *      implementation (`upgradeToAndCall`, owner-only), and every other call is forwarded.
 *      `data` is the encoded `initialize(owner)` call, executed atomically at construction
 *      so there is no window in which an uninitialized proxy could be claimed.
 */
contract NuraProfileProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
