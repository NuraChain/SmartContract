// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeShop} from "../ArcadeShop.sol";

/**
 * Property tests for ArcadeShop, run by `npx hardhat test solidity`.
 *
 * test/ArcadeShop.test.ts pins the behaviour at chosen inputs. These say the same things for
 * inputs nobody chose: whatever the price and the inviters' share, a sale splits its price
 * between revenue and the inviter to the wei; a refund gives the whole price back and the shop
 * still holds every wei it owes; a quote signed by anybody but the seller, or paid with anything
 * but its price, is refused.
 *
 * @dev Cheatcodes are reached through the hevm address directly rather than through
 *      forge-std, which this repo does not depend on. Hardhat 3 runs these natively.
 */
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata revertData) external;
}

contract ShopFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xAD);
    uint256 private constant SELLER_KEY = 0x5E11E2;
    uint256 private constant BUYER_KEY = 0xB0B;
    address private constant INVITER = address(0x1417E);
    uint256 private constant BPS = 10_000;
    uint256 private constant CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    ArcadeShop private shop;
    address private buyer;

    function setUp() public {
        shop = new ArcadeShop(ADMIN, vm.addr(SELLER_KEY), 1_000);
        buyer = vm.addr(BUYER_KEY);
    }

    // -------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------

    function _quote(bytes32 order, uint256 price, address referrer) private view returns (ArcadeShop.Quote memory) {
        return ArcadeShop.Quote({
            order: order,
            buyer: buyer,
            item: keccak256("item"),
            price: price,
            referrer: referrer,
            deadline: uint64(block.timestamp + 1800)
        });
    }

    function _sign(uint256 key, ArcadeShop.Quote memory quote) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, shop.quoteDigest(quote));
        return abi.encodePacked(r, s, v);
    }

    function _buy(ArcadeShop.Quote memory quote) private {
        bytes memory signature = _sign(SELLER_KEY, quote);
        vm.deal(buyer, quote.price);
        vm.prank(buyer);
        shop.buy{value: quote.price}(quote, signature);
    }

    function _setShare(uint16 bps) private {
        vm.prank(ADMIN);
        shop.setReferralBps(bps);
    }

    // -------------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------------

    function testFuzz_aSaleSplitsItsPriceToTheWei(uint128 priceSeed, uint16 shareSeed, bool invited) public {
        uint256 price = 1 + (uint256(priceSeed) % 1e30);
        uint16 bps = uint16(uint256(shareSeed) % 3_001);
        address referrer = invited ? INVITER : address(0);
        _setShare(bps);

        _buy(_quote(keccak256("split"), price, referrer));

        uint256 cut = invited ? (price * bps) / BPS : 0;
        assert(shop.earnings(INVITER) == cut);
        assert(shop.revenue() == price - cut);
        assert(shop.revenue() + shop.totalEarnings() == price);
        assert(address(shop).balance == price);
        assert(buyer.balance == 0);
    }

    function testFuzz_aRefundGivesTheWholePriceBack(uint128 priceSeed, uint16 shareSeed, bool claimedFirst) public {
        uint256 price = 1 + (uint256(priceSeed) % 1e30);
        uint16 bps = uint16(uint256(shareSeed) % 3_001);
        bytes32 order = keccak256("refund");
        _setShare(bps);
        _buy(_quote(order, price, INVITER));

        uint256 cut = (price * bps) / BPS;
        if (claimedFirst && cut != 0) {
            vm.prank(INVITER);
            shop.claim();
            // What the inviter took out has to come back in before the buyer can be paid whole.
            vm.deal(ADMIN, cut);
            vm.prank(ADMIN);
            shop.fund{value: cut}();
        }

        vm.prank(ADMIN);
        shop.refund(order);

        assert(buyer.balance == price);
        assert(shop.earnings(INVITER) == 0);
        assert(shop.revenue() == 0);
        assert(address(shop).balance == shop.revenue() + shop.totalEarnings());
        (,, bool refunded,,,) = shop.saleOf(order);
        assert(refunded);
    }

    function testFuzz_aQuoteSignedByAnybodyButTheSellerIsRefused(uint256 keySeed) public {
        uint256 key = 1 + (keySeed % (CURVE_ORDER - 1));
        if (key == SELLER_KEY) key += 1;
        ArcadeShop.Quote memory quote = _quote(keccak256("forged"), 1 ether, address(0));
        bytes memory signature = _sign(key, quote);
        vm.deal(buyer, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(ArcadeShop.InvalidSignature.selector, quote.order));
        vm.prank(buyer);
        shop.buy{value: 1 ether}(quote, signature);
    }

    function testFuzz_anyAmountButThePriceIsRefused(uint128 priceSeed, uint128 sentSeed) public {
        uint256 price = 1 + (uint256(priceSeed) % 1e30);
        uint256 sent = uint256(sentSeed) % 1e30;
        if (sent == price) sent += 1;
        ArcadeShop.Quote memory quote = _quote(keccak256("wrong amount"), price, address(0));
        bytes memory signature = _sign(SELLER_KEY, quote);
        vm.deal(buyer, sent);

        vm.expectRevert(abi.encodeWithSelector(ArcadeShop.WrongPrice.selector, quote.order, price, sent));
        vm.prank(buyer);
        shop.buy{value: sent}(quote, signature);
    }
}
