// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CollateralizedNFT} from "../CollateralizedNFT.sol";
import {MockConfigurableERC20} from "../mocks/VaultMocks.sol";

/**
 * Property tests for CollateralizedNFT, run by `npx hardhat test solidity`.
 *
 * test/Vault.test.ts pins the behaviour at chosen values — 250e18, 2,500,000, the exact
 * boundaries. These say the same things for values nobody chose: the arithmetic that
 * decides how much collateral an NFT is worth should not have a lock amount or a balance
 * where it stops holding.
 *
 * @dev Cheatcodes are reached through the hevm address directly rather than through
 *      forge-std, which this repo does not depend on. Hardhat 3 runs these natively.
 */
interface Vm {
    function assume(bool condition) external pure;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
}

contract VaultFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xA11CE);
    address private constant ALICE = address(0xB0B);

    MockConfigurableERC20 private token;

    function setUp() public {
        token = new MockConfigurableERC20();
    }

    /** Fresh vault at `lockAmount`, funded with `funding`, admin held by this contract. */
    function _deploy(uint256 lockAmount, uint256 funding) private returns (CollateralizedNFT vault) {
        vault = new CollateralizedNFT(
            address(this),
            IERC20(address(token)),
            lockAmount,
            "Backed Position",
            "BPOS",
            ""
        );

        if (funding > 0) {
            token.mint(address(vault), funding);
        }
    }

    // -------------------------------------------------------------------------------
    // Capacity arithmetic
    // -------------------------------------------------------------------------------

    /// @dev Capacity is `availableBacking / lockAmount` at every balance, with no rounding drift.
    function testFuzz_capacityIsBalanceOverLock(uint96 lockAmount, uint128 balance) public {
        vm.assume(lockAmount > 0);

        CollateralizedNFT vault = _deploy(lockAmount, balance);

        assert(vault.availableBacking() == balance);
        assert(vault.remainingMintCapacity() == uint256(balance) / lockAmount);
    }

    /// @dev A balance one wei short of a whole lock never backs another NFT.
    function testFuzz_shortOfALockBacksNothingExtra(uint96 lockAmount, uint8 whole) public {
        vm.assume(lockAmount > 1);

        uint256 funding = uint256(lockAmount) * whole;
        CollateralizedNFT vault = _deploy(lockAmount, funding == 0 ? 0 : funding - 1);

        assert(vault.remainingMintCapacity() == (whole == 0 ? 0 : uint256(whole) - 1));
    }

    /// @dev Reserving never lets `totalReserved` pass the balance, whatever the mix.
    function testFuzz_reservedNeverExceedsBalance(uint96 lockAmount, uint128 balance, uint8 attempts)
        public
    {
        vm.assume(lockAmount > 0);

        CollateralizedNFT vault = _deploy(lockAmount, balance);

        for (uint256 i = 0; i < attempts; i++) {
            if (vault.remainingMintCapacity() == 0) break;
            vault.mint(ALICE);
        }

        assert(vault.totalReserved() <= vault.tokenBalance());
        assert(vault.availableBacking() == vault.tokenBalance() - vault.totalReserved());
    }

    // -------------------------------------------------------------------------------
    // Redemption
    // -------------------------------------------------------------------------------

    /// @dev Whatever the lock, an NFT redeems for exactly what it was minted with.
    function testFuzz_redeemPaysExactlyTheLock(uint96 lockAmount, uint8 count) public {
        vm.assume(lockAmount > 0);
        vm.assume(count > 0);

        uint256 funding = uint256(lockAmount) * count;
        CollateralizedNFT vault = _deploy(lockAmount, funding);

        vault.mintBatch(ALICE, count);
        assert(vault.totalReserved() == funding);

        for (uint256 id = 1; id <= count; id++) {
            uint256 before = token.balanceOf(ALICE);
            vm.prank(ALICE);
            vault.redeem(id);

            assert(token.balanceOf(ALICE) - before == lockAmount);
        }

        // The reserve is exactly emptied: no dust left behind, nothing overpaid.
        assert(vault.totalReserved() == 0);
        assert(vault.tokenBalance() == 0);
    }

    /// @dev Reconfiguring the lock never moves what an already-minted NFT is worth.
    function testFuzz_lockChangeLeavesMintedNftsAlone(uint96 first, uint96 second) public {
        vm.assume(first > 0 && second > 0);

        CollateralizedNFT vault = _deploy(first, uint256(first) + uint256(second));

        vault.mint(ALICE);
        assert(vault.lockedAmount(1) == first);

        vault.setLockAmount(second);

        assert(vault.lockedAmount(1) == first);
        assert(vault.lockAmount() == second);

        uint256 before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(1);

        assert(token.balanceOf(ALICE) - before == first);
    }

    /// @dev Two NFTs minted either side of a reconfiguration keep their own amounts.
    function testFuzz_mixedLocksRedeemIndependently(uint96 first, uint96 second) public {
        vm.assume(first > 0 && second > 0);

        CollateralizedNFT vault = _deploy(first, uint256(first) + uint256(second));

        vault.mint(ALICE);
        vault.setLockAmount(second);
        vault.mint(ALICE);

        assert(vault.totalReserved() == uint256(first) + uint256(second));

        uint256 before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(2);
        assert(token.balanceOf(ALICE) - before == second);

        before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(1);
        assert(token.balanceOf(ALICE) - before == first);
    }

    // -------------------------------------------------------------------------------
    // Admin bounds
    // -------------------------------------------------------------------------------

    /// @dev The admin can never withdraw into the collateral behind an outstanding NFT.
    function testFuzz_withdrawCannotReachReservedCollateral(
        uint96 lockAmount,
        uint8 mints,
        uint128 extra
    ) public {
        vm.assume(lockAmount > 0);
        vm.assume(mints > 0);

        uint256 reserved = uint256(lockAmount) * mints;
        CollateralizedNFT vault = _deploy(lockAmount, reserved + extra);

        vault.mintBatch(ALICE, mints);
        assert(vault.totalReserved() == reserved);
        assert(vault.availableBacking() == extra);

        // One wei past the unreserved part is always refused.
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralizedNFT.InsufficientBacking.selector,
                uint256(extra),
                uint256(extra) + 1
            )
        );
        vault.withdrawExcessTokens(ADMIN, uint256(extra) + 1);

        if (extra > 0) {
            vault.withdrawExcessTokens(ADMIN, extra);
        }

        // Every NFT is still fully backed after the sweep.
        assert(vault.tokenBalance() == reserved);
        assert(vault.totalReserved() == reserved);

        for (uint256 id = 1; id <= mints; id++) {
            uint256 before = token.balanceOf(ALICE);
            vm.prank(ALICE);
            vault.redeem(id);
            assert(token.balanceOf(ALICE) - before == lockAmount);
        }
    }

    /// @dev Minting is refused whenever the unreserved balance cannot cover a whole lock.
    function testFuzz_underCollateralizedMintAlwaysReverts(uint96 lockAmount, uint96 balance)
        public
    {
        vm.assume(lockAmount > 0);
        vm.assume(balance < lockAmount);

        CollateralizedNFT vault = _deploy(lockAmount, balance);

        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralizedNFT.InsufficientBacking.selector,
                uint256(balance),
                uint256(lockAmount)
            )
        );
        vault.mint(ALICE);

        assert(vault.totalMinted() == 0);
        assert(vault.totalReserved() == 0);
    }

    /// @dev A batch is all-or-nothing: one NFT too many mints none of them.
    function testFuzz_oversizedBatchMintsNothing(uint96 lockAmount, uint8 affordable) public {
        vm.assume(lockAmount > 0);

        uint256 funding = uint256(lockAmount) * affordable;
        CollateralizedNFT vault = _deploy(lockAmount, funding);

        uint256 tooMany = uint256(affordable) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralizedNFT.InsufficientBacking.selector,
                funding,
                uint256(lockAmount) * tooMany
            )
        );
        vault.mintBatch(ALICE, tooMany);

        assert(vault.totalMinted() == 0);
        assert(vault.totalReserved() == 0);
    }

    // -------------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------------

    /// @dev Nobody outside MINTER_ROLE can mint while public minting is off.
    function testFuzz_onlyMinterCanMint(address caller) public {
        vm.assume(caller != address(this));
        vm.assume(caller != address(0));

        CollateralizedNFT vault = _deploy(1e18, 100e18);

        vm.expectRevert(
            abi.encodeWithSelector(CollateralizedNFT.MintNotPermitted.selector, caller)
        );
        vm.prank(caller);
        vault.mint(caller);

        assert(vault.totalMinted() == 0);
    }

    /// @dev Only the owner of an NFT can redeem it, whoever else asks.
    function testFuzz_onlyOwnerCanRedeem(address stranger) public {
        vm.assume(stranger != ALICE);
        vm.assume(stranger != address(0));

        CollateralizedNFT vault = _deploy(1e18, 10e18);
        vault.mint(ALICE);

        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralizedNFT.NotTokenOwner.selector,
                uint256(1),
                ALICE,
                stranger
            )
        );
        vm.prank(stranger);
        vault.redeem(1);

        // The position survives the attempt untouched.
        assert(vault.ownerOf(1) == ALICE);
        assert(vault.lockedAmount(1) == 1e18);
        assert(vault.totalReserved() == 1e18);
    }
}
