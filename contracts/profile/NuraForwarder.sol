// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title NuraForwarder
 * @notice The trusted ERC-2771 forwarder for NuraProfile: a user signs a ForwardRequest (EIP-712
 *         domain "NuraForwarder", version "1"), a sponsor submits it with `execute` and pays the gas.
 */
contract NuraForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("NuraForwarder") {}
}
