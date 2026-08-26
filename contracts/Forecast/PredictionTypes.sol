// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title PredictionTypes
 * @notice Shared enums and structs for the prediction-market system. Kept in one file so the
 *         factory, the market clones, and every interface agree on a single ABI-stable shape.
 */

/**
 * @notice Which engine a registered market runs on.
 * - Amm:  CPMM {PredictionMarket} — tradeable outcome shares against virtual reserves.
 * - Pool: parimutuel {PredictionPool} — direct bets, winner takes the pool pro-rata net of fee.
 */
enum MarketKind {
    Amm,
    Pool
}

/**
 * @notice Lifecycle of a market.
 * - Open:     trading and liquidity are live (until lockTime).
 * - Paused:   temporarily halted by an admin; can return to Open.
 * - Closed:   permanently halted, awaiting resolution; no trading.
 * - Resolved: a winning outcome is set; winning shares redeem 1:1.
 * - Voided:   invalid resolution; every outcome pays an equal 1/n share (refund basis).
 */
enum MarketStatus {
    Open,
    Paused,
    Closed,
    Resolved,
    Voided
}

/**
 * @notice Immutable creation parameters passed from the factory into a market clone's
 *         initializer. `outcomeNames.length` defines the outcome count (2..MAX_OUTCOMES).
 * @dev Timestamps are uint64 (seconds); fees are basis points (1e4 = 100%).
 */
struct MarketParams {
    string title;
    string description;
    string category;
    string imageURI;
    address creator;
    uint64 lockTime;
    uint64 resolveTime;
    uint16 feeBps;
    uint16 protocolFeeShareBps;
    string[] outcomeNames;
}

/**
 * @notice Flat metadata snapshot the factory keeps per market so pagination and filtering
 *         never have to cross-call every clone.
 */
struct MarketRecord {
    address market;
    address creator;
    string title;
    string category;
    MarketStatus status;
    uint64 createdAt;
    uint64 lockTime;
    uint64 resolveTime;
    uint32 outcomeCount;
}
