// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeVault} from "../ArcadeVault.sol";

/**
 * Property tests for ArcadeVault, run by `npx hardhat test solidity`.
 *
 * test/ArcadeVault.test.ts pins the behaviour at chosen inputs. These say the same things for
 * inputs nobody chose: whatever the stake, the fee, the number of players and who wins, a pot
 * is paid out to the last wei and the vault still holds every wei it owes; a refund gives back
 * exactly what was staked; and a stake signed by anybody but its player is refused.
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

contract VaultFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xAD);
    address private constant REFEREE = address(0x12EF);
    uint256 private constant BPS = 10_000;

    ArcadeVault private vault;
    uint256[9] private keys;
    address[9] private players;

    function setUp() public {
        vault = new ArcadeVault(ADMIN, REFEREE, 500, type(uint128).max, 3 days);
        for (uint256 i = 0; i < 9; ++i) {
            keys[i] = 0xA11CE + i;
            players[i] = vm.addr(keys[i]);
        }
    }

    // -------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------

    function _secret(uint256 seat, bytes32 label) private pure returns (bytes32) {
        return keccak256(abi.encode("secret", seat, label));
    }

    /// @dev Seat `seat`'s stake, signed with `key`, which is that player's own unless a test says otherwise.
    function _seat(uint256 seat, uint256 key, uint256 amount, uint16 feeBps, bytes32 label)
        private
        view
        returns (ArcadeVault.Seat memory)
    {
        bytes32 commit = keccak256(abi.encode(_secret(seat, label)));
        bytes32 nonce = keccak256(abi.encode("nonce", seat, label));
        uint64 deadline = uint64(block.timestamp + 1800);
        bytes32 digest = vault.stakeDigest(players[seat], "ludo", amount, feeBps, commit, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        return ArcadeVault.Seat({
            player: players[seat],
            commit: commit,
            nonce: nonce,
            deadline: deadline,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _fund(uint256 count, uint256 amount) private {
        for (uint256 i = 0; i < count; ++i) {
            vm.deal(players[i], amount);
            vm.prank(players[i]);
            vault.deposit{value: amount}();
        }
    }

    function _open(bytes32 id, uint256 count, uint256 amount, uint16 feeBps) private returns (bytes32[] memory secrets) {
        ArcadeVault.Seat[] memory seats = new ArcadeVault.Seat[](count);
        secrets = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            seats[i] = _seat(i, keys[i], amount, feeBps, id);
            secrets[i] = _secret(i, id);
        }

        vm.prank(REFEREE);
        vault.open(id, "ludo", amount, feeBps, seats);
    }

    function _bits(uint256 mask) private pure returns (uint256 count) {
        while (mask != 0) {
            count += mask & 1;
            mask >>= 1;
        }
    }

    // -------------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------------

    function testFuzz_settlePaysThePotToTheLastWei(uint96 amountSeed, uint8 countSeed, uint16 feeSeed, uint16 maskSeed)
        public
    {
        uint256 count = 2 + (uint256(countSeed) % 8);
        uint256 amount = 1 + (uint256(amountSeed) % 1e24);
        uint16 feeBps = uint16(uint256(feeSeed) % 1001);
        uint256 winners = 1 + (uint256(maskSeed) % ((1 << count) - 1));
        bytes32 id = keccak256("fuzz");

        vm.prank(ADMIN);
        vault.setFee(feeBps);
        _fund(count, amount);
        bytes32[] memory secrets = _open(id, count, amount, feeBps);

        vm.prank(REFEREE);
        vault.settle(id, winners, secrets);

        uint256 pot = amount * count;
        uint256 share = (pot - (pot * feeBps) / BPS) / _bits(winners);
        uint256 paid = 0;
        for (uint256 i = 0; i < count; ++i) {
            uint256 held = vault.balanceOf(players[i]);
            if ((winners >> i) & 1 == 1) {
                assert(held == share);
                paid += held;
            } else {
                assert(held == 0);
            }
            assert(vault.lockedOf(players[i]) == 0);
        }

        assert(paid + vault.fees() == pot);
        assert(vault.fees() >= (pot * feeBps) / BPS);
        assert(vault.fees() - (pot * feeBps) / BPS < _bits(winners));
        assert(vault.totalLocked() == 0);
        assert(address(vault).balance == vault.totalBalances() + vault.fees());
    }

    function testFuzz_refundGivesBackExactlyWhatWasStaked(uint96 amountSeed, uint8 countSeed, uint96 extraSeed) public {
        uint256 count = 2 + (uint256(countSeed) % 8);
        uint256 amount = 1 + (uint256(amountSeed) % 1e24);
        uint256 extra = uint256(extraSeed) % 1e24;
        bytes32 id = keccak256("refund");

        _fund(count, amount + extra);
        _open(id, count, amount, 500);

        vm.prank(REFEREE);
        vault.refund(id);

        for (uint256 i = 0; i < count; ++i) {
            assert(vault.balanceOf(players[i]) == amount + extra);
            assert(vault.lockedOf(players[i]) == 0);
        }
        assert(vault.fees() == 0);
        assert(vault.totalLocked() == 0);
        assert(address(vault).balance == vault.totalBalances());
    }

    function testFuzz_aStakeSignedByAnybodyElseIsRefused(uint256 keySeed, uint8 seatSeed) public {
        uint256 seat = uint256(seatSeed) % 4;
        uint256 key = 1 + (keySeed % (type(uint128).max - 1));
        if (key == keys[seat]) key += 1;

        uint256 amount = 1 ether;
        bytes32 id = keccak256("forged");
        _fund(4, amount);

        ArcadeVault.Seat[] memory seats = new ArcadeVault.Seat[](4);
        for (uint256 i = 0; i < 4; ++i) {
            seats[i] = _seat(i, i == seat ? key : keys[i], amount, 500, id);
        }

        vm.expectRevert(abi.encodeWithSelector(ArcadeVault.InvalidSignature.selector, players[seat]));
        vm.prank(REFEREE);
        vault.open(id, "ludo", amount, 500, seats);
    }

    function testFuzz_settleRefusesAWrongSecret(bytes32 guess, uint8 seatSeed) public {
        uint256 seat = uint256(seatSeed) % 3;
        bytes32 id = keccak256("guess");
        _fund(3, 1 ether);
        bytes32[] memory secrets = _open(id, 3, 1 ether, 500);
        if (guess == secrets[seat]) guess = bytes32(uint256(guess) ^ 1);
        secrets[seat] = guess;

        vm.expectRevert(abi.encodeWithSelector(ArcadeVault.BadSecrets.selector));
        vm.prank(REFEREE);
        vault.settle(id, 1, secrets);
    }
}
