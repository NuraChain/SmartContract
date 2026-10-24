// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeVault} from "../ArcadeVault.sol";

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

/**
 * Drives the vault through random sequences on behalf of the invariant runner: deposits,
 * withdrawals, games opened with real signatures, games paid to random winners, refunded and
 * reclaimed, and the fee moved between games, so the bookkeeping is exercised under every
 * path that touches it.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so the
 * fuzzer spends its budget on sequences that reach the vault. It mirrors the stakes of every
 * game still open, which is what the invariants compare the vault's own totals against.
 */
contract VaultHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ACTORS = 5;

    ArcadeVault public immutable vault;
    address private immutable referee;
    address private immutable admin;

    uint256[ACTORS] private keys;
    address[ACTORS] public actors;

    bytes32[] private openIds;
    mapping(bytes32 id => bytes32[] secrets) private secretsOf;
    mapping(bytes32 id => uint256 pot) private potOf;

    /// @notice The stakes of every game still open, as the handler counts them.
    uint256 public ghostLocked;

    /// @notice How many games were ever opened, which also names the next one.
    uint256 public opened;

    constructor(ArcadeVault vault_, address referee_, address admin_) {
        vault = vault_;
        referee = referee_;
        admin = admin_;
        for (uint256 i = 0; i < ACTORS; ++i) {
            keys[i] = 0xBEEF + i;
            actors[i] = vm.addr(keys[i]);
        }
    }

    function openCount() external view returns (uint256) {
        return openIds.length;
    }

    // -------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------

    function deposit(uint256 who, uint256 amount) external {
        address actor = actors[who % ACTORS];
        amount = 1 + (amount % 100 ether);

        vm.deal(actor, actor.balance + amount);
        vm.prank(actor);
        vault.deposit{value: amount}();
    }

    function withdraw(uint256 who, uint256 amount) external {
        address actor = actors[who % ACTORS];
        uint256 available = vault.balanceOf(actor);
        if (available == 0) return;

        vm.prank(actor);
        vault.withdraw(1 + (amount % available));
    }

    function open(uint256 seed, uint256 amountSeed) external {
        uint256 count = 2 + (seed % (ACTORS - 1));
        uint256 amount = 1 + (amountSeed % 10 ether);
        uint16 feeBps = vault.fee();
        bytes32 id = keccak256(abi.encode("game", opened));

        ArcadeVault.Seat[] memory seats = new ArcadeVault.Seat[](count);
        bytes32[] memory secrets = new bytes32[](count);
        for (uint256 j = 0; j < count; ++j) {
            uint256 who = (seed + j) % ACTORS;
            if (vault.balanceOf(actors[who]) < amount) return;

            secrets[j] = keccak256(abi.encode(id, j));
            seats[j] = _seat(who, amount, feeBps, keccak256(abi.encode(secrets[j])), keccak256(abi.encode(id, "nonce", j)));
        }

        vm.prank(referee);
        vault.open(id, "ludo", amount, feeBps, seats);

        opened += 1;
        openIds.push(id);
        secretsOf[id] = secrets;
        potOf[id] = amount * count;
        ghostLocked += amount * count;
    }

    function settle(uint256 pick, uint256 maskSeed) external {
        if (openIds.length == 0) return;
        uint256 at = pick % openIds.length;
        bytes32 id = openIds[at];
        uint256 count = secretsOf[id].length;

        vm.prank(referee);
        vault.settle(id, 1 + (maskSeed % ((1 << count) - 1)), secretsOf[id]);
        _close(at, id);
    }

    function refund(uint256 pick) external {
        if (openIds.length == 0) return;
        uint256 at = pick % openIds.length;
        bytes32 id = openIds[at];

        vm.prank(referee);
        vault.refund(id);
        _close(at, id);
    }

    function reclaim(uint256 pick, uint256 who) external {
        if (openIds.length == 0) return;
        uint256 at = pick % openIds.length;
        bytes32 id = openIds[at];
        (, , uint64 openedAt, , ) = vault.gameOf(id);
        uint256 due = uint256(openedAt) + vault.reclaimAfter();
        if (block.timestamp < due) vm.warp(due);

        vm.prank(actors[who % ACTORS]);
        vault.reclaim(id);
        _close(at, id);
    }

    function setFee(uint256 seed) external {
        vm.prank(admin);
        vault.setFee(uint16(seed % 1001));
    }

    function withdrawFees(uint256 amount) external {
        uint256 fees = vault.fees();
        if (fees == 0) return;

        vm.prank(admin);
        vault.withdrawFees(admin, 1 + (amount % fees));
    }

    // -------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------

    function _seat(uint256 who, uint256 amount, uint16 feeBps, bytes32 commit, bytes32 nonce)
        private
        view
        returns (ArcadeVault.Seat memory)
    {
        uint64 deadline = uint64(block.timestamp + 1800);
        bytes32 digest = vault.stakeDigest(actors[who], "ludo", amount, feeBps, commit, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[who], digest);

        return ArcadeVault.Seat({
            player: actors[who],
            commit: commit,
            nonce: nonce,
            deadline: deadline,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _close(uint256 at, bytes32 id) private {
        ghostLocked -= potOf[id];
        openIds[at] = openIds[openIds.length - 1];
        openIds.pop();
    }
}

/**
 * Invariants over the vault's money: whatever the sequence, it holds exactly every free
 * balance, every stake in play and the fees taken; the free balances and the stakes add up to
 * its own totals; and what is locked is exactly the stakes of the games still open.
 */
contract VaultInvariantTest {
    address private constant ADMIN = address(0xAD);
    address private constant REFEREE = address(0x12EF);

    ArcadeVault private vault;
    VaultHandler private handler;

    function setUp() public {
        vault = new ArcadeVault(ADMIN, REFEREE, 500, 1_000 ether, 3 days);
        handler = new VaultHandler(vault, REFEREE, ADMIN);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_theVaultHoldsEveryWeiItOwes() public view {
        assert(address(vault).balance == vault.totalBalances() + vault.totalLocked() + vault.fees());
        assert(vault.solvent());
    }

    function invariant_balancesAndStakesAddUpToTheTotals() public view {
        uint256 free = 0;
        uint256 locked = 0;
        for (uint256 i = 0; i < handler.ACTORS(); ++i) {
            address actor = handler.actors(i);
            free += vault.balanceOf(actor);
            locked += vault.lockedOf(actor);
        }

        assert(free == vault.totalBalances());
        assert(locked == vault.totalLocked());
    }

    function invariant_lockedIsExactlyTheOpenGames() public view {
        assert(vault.totalLocked() == handler.ghostLocked());
        if (handler.openCount() == 0) assert(vault.totalLocked() == 0);
    }
}
