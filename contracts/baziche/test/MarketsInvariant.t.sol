// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeMarkets} from "../ArcadeMarkets.sol";

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

/**
 * Drives the markets through random sequences on behalf of the invariant runner: positions with
 * real signatures from the operator's key on several outcomes of several markets, markets settled,
 * cancelled and expired, claims in any order, and fees withdrawn, so every path that moves the
 * contract's books is exercised.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so the
 * fuzzer spends its budget on sequences that reach the contract. It mirrors what came in and what
 * left, and remembers every position, which is what the invariants compare the contract's own
 * totals against.
 */
contract MarketsHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ACTORS = 4;

    ArcadeMarkets public immutable markets;
    uint256 private immutable operatorKey;
    address private immutable operator;
    address private immutable admin;

    address[ACTORS] public actors;

    ArcadeMarkets.Terms[] private opened;
    bytes32[] private placed;

    /// @notice Everything ever staked.
    uint256 public ghostIn;

    /// @notice Everything that ever left: claims and fees withdrawn.
    uint256 public ghostOut;

    constructor(ArcadeMarkets markets_, uint256 operatorKey_, address admin_) {
        markets = markets_;
        operatorKey = operatorKey_;
        operator = vm.addr(operatorKey_);
        admin = admin_;
        for (uint256 i = 0; i < ACTORS; ++i) {
            actors[i] = vm.addr(0xC0FFEE + i);
        }
    }

    function marketCount() external view returns (uint256) {
        return opened.length;
    }

    function marketAt(uint256 i) external view returns (bytes32) {
        return opened[i].market;
    }

    function placedCount() external view returns (uint256) {
        return placed.length;
    }

    function placedAt(uint256 i) external view returns (bytes32) {
        return placed[i];
    }

    // -------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------

    /// @notice Opens a market of 2 to 5 outcomes with a fee of up to 5%, taking positions for an hour.
    function open(uint256 outcomesSeed, uint256 feeSeed) external {
        if (opened.length >= 12) return;
        uint8 outcomes = uint8(2 + (outcomesSeed % 4));

        opened.push(ArcadeMarkets.Terms({
            market: keccak256(abi.encode("market", opened.length)),
            game: keccak256(abi.encode("game", opened.length)),
            outcomes: outcomes,
            closesAt: uint64(block.timestamp + 1 hours),
            feeBps: uint16(feeSeed % 501),
            maxStake: 500 ether,
            maxPerBettor: 1_000 ether,
            maxPool: 100_000 ether,
            minBettors: 2,
            minOutcomes: 2
        }));
    }

    function place(uint256 pick, uint256 who, uint256 outcomeSeed, uint256 amountSeed) external {
        if (opened.length == 0) return;
        ArcadeMarkets.Terms memory terms = opened[pick % opened.length];
        if (block.timestamp >= terms.closesAt) return;
        ArcadeMarkets.Market memory market = markets.marketOf(terms.market);
        if (market.state != ArcadeMarkets.State.None && market.state != ArcadeMarkets.State.Open) return;

        address bettor = actors[who % ACTORS];
        uint256 amount = 1 + (amountSeed % 500 ether);
        if (markets.stakedOf(terms.market, bettor) + amount > terms.maxPerBettor) return;
        if (market.pool + amount > terms.maxPool) return;

        ArcadeMarkets.Ticket memory ticket = ArcadeMarkets.Ticket({
            id: keccak256(abi.encode("ticket", placed.length)),
            market: terms.market,
            terms: markets.termsHash(terms),
            bettor: bettor,
            outcome: uint8(outcomeSeed % terms.outcomes),
            amount: amount,
            deadline: uint64(block.timestamp + 120)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorKey, markets.ticketDigest(ticket));

        vm.deal(bettor, bettor.balance + amount);
        vm.prank(bettor);
        markets.place{value: amount}(terms, ticket, abi.encodePacked(r, s, v));

        placed.push(ticket.id);
        ghostIn += amount;
    }

    /**
     * @notice Settles, cancels or expires a market, moving the clock past its close as needed, or
     *         overturns one settled in its dispute window, putting its fee back first if it went.
     */
    function resolve(uint256 pick, uint256 outcomeSeed, uint256 how) external {
        if (opened.length == 0) return;
        ArcadeMarkets.Terms memory terms = opened[pick % opened.length];
        ArcadeMarkets.Market memory market = markets.marketOf(terms.market);
        uint256 way = how % 4;

        if (way == 3) {
            if (market.state != ArcadeMarkets.State.Settled || block.timestamp >= market.claimableAt) return;
            uint256 fee = market.pool - market.left;
            uint256 fees = markets.fees();
            if (fee > fees) {
                vm.deal(admin, admin.balance + fee - fees);
                vm.prank(admin);
                markets.fund{value: fee - fees}();
                ghostIn += fee - fees;
            }
            vm.prank(admin);
            markets.overturn(terms.market);
            return;
        }

        if (market.state != ArcadeMarkets.State.Open) return;
        if (way == 0) {
            if (block.timestamp < terms.closesAt) vm.warp(terms.closesAt);
            vm.prank(operator);
            markets.settle(terms.market, uint8(outcomeSeed % terms.outcomes));
        } else if (way == 1) {
            vm.prank(operator);
            markets.cancel(terms.market);
        } else {
            uint256 at = uint256(terms.closesAt) + markets.EXPIRY();
            if (block.timestamp < at) vm.warp(at);
            markets.expire(terms.market);
        }
    }

    function claim(uint256 pick) external {
        if (placed.length == 0) return;
        bytes32 id = placed[pick % placed.length];
        uint256 owed = markets.payoutOf(id);
        if (owed == 0) return;

        (bytes32 key, address bettor,,,) = markets.positionOf(id);
        ArcadeMarkets.Market memory market = markets.marketOf(key);
        if (market.state == ArcadeMarkets.State.Settled && block.timestamp < market.claimableAt) vm.warp(market.claimableAt);
        bytes32[] memory tickets = new bytes32[](1);
        tickets[0] = id;
        vm.prank(bettor);
        markets.claim(tickets);
        ghostOut += owed;
    }

    function withdraw(uint256 amountSeed) external {
        uint256 fees = markets.fees();
        if (fees == 0) return;
        uint256 amount = 1 + (amountSeed % fees);

        vm.prank(admin);
        markets.withdrawFees(admin, amount);
        ghostOut += amount;
    }
}

/**
 * Invariants over the markets' money: whatever the sequence, the contract holds exactly what it
 * owes and its fees; what it owes is, market by market, every stake of an open market, what a
 * settled market still has to pay its winners, and every unclaimed stake of a market that refunds;
 * and what it holds is exactly what came in less what went out.
 */
contract MarketsInvariantTest {
    address private constant ADMIN = address(0xAD);
    uint256 private constant OPERATOR_KEY = 0x0BE7A702;

    ArcadeMarkets private markets;
    MarketsHandler private handler;

    function setUp() public {
        Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
        markets = new ArcadeMarkets(ADMIN, vm.addr(OPERATOR_KEY), 15 minutes);
        handler = new MarketsHandler(markets, OPERATOR_KEY, ADMIN);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_itHoldsEveryWeiItOwesAndItsFees() public view {
        assert(address(markets).balance == markets.owed() + markets.fees());
        assert(markets.solvent());
    }

    function invariant_whatItOwesIsEachMarketsDue() public view {
        uint256 due = 0;
        for (uint256 m = 0; m < handler.marketCount(); ++m) {
            bytes32 key = handler.marketAt(m);
            ArcadeMarkets.Market memory market = markets.marketOf(key);
            if (market.state == ArcadeMarkets.State.Open) {
                due += market.pool;
            } else if (market.state == ArcadeMarkets.State.Settled) {
                due += market.left;
            } else if (market.state != ArcadeMarkets.State.None) {
                for (uint256 p = 0; p < handler.placedCount(); ++p) {
                    (bytes32 inMarket,,, uint256 amount, bool claimed) = markets.positionOf(handler.placedAt(p));
                    if (inMarket == key && !claimed) due += amount;
                }
            }
        }

        assert(due == markets.owed());
    }

    function invariant_whatItHoldsIsWhatCameInLessWhatLeft() public view {
        assert(address(markets).balance == handler.ghostIn() - handler.ghostOut());
    }
}
