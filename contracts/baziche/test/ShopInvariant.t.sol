// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeShop} from "../ArcadeShop.sol";

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
}

/**
 * Drives the shop through random sequences on behalf of the invariant runner: sales with real
 * signatures from the seller's key, some with an inviter, refunds before and after the inviter
 * claimed, claims, withdrawals, top-ups and the inviters' share moved between sales, so every
 * path that moves the shop's books is exercised.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so the
 * fuzzer spends its budget on sequences that reach the shop. It mirrors what was sold and what
 * left, which is what the invariants compare the shop's own totals against.
 */
contract ShopHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ACTORS = 4;

    ArcadeShop public immutable shop;
    uint256 private immutable sellerKey;
    address private immutable admin;

    uint256[ACTORS] private keys;
    address[ACTORS] public actors;

    bytes32[] private sold;

    /// @notice Everything ever paid into the shop by sales and top-ups.
    uint256 public ghostIn;

    /// @notice Everything that ever left it: refunds, claims and withdrawals.
    uint256 public ghostOut;

    /// @notice How many sales were made, which also names the next order.
    uint256 public sales;

    constructor(ArcadeShop shop_, uint256 sellerKey_, address admin_) {
        shop = shop_;
        sellerKey = sellerKey_;
        admin = admin_;
        for (uint256 i = 0; i < ACTORS; ++i) {
            keys[i] = 0xC0FFEE + i;
            actors[i] = vm.addr(keys[i]);
        }
    }

    function soldCount() external view returns (uint256) {
        return sold.length;
    }

    // -------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------

    function buy(uint256 who, uint256 inviter, uint256 priceSeed) external {
        address buyer = actors[who % ACTORS];
        // The inviter is another actor, the buyer themselves (which the shop ignores) or nobody.
        uint256 pick = inviter % (ACTORS + 1);
        address referrer = pick == ACTORS ? address(0) : actors[pick];
        uint256 price = 1 + (priceSeed % 1_000 ether);

        ArcadeShop.Quote memory quote = ArcadeShop.Quote({
            order: keccak256(abi.encode("order", sales)),
            buyer: buyer,
            item: keccak256(abi.encode("item", priceSeed % 7)),
            price: price,
            referrer: referrer,
            deadline: uint64(block.timestamp + 1800)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, shop.quoteDigest(quote));

        vm.deal(buyer, buyer.balance + price);
        vm.prank(buyer);
        shop.buy{value: price}(quote, abi.encodePacked(r, s, v));

        sold.push(quote.order);
        sales += 1;
        ghostIn += price;
    }

    function refund(uint256 pick) external {
        if (sold.length == 0) return;
        bytes32 order = sold[pick % sold.length];
        (, , bool refunded, address referrer, uint256 price, uint256 cut) = shop.saleOf(order);
        if (refunded) return;

        uint256 unclaimed = shop.earnings(referrer);
        uint256 back = cut < unclaimed ? cut : unclaimed;
        uint256 owed = price - back;
        if (owed > shop.revenue()) {
            uint256 topUp = owed - shop.revenue();
            vm.deal(admin, admin.balance + topUp);
            vm.prank(admin);
            shop.fund{value: topUp}();
            ghostIn += topUp;
        }

        vm.prank(admin);
        shop.refund(order);
        ghostOut += price;
    }

    function claim(uint256 who) external {
        address referrer = actors[who % ACTORS];
        uint256 amount = shop.earnings(referrer);
        if (amount == 0) return;

        vm.prank(referrer);
        shop.claim();
        ghostOut += amount;
    }

    function withdraw(uint256 amountSeed) external {
        uint256 revenue = shop.revenue();
        if (revenue == 0) return;
        uint256 amount = 1 + (amountSeed % revenue);

        vm.prank(admin);
        shop.withdraw(admin, amount);
        ghostOut += amount;
    }

    function setShare(uint256 seed) external {
        vm.prank(admin);
        shop.setReferralBps(uint16(seed % 3_001));
    }
}

/**
 * Invariants over the shop's money: whatever the sequence, it holds exactly its revenue and
 * every inviter's unclaimed credit; the credits add up to its own total; and what it holds is
 * exactly what came in less what went out.
 */
contract ShopInvariantTest {
    address private constant ADMIN = address(0xAD);
    uint256 private constant SELLER_KEY = 0x5E11E2;

    ArcadeShop private shop;
    ShopHandler private handler;

    function setUp() public {
        Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
        shop = new ArcadeShop(ADMIN, vm.addr(SELLER_KEY), 1_000);
        handler = new ShopHandler(shop, SELLER_KEY, ADMIN);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_theShopHoldsEveryWeiItOwes() public view {
        assert(address(shop).balance == shop.revenue() + shop.totalEarnings());
        assert(shop.solvent());
    }

    function invariant_creditsAddUpToTheTotal() public view {
        uint256 credited = 0;
        for (uint256 i = 0; i < handler.ACTORS(); ++i) {
            credited += shop.earnings(handler.actors(i));
        }

        assert(credited == shop.totalEarnings());
    }

    function invariant_whatItHoldsIsWhatCameInLessWhatLeft() public view {
        assert(address(shop).balance == handler.ghostIn() - handler.ghostOut());
    }
}
