// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeMarkets} from "../ArcadeMarkets.sol";

/**
 * Counterparties for test/ArcadeMarkets.test.ts, and nothing else. None is deployed by
 * ignition/modules/bazichemarkets.ts or probed by scripts/preflight.ts.
 *
 * `claim` and `withdrawFees` pay with `Address.sendValue`, which forwards all remaining gas, so a
 * contract on the receiving end runs arbitrary code inside the payment. Those are the only two
 * places the markets hand control to someone else, and this is what stands in that spot: a
 * contract wallet that bets, and on being paid either takes it, refuses it, claims again or
 * places again.
 */
contract MarketsActor {
    enum Mode {
        Take,
        Refuse,
        ClaimAgain,
        PlaceAgain
    }

    ArcadeMarkets public immutable markets;

    Mode public mode;
    uint256 public receiveCount;
    bool public innerCallFailed;

    bytes32[] private _again;
    ArcadeMarkets.Terms private _terms;
    ArcadeMarkets.Ticket private _ticket;
    bytes private _signature;

    constructor(ArcadeMarkets markets_) {
        markets = markets_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @dev The positions `ClaimAgain` claims from inside a payment.
    function prepareClaim(bytes32[] calldata tickets) external {
        _again = tickets;
    }

    /// @dev The position `PlaceAgain` places from inside a payment. It must name this contract as bettor.
    function preparePlace(ArcadeMarkets.Terms calldata terms, ArcadeMarkets.Ticket calldata ticket, bytes calldata signature) external payable {
        _terms = terms;
        _ticket = ticket;
        _signature = signature;
    }

    function place(ArcadeMarkets.Terms calldata terms, ArcadeMarkets.Ticket calldata ticket, bytes calldata signature) external payable {
        markets.place{value: msg.value}(terms, ticket, signature);
    }

    function claim(bytes32[] calldata tickets) external {
        markets.claim(tickets);
    }

    receive() external payable {
        receiveCount += 1;

        Mode now_ = mode;
        if (now_ == Mode.Refuse) {
            revert("no thanks");
        }
        mode = Mode.Take;

        if (now_ == Mode.ClaimAgain) {
            try markets.claim(_again) {
                innerCallFailed = false;
            } catch {
                innerCallFailed = true;
            }
        } else if (now_ == Mode.PlaceAgain) {
            try markets.place{value: _ticket.amount}(_terms, _ticket, _signature) {
                innerCallFailed = false;
            } catch {
                innerCallFailed = true;
            }
        }
    }
}
