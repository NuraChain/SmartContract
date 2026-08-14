// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeToken} from "./BridgeToken.sol";

/**
 * @title BridgeBNB
 * @notice Bridged representation of BNB.
 * @dev 18 decimals, matching native BNB on BNB Chain.
 */
contract BridgeBNB is BridgeToken {
    constructor(address admin) BridgeToken("Bridge BNB", "BNB", 18, admin) {}
}
