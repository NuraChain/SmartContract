// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeMarkets} from "../ArcadeMarkets.sol";

/**
 * Property tests for ArcadeMarkets, run by `npx hardhat test solidity`.
 *
 * test/ArcadeMarkets.test.ts pins the behaviour at chosen inputs. These say the same things for
 * inputs nobody chose: whatever the stakes and the fee, the backers of the outcome that happened
 * share the pool less the fee to the wei, each paid at least its share and the last the exact
 * remainder; a market that refunds gives every stake back whole; a ticket signed by anybody but the
 * operator, or placed with anything but its amount, is refused.
 *
 * @dev Cheatcodes are reached through the hevm address directly rather than through
 *      forge-std, which this repo does not depend on. Hardhat 3 runs these natively.
 */
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes calldata revertData) external;
}

contract MarketsFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xAD);
    uint256 private constant OPERATOR_KEY = 0x0BE7A702;
    uint256 private constant BETTOR_KEY = 0xB0B;
    uint256 private constant BPS = 10_000;
    uint256 private constant CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    ArcadeMarkets private markets;
    address private operator;

    function setUp() public {
        operator = vm.addr(OPERATOR_KEY);
        markets = new ArcadeMarkets(ADMIN, operator, 0);
    }

    // -------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------

    function _bettor(uint256 i) private pure returns (address) {
        return vm.addr(BETTOR_KEY + i);
    }

    function _terms(bytes32 market, uint8 outcomes, uint16 feeBps) private view returns (ArcadeMarkets.Terms memory) {
        return ArcadeMarkets.Terms({
            market: market,
            game: keccak256(abi.encode("game", market)),
            outcomes: outcomes,
            closesAt: uint64(block.timestamp + 90),
            feeBps: feeBps,
            maxStake: type(uint128).max,
            maxPerBettor: type(uint128).max,
            maxPool: type(uint128).max,
            minBettors: 2,
            minOutcomes: 2
        });
    }

    function _ticket(ArcadeMarkets.Terms memory terms, uint256 who, uint8 outcome, uint256 amount)
        private
        view
        returns (ArcadeMarkets.Ticket memory)
    {
        return ArcadeMarkets.Ticket({
            id: keccak256(abi.encode("ticket", terms.market, who, outcome, amount)),
            market: terms.market,
            terms: markets.termsHash(terms),
            bettor: _bettor(who),
            outcome: outcome,
            amount: amount,
            deadline: uint64(block.timestamp + 120)
        });
    }

    function _sign(uint256 key, ArcadeMarkets.Ticket memory ticket) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, markets.ticketDigest(ticket));
        return abi.encodePacked(r, s, v);
    }

    function _place(ArcadeMarkets.Terms memory terms, uint256 who, uint8 outcome, uint256 amount) private returns (bytes32) {
        ArcadeMarkets.Ticket memory ticket = _ticket(terms, who, outcome, amount);
        bytes memory signature = _sign(OPERATOR_KEY, ticket);
        address bettor = _bettor(who);
        vm.deal(bettor, amount);
        vm.prank(bettor);
        markets.place{value: amount}(terms, ticket, signature);
        return ticket.id;
    }

    function _claim(uint256 who, bytes32 ticket) private returns (uint256 paid) {
        bytes32[] memory tickets = new bytes32[](1);
        tickets[0] = ticket;
        address bettor = _bettor(who);
        uint256 before = bettor.balance;
        vm.prank(bettor);
        markets.claim(tickets);
        paid = bettor.balance - before;
    }

    // -------------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------------

    function testFuzz_winnersShareThePoolToTheWei(uint64[6] memory stakeSeeds, uint8 winnerSeed, uint16 feeSeed, bool laterFirst) public {
        uint16 bps = uint16(uint256(feeSeed) % 501);
        ArcadeMarkets.Terms memory terms = _terms(keccak256("share"), 3, bps);
        uint256[6] memory stakes;
        bytes32[6] memory ids;
        uint256 pool = 0;
        for (uint256 i = 0; i < 6; ++i) {
            stakes[i] = 1 + (uint256(stakeSeeds[i]) % 1e24);
            ids[i] = _place(terms, i, uint8(i % 3), stakes[i]);
            pool += stakes[i];
        }

        uint8 winner = winnerSeed % 3;
        vm.warp(terms.closesAt);
        vm.prank(operator);
        markets.settle(terms.market, winner);

        uint256 fee = (pool * bps) / BPS;
        uint256 left = pool - fee;
        uint256 backing = stakes[winner] + stakes[winner + 3];
        uint256 first = laterFirst ? winner + 3 : winner;
        uint256 second = laterFirst ? winner : winner + 3;

        uint256 paidFirst = _claim(first, ids[first]);
        uint256 paidSecond = _claim(second, ids[second]);

        assert(paidFirst == (left * stakes[first]) / backing);
        assert(paidSecond >= (left * stakes[second]) / backing);
        assert(paidFirst + paidSecond == left);
        assert(markets.fees() == fee);
        assert(markets.owed() == 0);
        assert(address(markets).balance == fee);
    }

    function testFuzz_aMarketThatRefundsGivesEveryStakeBack(uint64[4] memory stakeSeeds, uint8 how, uint16 feeSeed) public {
        ArcadeMarkets.Terms memory terms = _terms(keccak256("refund"), 3, uint16(uint256(feeSeed) % 501));
        uint256[4] memory stakes;
        bytes32[4] memory ids;
        for (uint256 i = 0; i < 4; ++i) {
            stakes[i] = 1 + (uint256(stakeSeeds[i]) % 1e24);
            ids[i] = _place(terms, i, uint8(i % 2), stakes[i]);
        }

        uint8 way = how % 3;
        if (way == 0) {
            vm.prank(operator);
            markets.cancel(terms.market);
        } else if (way == 1) {
            vm.warp(uint256(terms.closesAt) + markets.EXPIRY());
            markets.expire(terms.market);
        } else {
            // Nobody backed outcome 2.
            vm.warp(terms.closesAt);
            vm.prank(operator);
            markets.settle(terms.market, 2);
        }

        for (uint256 i = 0; i < 4; ++i) {
            assert(_claim(i, ids[i]) == stakes[i]);
        }
        assert(markets.fees() == 0);
        assert(markets.owed() == 0);
        assert(address(markets).balance == 0);
    }

    function testFuzz_aTicketSignedByAnybodyButTheOperatorIsRefused(uint256 keySeed) public {
        uint256 key = 1 + (keySeed % (CURVE_ORDER - 1));
        if (key == OPERATOR_KEY) key += 1;
        ArcadeMarkets.Terms memory terms = _terms(keccak256("forged"), 2, 0);
        ArcadeMarkets.Ticket memory ticket = _ticket(terms, 0, 0, 1 ether);
        bytes memory signature = _sign(key, ticket);
        vm.deal(ticket.bettor, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(ArcadeMarkets.InvalidSignature.selector, ticket.id));
        vm.prank(ticket.bettor);
        markets.place{value: 1 ether}(terms, ticket, signature);
    }

    function testFuzz_anyAmountButTheTicketsIsRefused(uint128 amountSeed, uint128 sentSeed) public {
        uint256 amount = 1 + (uint256(amountSeed) % 1e30);
        uint256 sent = uint256(sentSeed) % 1e30;
        if (sent == amount) sent += 1;
        ArcadeMarkets.Terms memory terms = _terms(keccak256("wrong amount"), 2, 0);
        ArcadeMarkets.Ticket memory ticket = _ticket(terms, 0, 0, amount);
        bytes memory signature = _sign(OPERATOR_KEY, ticket);
        vm.deal(ticket.bettor, sent);

        vm.expectRevert(abi.encodeWithSelector(ArcadeMarkets.WrongAmount.selector, ticket.id, amount, sent));
        vm.prank(ticket.bettor);
        markets.place{value: sent}(terms, ticket, signature);
    }
}
