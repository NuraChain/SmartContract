// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeTips} from "../ArcadeTips.sol";

interface Vm {
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
}

/**
 * Drives the contract through random sequences of gifts on behalf of the invariant runner: between
 * a few givers and a few players, under ids that are sometimes new and sometimes already spent,
 * with the pause turned on and off between them.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so the fuzzer
 * spends its budget on sequences that reach the contract. It mirrors what each player was given,
 * which is what the invariants compare the players' balances and the records against.
 */
contract TipsHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant PEOPLE = 4;

    ArcadeTips public immutable tips;
    address private immutable admin;

    address[PEOPLE] public givers;
    address[PEOPLE] public players;

    mapping(address player => uint256 amount) public given;

    uint256 public ghostGiven;

    uint256 public gifts;

    constructor(ArcadeTips tips_, address admin_) {
        tips = tips_;
        admin = admin_;
        for (uint256 i = 0; i < PEOPLE; ++i) {
            givers[i] = address(uint160(0x61F7000 + i));
            players[i] = address(uint160(0x9A7E000 + i));
        }
    }

    function tip(uint256 who, uint256 whom, uint256 idSeed, uint256 amountSeed) external {
        if (tips.paused()) return;

        address giver = givers[who % PEOPLE];
        address player = players[whom % PEOPLE];
        bytes32 id = keccak256(abi.encode("gift", idSeed % 16));
        (address used,,) = tips.tipOf(giver, id);
        if (used != address(0)) return;

        uint256 amount = 1 + (amountSeed % 1_000 ether);
        vm.deal(giver, giver.balance + amount);
        vm.prank(giver);
        tips.tip{value: amount}(id, player);

        given[player] += amount;
        ghostGiven += amount;
        gifts += 1;
    }

    function setPaused(bool paused) external {
        if (paused == tips.paused()) return;

        vm.prank(admin);
        if (paused) {
            tips.pause();
        } else {
            tips.unpause();
        }
    }
}

/**
 * Invariants over the gifts: whatever the sequence, the contract holds nothing, and every player
 * holds exactly what was given to them.
 */
contract TipsInvariantTest {
    address private constant ADMIN = address(0xAD);

    ArcadeTips private tips;
    TipsHandler private handler;

    function setUp() public {
        tips = new ArcadeTips(ADMIN);
        handler = new TipsHandler(tips, ADMIN);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_theContractHoldsNothing() public view {
        assert(address(tips).balance == 0);
    }

    function invariant_everyPlayerHoldsWhatTheyWereGiven() public view {
        uint256 held = 0;
        for (uint256 i = 0; i < handler.PEOPLE(); ++i) {
            address player = handler.players(i);
            assert(player.balance == handler.given(player));
            held += player.balance;
        }

        assert(held == handler.ghostGiven());
    }
}
