// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeToken} from "./BridgeToken.sol";

/**
 * @title BridgeETH
 * @notice Bridged representation of ETH.
 * @dev 18 decimals, matching native ETH and ETH on BNB Chain.
 */
contract BridgeETH is BridgeToken {
    constructor(address admin) BridgeToken("Bridge ETH", "ETH", 18, admin) {}
}
