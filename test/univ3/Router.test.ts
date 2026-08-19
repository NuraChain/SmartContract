import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  Q96,
  TICK_SPACING,
  createPool,
  deadline,
  deployV3,
  encodePath,
  fullRange,
  mintPosition,
} from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * SwapRouter and QuoterV2 — what a wallet actually calls.
 *
 * Two things here are load-bearing beyond "does a swap work":
 *
 *   CallbackValidation. The pool pays out first and asks for the money in a callback, and
 *   the only thing standing between a forged callback and every allowance users have
 *   granted the router is `require(msg.sender == PoolAddress.computeAddress(...))`.
 *
 *   The native path. Nurachain's WNURA is Dapphub's WETH9 with the payable fallback
 *   commented out, so nothing can wrap by bare transfer — and `withdraw` pays out with
 *   `.transfer()`, i.e. a 2300 gas stipend that SwapRouter's `receive()` has to fit in.
 */

const SPACING = TICK_SPACING[FEE.MEDIUM];
const RANGE = fullRange(SPACING);
const DEPTH = ethers.parseEther("100000");

/** tokenA/tokenB and tokenB/tokenC pools, both 0.30% at 1:1, both deep. */
async function routes() {
  const ctx = await deployV3();

  for (const [x, y] of [
    [ctx.tokenA, ctx.tokenB],
    [ctx.tokenB, ctx.tokenC],
  ] as const) {
    await createPool(ctx, x, y, FEE.MEDIUM, Q96);
    await mintPosition(ctx, {
      token0: x,
      token1: y,
      fee: FEE.MEDIUM,
      ...RANGE,
      amount0: DEPTH,
      amount1: DEPTH,
    });
  }

  return ctx;
}

/** A WNURA/tokenA pool, for the native-coin paths. */
async function nativeRoute() {
  const ctx = await deployV3();

  await ctx.wnura.deposit({ value: ethers.parseEther("500") });
  await ctx.wnura.approve(await ctx.positionManager.getAddress(), ethers.MaxUint256);
  await ctx.wnura.approve(await ctx.swapRouter.getAddress(), ethers.MaxUint256);

  await createPool(ctx, ctx.wnura, ctx.tokenA, FEE.MEDIUM, Q96);
  await mintPosition(ctx, {
    token0: ctx.wnura,
    token1: ctx.tokenA,
    fee: FEE.MEDIUM,
    ...RANGE,
    amount0: ethers.parseEther("400"),
    amount1: ethers.parseEther("400"),
  });

  return ctx;
}

describe("V3 router", () => {
  describe("single-hop", () => {
    it("exactInputSingle pays out at least the minimum and takes exactly the input", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);
      const amountIn = ethers.parseEther("100");

      const before = await ctx.tokenB.balanceOf(ctx.alice.address);
      const spentBefore = await ctx.tokenA.balanceOf(ctx.alice.address);

      const out = await ctx.swapRouter.connect(ctx.alice).exactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        fee: FEE.MEDIUM,
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      });

      await ctx.swapRouter.connect(ctx.alice).exactInputSingle({
        tokenIn,
        tokenOut,
        fee: FEE.MEDIUM,
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountIn,
        amountOutMinimum: out,
        sqrtPriceLimitX96: 0n,
      });

      expect((await ctx.tokenB.balanceOf(ctx.alice.address)) - before).to.equal(out);
      expect(spentBefore - (await ctx.tokenA.balanceOf(ctx.alice.address))).to.equal(amountIn);
      // 0.30% fee plus a little slippage on a 100-of-100000 trade.
      expect(out).to.be.lessThan(amountIn);
      expect(out).to.be.greaterThan((amountIn * 99n) / 100n);
    });

    it("exactOutputSingle delivers exactly the amount asked for", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);
      const amountOut = ethers.parseEther("100");
      const before = await ctx.tokenB.balanceOf(ctx.alice.address);

      await ctx.swapRouter.connect(ctx.alice).exactOutputSingle({
        tokenIn,
        tokenOut,
        fee: FEE.MEDIUM,
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountOut,
        amountInMaximum: ethers.parseEther("200"),
        sqrtPriceLimitX96: 0n,
      });

      expect((await ctx.tokenB.balanceOf(ctx.alice.address)) - before).to.equal(amountOut);
    });

    it("refuses to trade below amountOutMinimum", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);

      await expect(
        ctx.swapRouter.connect(ctx.alice).exactInputSingle({
          tokenIn,
          tokenOut,
          fee: FEE.MEDIUM,
          recipient: ctx.alice.address,
          deadline: await deadline(),
          amountIn: ethers.parseEther("100"),
          // More out than in, which the fee alone makes impossible.
          amountOutMinimum: ethers.parseEther("101"),
          sqrtPriceLimitX96: 0n,
        }),
      ).to.be.revertedWith("Too little received");
    });

    it("refuses to spend more than amountInMaximum", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);

      await expect(
        ctx.swapRouter.connect(ctx.alice).exactOutputSingle({
          tokenIn,
          tokenOut,
          fee: FEE.MEDIUM,
          recipient: ctx.alice.address,
          deadline: await deadline(),
          amountOut: ethers.parseEther("100"),
          amountInMaximum: ethers.parseEther("100"),
          sqrtPriceLimitX96: 0n,
        }),
      ).to.be.revertedWith("Too much requested");
    });

    it("refuses a deadline that has passed", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      await expect(
        ctx.swapRouter.connect(ctx.alice).exactInputSingle({
          tokenIn,
          tokenOut,
          fee: FEE.MEDIUM,
          recipient: ctx.alice.address,
          deadline: now - 1,
          amountIn: ethers.parseEther("1"),
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }),
      ).to.be.revertedWith("Transaction too old");
    });

    it("reverts on a pool that does not exist", async () => {
      const ctx = await loadFixture(routes);
      const [tokenIn, tokenOut] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
      ]);

      // Right pair, but the 1% pool was never created.
      await expect(
        ctx.swapRouter.connect(ctx.alice).exactInputSingle({
          tokenIn,
          tokenOut,
          fee: FEE.HIGH,
          recipient: ctx.alice.address,
          deadline: await deadline(),
          amountIn: ethers.parseEther("1"),
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }),
      ).to.be.revert(ethers);
    });
  });

  describe("multi-hop", () => {
    it("exactInput routes A -> B -> C", async () => {
      const ctx = await loadFixture(routes);
      const [a, b, c] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
        ctx.tokenC.getAddress(),
      ]);
      const amountIn = ethers.parseEther("100");
      const before = await ctx.tokenC.balanceOf(ctx.alice.address);

      await ctx.swapRouter.connect(ctx.alice).exactInput({
        path: encodePath([a, b, c], [FEE.MEDIUM, FEE.MEDIUM]),
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountIn,
        amountOutMinimum: 0n,
      });

      const out = (await ctx.tokenC.balanceOf(ctx.alice.address)) - before;
      expect(out).to.be.greaterThan(0n);
      // Two hops, so the 0.30% fee is paid twice.
      expect(out).to.be.lessThan((amountIn * 995n) / 1000n);
      expect(out).to.be.greaterThan((amountIn * 98n) / 100n);
    });

    it("exactOutput routes A -> B -> C with the path written backwards", async () => {
      const ctx = await loadFixture(routes);
      const [a, b, c] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
        ctx.tokenC.getAddress(),
      ]);
      const amountOut = ethers.parseEther("100");
      const before = await ctx.tokenC.balanceOf(ctx.alice.address);

      // exactOutput walks the path from the output token back to the input token.
      await ctx.swapRouter.connect(ctx.alice).exactOutput({
        path: encodePath([c, b, a], [FEE.MEDIUM, FEE.MEDIUM]),
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountOut,
        amountInMaximum: ethers.parseEther("200"),
      });

      expect((await ctx.tokenC.balanceOf(ctx.alice.address)) - before).to.equal(amountOut);
    });

    it("costs more through two hops than one, for the same pair depth", async () => {
      const ctx = await loadFixture(routes);
      const [a, b, c] = await Promise.all([
        ctx.tokenA.getAddress(),
        ctx.tokenB.getAddress(),
        ctx.tokenC.getAddress(),
      ]);
      const amountIn = ethers.parseEther("100");

      const oneHop = await ctx.swapRouter.connect(ctx.alice).exactInput.staticCall({
        path: encodePath([a, b], [FEE.MEDIUM]),
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountIn,
        amountOutMinimum: 0n,
      });
      const twoHops = await ctx.swapRouter.connect(ctx.alice).exactInput.staticCall({
        path: encodePath([a, b, c], [FEE.MEDIUM, FEE.MEDIUM]),
        recipient: ctx.alice.address,
        deadline: await deadline(),
        amountIn,
        amountOutMinimum: 0n,
      });

      expect(twoHops).to.be.lessThan(oneHop);
    });
  });

  describe("native NURA", () => {
    it("wraps on the way in", async () => {
      const ctx = await loadFixture(nativeRoute);
      const [wnura, tokenA] = await Promise.all([
        ctx.wnura.getAddress(),
        ctx.tokenA.getAddress(),
      ]);
      const value = ethers.parseEther("10");
      const before = await ctx.tokenA.balanceOf(ctx.alice.address);

      await ctx.swapRouter.connect(ctx.alice).exactInputSingle(
        {
          tokenIn: wnura,
          tokenOut: tokenA,
          fee: FEE.MEDIUM,
          recipient: ctx.alice.address,
          deadline: await deadline(),
          amountIn: value,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
        { value },
      );

      expect(await ctx.tokenA.balanceOf(ctx.alice.address)).to.be.greaterThan(before);
    });

    it("unwraps on the way out, through WNURA's 2300-gas transfer", async () => {
      // This is the one that would break if SwapRouter's `receive()` did anything
      // expensive: WNURA.withdraw pays with `.transfer()`, so the router's guard has to
      // run inside the stipend. It only reads an immutable, which is why this works.
      const ctx = await loadFixture(nativeRoute);
      const [wnura, tokenA] = await Promise.all([
        ctx.wnura.getAddress(),
        ctx.tokenA.getAddress(),
      ]);
      const amountIn = ethers.parseEther("10");

      const before = await ethers.provider.getBalance(ctx.bob.address);

      // Swap into WNURA, leave it in the router, then unwrap it to bob — batched, because
      // the router only holds the WNURA in between the two calls.
      const swap = ctx.swapRouter.interface.encodeFunctionData("exactInputSingle", [
        {
          tokenIn: tokenA,
          tokenOut: wnura,
          fee: FEE.MEDIUM,
          recipient: ethers.ZeroAddress, // address(0) means "keep it in the router"
          deadline: await deadline(),
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ]);
      const unwrap = ctx.swapRouter.interface.encodeFunctionData("unwrapWETH9", [
        0n,
        ctx.bob.address,
      ]);

      await ctx.swapRouter.connect(ctx.alice).multicall([swap, unwrap]);

      expect(await ethers.provider.getBalance(ctx.bob.address)).to.be.greaterThan(before);
    });

    it("refunds native coin the swap did not need", async () => {
      const ctx = await loadFixture(nativeRoute);
      const [wnura, tokenA] = await Promise.all([
        ctx.wnura.getAddress(),
        ctx.tokenA.getAddress(),
      ]);
      const amountOut = ethers.parseEther("10");
      const sent = ethers.parseEther("50");

      const swap = ctx.swapRouter.interface.encodeFunctionData("exactOutputSingle", [
        {
          tokenIn: wnura,
          tokenOut: tokenA,
          fee: FEE.MEDIUM,
          recipient: ctx.alice.address,
          deadline: await deadline(),
          amountOut,
          amountInMaximum: sent,
          sqrtPriceLimitX96: 0n,
        },
      ]);
      const refund = ctx.swapRouter.interface.encodeFunctionData("refundETH");

      const before = await ethers.provider.getBalance(ctx.alice.address);
      const receipt = await (
        await ctx.swapRouter.connect(ctx.alice).multicall([swap, refund], { value: sent })
      ).wait();

      const spent = before - (await ethers.provider.getBalance(ctx.alice.address));
      const gas = receipt!.gasUsed * receipt!.gasPrice;

      // Only about 10 NURA of the 50 sent should be gone, not all of it.
      expect(spent - gas).to.be.lessThan(ethers.parseEther("11"));
      expect(spent - gas).to.be.greaterThan(ethers.parseEther("9"));
      // And the router keeps nothing.
      expect(await ethers.provider.getBalance(await ctx.swapRouter.getAddress())).to.equal(0n);
    });

    it("refuses native coin from anyone but WNURA", async () => {
      const ctx = await loadFixture(nativeRoute);

      await expect(
        ctx.alice.sendTransaction({
          to: await ctx.swapRouter.getAddress(),
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("Not WETH9");
    });
  });

  describe("callback validation", () => {
    it("ignores a swap callback that did not come from a real pool", async () => {
      // Without this check, anyone could call the router's callback directly with a
      // `payer` of their choosing and drain every allowance granted to the router.
      const ctx = await loadFixture(routes);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(bytes,address)"],
        [[encodePath([a, b], [FEE.MEDIUM]), ctx.alice.address]],
      );

      await expect(
        ctx.swapRouter.connect(ctx.bob).uniswapV3SwapCallback(ethers.parseEther("1"), 0n, data),
      ).to.be.revert(ethers);
    });

    it("ignores a mint callback that did not come from a real pool", async () => {
      const ctx = await loadFixture(routes);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(tuple(address,address,uint24),address)"],
        [[[a, b, FEE.MEDIUM], ctx.alice.address]],
      );

      await expect(
        ctx.positionManager
          .connect(ctx.bob)
          .uniswapV3MintCallback(ethers.parseEther("1"), ethers.parseEther("1"), data),
      ).to.be.revert(ethers);
    });
  });
});

describe("V3 quoter", () => {
  it("quoteExactInputSingle matches what the swap actually pays", async () => {
    const ctx = await loadFixture(routes);
    const [tokenIn, tokenOut] = await Promise.all([
      ctx.tokenA.getAddress(),
      ctx.tokenB.getAddress(),
    ]);
    const amountIn = ethers.parseEther("100");

    const quoted = await ctx.quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee: FEE.MEDIUM,
      sqrtPriceLimitX96: 0n,
    });

    const actual = await ctx.swapRouter.connect(ctx.alice).exactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      fee: FEE.MEDIUM,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });

    // Not "close to" — the quoter runs the same swap and reverts with the result.
    expect(quoted.amountOut).to.equal(actual);
  });

  it("quoteExactOutputSingle matches what the swap actually costs", async () => {
    const ctx = await loadFixture(routes);
    const [tokenIn, tokenOut] = await Promise.all([
      ctx.tokenA.getAddress(),
      ctx.tokenB.getAddress(),
    ]);
    const amount = ethers.parseEther("100");

    const quoted = await ctx.quoter.quoteExactOutputSingle.staticCall({
      tokenIn,
      tokenOut,
      amount,
      fee: FEE.MEDIUM,
      sqrtPriceLimitX96: 0n,
    });

    const actual = await ctx.swapRouter.connect(ctx.alice).exactOutputSingle.staticCall({
      tokenIn,
      tokenOut,
      fee: FEE.MEDIUM,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountOut: amount,
      amountInMaximum: ethers.MaxUint256,
      sqrtPriceLimitX96: 0n,
    });

    expect(quoted.amountIn).to.equal(actual);
  });

  it("quotes a multi-hop route, per hop", async () => {
    const ctx = await loadFixture(routes);
    const [a, b, c] = await Promise.all([
      ctx.tokenA.getAddress(),
      ctx.tokenB.getAddress(),
      ctx.tokenC.getAddress(),
    ]);
    const amountIn = ethers.parseEther("100");
    const path = encodePath([a, b, c], [FEE.MEDIUM, FEE.MEDIUM]);

    const quoted = await ctx.quoter.quoteExactInput.staticCall(path, amountIn);
    const actual = await ctx.swapRouter.connect(ctx.alice).exactInput.staticCall({
      path,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountIn,
      amountOutMinimum: 0n,
    });

    expect(quoted.amountOut).to.equal(actual);
    // One entry per hop, which is what a UI needs to show a per-leg price impact.
    expect(quoted.sqrtPriceX96AfterList).to.have.lengthOf(2);
    expect(quoted.initializedTicksCrossedList).to.have.lengthOf(2);
  });

  it("reports the price the pool would be left at, and a gas estimate", async () => {
    const ctx = await loadFixture(routes);
    const [tokenIn, tokenOut] = await Promise.all([
      ctx.tokenA.getAddress(),
      ctx.tokenB.getAddress(),
    ]);

    const quoted = await ctx.quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn: ethers.parseEther("100"),
      fee: FEE.MEDIUM,
      sqrtPriceLimitX96: 0n,
    });

    // token0 in pushes the price down; tokenA sorts below tokenB, so this is token0.
    expect(quoted.sqrtPriceX96After).to.be.lessThan(Q96);
    expect(quoted.gasEstimate).to.be.greaterThan(0n);
    // Deep pool, small trade — no initialized tick should be crossed.
    expect(quoted.initializedTicksCrossed).to.equal(0n);
  });

  it("reverts rather than guessing when the pool does not exist", async () => {
    const ctx = await loadFixture(routes);
    const [tokenIn, tokenOut] = await Promise.all([
      ctx.tokenA.getAddress(),
      ctx.tokenC.getAddress(),
    ]);

    await expect(
      ctx.quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn: ethers.parseEther("1"),
        fee: FEE.LOW,
        sqrtPriceLimitX96: 0n,
      }),
    ).to.be.revert(ethers);
  });
});
