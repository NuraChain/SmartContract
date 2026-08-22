// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUniswapV2PairLike {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/**
 * Counterparties for test/UniV2.test.ts, and nothing else. Neither is deployed by
 * ignition/modules/univ2.ts or probed by scripts/preflight.ts.
 *
 * `UniswapV2Pair.swap` hands control to `to` whenever `data` is non-empty — that is the
 * flash-swap path, and it is the only place the pair calls out before its K check runs.
 * These stand in that spot: one repays honestly, one tries to swap again from inside the
 * callback. They are written for 0.8.28 rather than the pair's 0.5.16 because nothing here
 * is vendored, and an external call does not care which compiler produced the callee.
 */

/// @dev Borrows through a flash swap and repays the same token plus a margin for the fee.
contract FlashBorrower {
    /// @notice Set when `uniswapV2Call` runs, so a test can prove the callback happened.
    bool public called;
    uint256 public lastAmount0;
    uint256 public lastAmount1;

    /// @notice Repay this many basis points over the borrowed amount. 40 covers a 0.25% fee.
    uint256 public repayMarginBps = 40;

    function setRepayMarginBps(uint256 bps) external {
        repayMarginBps = bps;
    }

    /// @notice Triggers a flash swap of `amount0Out`/`amount1Out` out of `pair`.
    function flash(address pair, uint256 amount0Out, uint256 amount1Out) external {
        IUniswapV2PairLike(pair).swap(amount0Out, amount1Out, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256 amount0, uint256 amount1, bytes calldata) external {
        called = true;
        lastAmount0 = amount0;
        lastAmount1 = amount1;

        // Repay in the same token that was borrowed. The pair only checks K, so returning
        // the borrowed amount plus enough to cover the fee satisfies it.
        address borrowed = amount0 > 0
            ? IUniswapV2PairLike(msg.sender).token0()
            : IUniswapV2PairLike(msg.sender).token1();
        uint256 amount = amount0 > 0 ? amount0 : amount1;
        uint256 repayment = amount + (amount * repayMarginBps) / 10_000;

        IERC20Like(borrowed).transfer(msg.sender, repayment);
    }
}

/// @dev Calls `swap` again from inside the callback, which the pair's `lock` modifier must stop.
contract ReentrantBorrower {
    /// @notice Whether the nested `swap` reverted. Recorded rather than bubbled so a test
    ///         can tell the lock firing apart from the outer swap failing for another reason.
    bool public reentryReverted;
    bool public called;

    function flash(address pair, uint256 amount0Out, uint256 amount1Out) external {
        IUniswapV2PairLike(pair).swap(amount0Out, amount1Out, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256 amount0, uint256 amount1, bytes calldata) external {
        called = true;

        try IUniswapV2PairLike(msg.sender).swap(amount0, amount1, address(this), hex"01") {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }

        // Repay so the outer swap can still settle, leaving the nested call as the only
        // thing that failed.
        address borrowed = amount0 > 0
            ? IUniswapV2PairLike(msg.sender).token0()
            : IUniswapV2PairLike(msg.sender).token1();
        uint256 amount = amount0 > 0 ? amount0 : amount1;

        IERC20Like(borrowed).transfer(msg.sender, amount + (amount * 40) / 10_000);
    }
}
