// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeTips} from "../ArcadeTips.sol";

/**
 * Property tests for ArcadeTips, run by `npx hardhat test solidity`.
 *
 * test/ArcadeTips.test.ts pins the behaviour at chosen inputs. These say the same things for
 * inputs nobody chose: whatever the amount, the id and the player, a gift reaches its player to
 * the wei and the contract keeps none of it; a giver pays an id once, and the same id from
 * another giver is that giver's own.
 *
 * @dev Cheatcodes are reached through the hevm address directly rather than through forge-std,
 *      which this repo does not depend on. Hardhat 3 runs these natively.
 */
interface Vm {
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata revertData) external;
}

contract TipsFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xAD);
    address private constant GIVER = address(0x61FE7);
    address private constant OTHER = address(0x07E7);
    uint64 private constant LATER = type(uint64).max;

    ArcadeTips private tips;

    function setUp() public {
        tips = new ArcadeTips(ADMIN);
    }

    /// A plain account the seed picks: hashed, so it is neither a precompile nor anything deployed here.
    function _player(bytes32 seed) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("player", seed)))));
    }

    function testFuzz_aGiftReachesItsPlayerToTheWei(bytes32 id, uint128 amountSeed, bytes32 playerSeed) public {
        address player = _player(playerSeed);
        uint256 amount = uint256(amountSeed) + 1;
        uint256 before = player.balance;

        vm.deal(GIVER, amount);
        vm.prank(GIVER);
        tips.tip{value: amount}(id, player, LATER);

        (address to, uint256 recorded, uint64 givenAt) = tips.tipOf(GIVER, id);
        assert(player.balance == before + amount);
        assert(GIVER.balance == 0);
        assert(address(tips).balance == 0);
        assert(to == player && recorded == amount && givenAt == block.timestamp);
    }

    function testFuzz_aGiverPaysAnIdOnceAndAnotherGiverTheirOwn(
        bytes32 id,
        uint128 firstSeed,
        uint128 secondSeed,
        bytes32 playerSeed
    ) public {
        address player = _player(playerSeed);
        uint256 first = uint256(firstSeed) + 1;
        uint256 second = uint256(secondSeed) + 1;

        vm.deal(GIVER, first + second);
        vm.prank(GIVER);
        tips.tip{value: first}(id, player, LATER);

        vm.expectRevert(abi.encodeWithSelector(ArcadeTips.TipUsed.selector, GIVER, id));
        vm.prank(GIVER);
        tips.tip{value: second}(id, player, LATER);

        vm.deal(OTHER, second);
        vm.prank(OTHER);
        tips.tip{value: second}(id, player, LATER);

        (, uint256 mine,) = tips.tipOf(GIVER, id);
        (, uint256 theirs,) = tips.tipOf(OTHER, id);
        assert(mine == first && theirs == second);
        assert(GIVER.balance == second);
        assert(address(tips).balance == 0);
    }

    function testFuzz_aCallPastItsDeadlineIsRefused(bytes32 id, uint128 amountSeed, uint32 pastSeed) public {
        uint256 amount = uint256(amountSeed) + 1;
        uint64 deadline = uint64(block.timestamp) - (uint64(pastSeed) % uint64(block.timestamp)) - 1;
        vm.deal(GIVER, amount);

        vm.expectRevert(abi.encodeWithSelector(ArcadeTips.TipExpired.selector, GIVER, id, deadline));
        vm.prank(GIVER);
        tips.tip{value: amount}(id, _player(id), deadline);

        (address to,,) = tips.tipOf(GIVER, id);
        assert(to == address(0));
        assert(GIVER.balance == amount);
    }

    function testFuzz_nothingIsGivenToNobodyOrToOneself(bytes32 id, uint128 amountSeed) public {
        uint256 amount = uint256(amountSeed) + 1;
        vm.deal(GIVER, amount);

        vm.expectRevert(abi.encodeWithSelector(ArcadeTips.ZeroAddress.selector));
        vm.prank(GIVER);
        tips.tip{value: amount}(id, address(0), LATER);

        vm.expectRevert(abi.encodeWithSelector(ArcadeTips.SelfTip.selector));
        vm.prank(GIVER);
        tips.tip{value: amount}(id, GIVER, LATER);

        (address to,,) = tips.tipOf(GIVER, id);
        assert(to == address(0));
        assert(GIVER.balance == amount);
    }
}
