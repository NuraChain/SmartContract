// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeToken} from "./BridgeToken.sol";

/**
 * @title BridgeUSDT
 * @notice Bridged representation of USDT.
 * @dev 18 decimals, matching USDT on BNB Chain. USDT on Ethereum and Tron uses 6
 *      decimals instead — if you bridge from either of those, the off-chain relayer
 *      must scale amounts by 1e12 when it mints here.
 */
contract BridgeUSDT is BridgeToken {
    constructor(address admin) BridgeToken("Bridge USDT", "USDT", 18, admin) {}
}
