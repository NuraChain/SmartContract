// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IPredictionMarket } from "../interfaces/IPredictionMarket.sol";

/**
 * @title ReentrantBuyer
 * @notice Test-only attacker: buys shares, then tries to re-enter {PredictionMarket-redeem}
 *         from its ERC-1155 receive hook and from the native-transfer callback. Used to prove
 *         the market's guard and checks-effects-interactions ordering hold.
 * @dev Never deploy this outside tests.
 */
contract ReentrantBuyer {
    /// @notice The market under attack.
    IPredictionMarket public market;

    /// @notice When true, the receive hook attempts the reentrant call.
    bool public armed;

    /// @notice Set by the test to observe whether the nested call reverted.
    bool public reenteredSuccessfully;

    /**
     * @param market_ The market to attack.
     */
    constructor(address market_) {
        market = IPredictionMarket(market_);
    }

    /// @notice Funds the attacker.
    receive() external payable {
        if (armed) {
            armed = false;
            // A successful nested redeem would mean the guard failed.
            try market.redeem() {
                reenteredSuccessfully = true;
            } catch {
                reenteredSuccessfully = false;
            }
        }
    }

    /**
     * @notice Buys `outcomeIndex` with the attached value.
     * @param outcomeIndex Outcome to buy.
     */
    function attackBuy(uint256 outcomeIndex) external payable {
        market.buy{ value: msg.value }(outcomeIndex, 0, type(uint256).max);
    }

    /**
     * @notice Arms the reentrancy attempt, then redeems - the payout transfer hits {receive}.
     */
    function attackRedeem() external {
        armed = true;
        market.redeem();
    }

    /**
     * @notice Sells shares; the payout transfer hits {receive} while the market is mid-call.
     * @param outcomeIndex Outcome to sell.
     * @param returnAmount Net collateral requested.
     */
    function attackSell(uint256 outcomeIndex, uint256 returnAmount) external {
        armed = true;
        market.sell(outcomeIndex, returnAmount, type(uint256).max, type(uint256).max);
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
