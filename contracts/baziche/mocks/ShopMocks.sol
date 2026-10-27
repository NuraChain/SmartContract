// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeShop} from "../ArcadeShop.sol";

/**
 * Counterparties for test/ArcadeShop.test.ts, and nothing else. None is deployed by
 * ignition/modules/bazicheshop.ts or probed by scripts/preflight.ts.
 *
 * `refund`, `withdraw` and `claim` pay with `Address.sendValue`, which forwards all remaining
 * gas, so a contract on the receiving end runs arbitrary code inside the payment. Those are the
 * only three places the shop hands control to someone else, and this is what stands in that
 * spot: a contract wallet that buys, brings buyers in, and on being paid either takes it,
 * refuses it, buys again or claims again.
 */
contract ShopActor {
    enum Mode {
        Take,
        Refuse,
        BuyAgain,
        ClaimAgain
    }

    ArcadeShop public immutable shop;

    Mode public mode;
    uint256 public receiveCount;
    bool public innerCallFailed;

    ArcadeShop.Quote private _next;
    bytes private _nextSignature;

    constructor(ArcadeShop shop_) {
        shop = shop_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @dev The quote `BuyAgain` pays from inside a payment. It must name this contract as buyer.
    function prepare(ArcadeShop.Quote calldata quote, bytes calldata signature) external payable {
        _next = quote;
        _nextSignature = signature;
    }

    function buy(ArcadeShop.Quote calldata quote, bytes calldata signature) external payable {
        shop.buy{value: msg.value}(quote, signature);
    }

    function claim() external {
        shop.claim();
    }

    receive() external payable {
        receiveCount += 1;

        Mode now_ = mode;
        if (now_ == Mode.Refuse) {
            revert("no thanks");
        }
        mode = Mode.Take;

        if (now_ == Mode.BuyAgain) {
            try shop.buy{value: _next.price}(_next, _nextSignature) {
                innerCallFailed = false;
            } catch {
                innerCallFailed = true;
            }
        } else if (now_ == Mode.ClaimAgain) {
            try shop.claim() {
                innerCallFailed = false;
            } catch {
                innerCallFailed = true;
            }
        }
    }
}
