// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CollateralizedNFT} from "../CollateralizedNFT.sol";
import {MockConfigurableERC20} from "../mocks/VaultMocks.sol";

interface Vm {
    function prank(address sender) external;
}

/**
 * Drives the vault through random sequences on behalf of the invariant runner.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so a
 * run is never thrown away for asking the impossible — the fuzzer spends its budget on
 * sequences that actually reach the contract.
 *
 * The handler holds DEFAULT_ADMIN_ROLE and MINTER_ROLE, so it can reach every state
 * transition the contract has, including the two an admin controls: retuning the lock and
 * sweeping unreserved collateral.
 */
contract VaultHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CollateralizedNFT public immutable vault;
    MockConfigurableERC20 public immutable token;

    /// @dev A small fixed cast, so ownership actually moves around rather than being unique per id.
    address[3] public users = [address(0xA1), address(0xA2), address(0xA3)];

    /// @dev Ceiling on outstanding NFTs. invariant_reservedEqualsSumOfLocks walks this set
    ///      after every call, so leaving it unbounded makes the run quadratic and it never
    ///      finishes. 32 is plenty to exercise mixed lock amounts and partial redemption.
    uint256 private constant MAX_LIVE = 32;

    /// @dev Ceiling on a single deposit, so capacity stays in the same order of magnitude as
    ///      MAX_LIVE instead of jumping to 1e26 on one random uint96.
    uint256 private constant MAX_DEPOSIT = 10_000e18;

    /// @notice Token ids currently outstanding, mirrored off-chain for the sum invariant.
    uint256[] public liveIds;
    mapping(uint256 tokenId => uint256 index) private indexOf;

    /// @notice Every backing token this handler has ever put into the vault.
    uint256 public ghostDeposited;
    /// @notice Every backing token the vault has ever paid out on redemption.
    uint256 public ghostRedeemed;
    /// @notice Every backing token the admin has ever swept as excess.
    uint256 public ghostSwept;

    constructor(CollateralizedNFT vault_, MockConfigurableERC20 token_) {
        vault = vault_;
        token = token_;
    }

    function liveCount() external view returns (uint256) {
        return liveIds.length;
    }

    function _track(uint256 tokenId) private {
        indexOf[tokenId] = liveIds.length;
        liveIds.push(tokenId);
    }

    function _forget(uint256 tokenId) private {
        uint256 i = indexOf[tokenId];
        uint256 last = liveIds.length - 1;

        if (i != last) {
            uint256 moved = liveIds[last];
            liveIds[i] = moved;
            indexOf[moved] = i;
        }

        liveIds.pop();
        delete indexOf[tokenId];
    }

    // -------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------

    function deposit(uint96 amount) external {
        uint256 bounded = uint256(amount) % MAX_DEPOSIT;
        if (bounded == 0) return;

        amount = uint96(bounded);
        token.mint(address(this), amount);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        ghostDeposited += amount;
    }

    function mint(uint256 seed) external {
        if (vault.remainingMintCapacity() == 0 || liveIds.length >= MAX_LIVE) return;

        address to = users[seed % users.length];
        uint256 id = vault.mint(to);
        _track(id);
    }

    function mintBatch(uint256 seed, uint8 quantity) external {
        uint256 capacity = vault.remainingMintCapacity();
        if (capacity == 0 || quantity == 0 || liveIds.length >= MAX_LIVE) return;

        uint256 room = MAX_LIVE - liveIds.length;
        uint256 count = uint256(quantity) % 5 + 1;
        if (count > capacity) count = capacity;
        if (count > room) count = room;
        address to = users[seed % users.length];

        uint256 first = vault.mintBatch(to, count);
        for (uint256 i = 0; i < count; i++) {
            _track(first + i);
        }
    }

    function redeem(uint256 seed) external {
        if (liveIds.length == 0) return;

        uint256 id = liveIds[seed % liveIds.length];
        address owner = vault.ownerOf(id);
        uint256 before = token.balanceOf(owner);

        vm.prank(owner);
        vault.redeem(id);

        ghostRedeemed += token.balanceOf(owner) - before;
        _forget(id);
    }

    function transfer(uint256 seed, uint256 toSeed) external {
        if (liveIds.length == 0) return;

        uint256 id = liveIds[seed % liveIds.length];
        address owner = vault.ownerOf(id);
        address to = users[toSeed % users.length];
        if (to == owner) return;

        vm.prank(owner);
        vault.transferFrom(owner, to, id);
    }

    function setLockAmount(uint96 amount) external {
        uint256 bounded = uint256(amount) % 1000e18;
        if (bounded == 0) return;

        vault.setLockAmount(bounded);
    }

    function sweepExcess(uint96 amount) external {
        uint256 available = vault.availableBacking();
        if (amount == 0 || available == 0) return;

        uint256 take = amount > available ? available : amount;
        vault.withdrawExcessTokens(address(this), take);
        ghostSwept += take;
    }

    function togglePublicMint(bool enabled) external {
        vault.setPublicMintEnabled(enabled);
    }
}

/**
 * Stateful invariant tests for CollateralizedNFT, run by `npx hardhat test solidity`.
 *
 * The contract's own NatSpec states two invariants and says they hold "by construction".
 * These check that claim against random sequences of every state transition the contract
 * has, rather than against sequences somebody thought of.
 */
contract VaultInvariantTest {
    /// @dev 100 NFTs of headroom at the starting lock — enough to exhaust the reserve inside
    ///      a run, which is the interesting edge, without a state space nothing can walk.
    uint256 internal constant INITIAL_RESERVE = 25_000e18;

    CollateralizedNFT internal vault;
    MockConfigurableERC20 internal token;
    VaultHandler internal handler;

    function setUp() public {
        token = new MockConfigurableERC20();

        // The handler is the admin, so the fuzzer can reach the admin-only transitions.
        vault = new CollateralizedNFT(
            address(this),
            IERC20(address(token)),
            250e18,
            "Backed Position",
            "BPOS",
            ""
        );
        handler = new VaultHandler(vault, token);

        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(handler));
        vault.grantRole(vault.MINTER_ROLE(), address(handler));

        token.mint(address(vault), INITIAL_RESERVE);
    }

    /// @dev Restricts the fuzzer to the handler, the way forge-std's StdInvariant does.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    // -------------------------------------------------------------------------------
    // Invariants
    // -------------------------------------------------------------------------------

    /// @dev Invariant 2 from the contract: the reserve is always actually there.
    function invariant_reservedIsAlwaysBacked() public view {
        require(vault.totalReserved() <= vault.tokenBalance(), "reserved more than is held");
    }

    /// @dev Invariant 1: the running total equals the sum of the per-NFT records.
    function invariant_reservedEqualsSumOfLocks() public view {
        uint256 count = handler.liveCount();
        uint256 sum;

        for (uint256 i = 0; i < count; i++) {
            sum += vault.lockedAmount(handler.liveIds(i));
        }

        require(vault.totalReserved() == sum, "totalReserved drifted from the per-NFT locks");
    }

    /// @dev Every outstanding NFT still has a redeemable amount recorded against it.
    function invariant_everyLiveNftHasCollateral() public view {
        uint256 count = handler.liveCount();

        for (uint256 i = 0; i < count; i++) {
            uint256 id = handler.liveIds(i);
            require(vault.lockedAmount(id) > 0, "outstanding NFT with no collateral");
            require(vault.ownerOf(id) != address(0), "outstanding NFT with no owner");
        }
    }

    /// @dev Supply accounting stays consistent with the mint and redeem counters.
    function invariant_supplyMatchesCounters() public view {
        require(
            vault.totalSupply() == vault.totalMinted() - vault.totalRedeemed(),
            "supply does not match minted - redeemed"
        );
        require(vault.totalRedeemed() <= vault.totalMinted(), "redeemed more than minted");
    }

    /// @dev The handler's ledger of every token in and out reconciles with the balance.
    function invariant_tokensAreConserved() public view {
        uint256 expected = INITIAL_RESERVE + handler.ghostDeposited() - handler.ghostRedeemed()
            - handler.ghostSwept();

        require(vault.tokenBalance() == expected, "tokens appeared or vanished");
    }

    /// @dev availableBacking is exactly the unreserved part, and never underflows.
    function invariant_availableBackingIsExact() public view {
        require(
            vault.availableBacking() == vault.tokenBalance() - vault.totalReserved(),
            "availableBacking is not balance - reserved"
        );
    }

    /// @dev Capacity never claims room the unreserved balance cannot actually pay for.
    function invariant_capacityIsHonest() public view {
        uint256 capacity = vault.remainingMintCapacity();

        require(
            capacity * vault.lockAmount() <= vault.availableBacking(),
            "capacity promises more than the reserve can back"
        );
    }
}
