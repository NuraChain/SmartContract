// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IPredictionMarket } from "../interfaces/IPredictionMarket.sol";
import { IPredictionPool } from "../interfaces/IPredictionPool.sol";

/**
 * @title PayoutRejector
 * @notice Test-only participant that refuses every native transfer, so an automatic payout
 *         pushed to it always fails. Used to prove that one undeliverable recipient becomes a
 *         pullable credit instead of stalling the batch behind it. Works against either
 *         engine: {betPool} for the parimutuel pool, {buyMarket} for the CPMM.
 * @dev Never deploy this outside tests.
 */
contract PayoutRejector {
    /// @notice The market or pool being participated in.
    address public subject;

    /// @notice When false, incoming native transfers revert.
    bool public accepting;

    /**
     * @param target_ The market or pool to participate in.
     */
    constructor(address target_) {
        subject = target_;
    }

    /// @notice Refuses payouts until the test flips {accepting}.
    receive() external payable {
        require(accepting, "no");
    }

    /// @notice Starts accepting native transfers, so the credit can be pulled.
    function startAccepting() external {
        accepting = true;
    }

    /**
     * @notice Bets the attached value on `outcomeIndex` of a pool market.
     * @param outcomeIndex Outcome to back.
     */
    function betPool(uint256 outcomeIndex) external payable {
        IPredictionPool(subject).bet{ value: msg.value }(outcomeIndex);
    }

    /**
     * @notice Buys `outcomeIndex` shares of a CPMM market with the attached value.
     * @param outcomeIndex Outcome to buy.
     */
    function buyMarket(uint256 outcomeIndex) external payable {
        IPredictionMarket(subject).buy{ value: msg.value }(outcomeIndex, 0, type(uint256).max);
    }

    /// @notice Pulls the credit a failed pool push left behind.
    function claimPool() external returns (uint256) {
        return IPredictionPool(subject).claim();
    }

    /// @notice Pulls the credit a failed market push left behind.
    function redeemMarket() external returns (uint256) {
        return IPredictionMarket(subject).redeem();
    }

    /// @notice ERC-1155 single-transfer receiver hook.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /// @notice ERC-1155 batch-transfer receiver hook.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC-165 support for the ERC-1155 receiver interface.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0 || interfaceId == 0x01ffc9a7;
    }
}
