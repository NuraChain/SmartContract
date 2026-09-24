// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeToken} from "./BridgeToken.sol";

/**
 * @title BridgeBTC
 * @notice Bridged representation of BTC.
 * @dev 18 decimals, matching BTCB on BNB Chain. Native Bitcoin and WBTC use 8 decimals
 *      instead — if you bridge from either of those, the off-chain relayer must scale
 *      amounts by 1e10 when it mints here.
 */
contract BridgeBTC is BridgeToken {
    constructor(address admin) BridgeToken("Bridge BTC", "BTC", 18, admin) {}
}
