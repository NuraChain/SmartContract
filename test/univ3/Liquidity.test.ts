import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  TICK_SPACING,
  createPool,
  deployV3,
  encodeSqrtRatioX96,
  fullRange,
  mintPosition,
} from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * Concentrated liquidity — the thing V3 is for.
 *
 * A V2 position is liquidity spread from zero to infinity. A V3 position is liquidity
 * between two ticks, which is what makes it capital-efficient and also what makes it go
 * inert when the price leaves. Everything below is about that trade: what a range costs,
 * what it earns while the price is inside it, and what happens to it when the price is
 * not.
 */

const SPACING = TICK_SPACING[FEE.MEDIUM];
const WIDE = fullRange(SPACING);
const AMOUNT = ethers.parseEther("1000");

/** A 0.30% pool at 1:1 with nothing in it yet. */
async function emptyPool() {
  const ctx = await deployV3();
  const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);

  return { ...ctx, pool };
}

/** Swaps token0 in through the callee, moving the price down. */
async function swapDown(ctx: Awaited<ReturnType<typeof emptyPool>>, amount: bigint) {
  await ctx.callee
    .connect(ctx.alice)
    .swapExact0For1(await ctx.pool.getAddress(), amount, ctx.alice.address, MIN_SQRT_RATIO + 1n);
}

/**
 * Trades until the price reaches a target, rather than trading a fixed amount.
 *
 * How far a given amount moves the price depends entirely on how much liquidity is
 * active, and these tests deliberately mint wildly different amounts — a fixed swap size
 * that crosses a tick in one test silently fails to in another. Naming the destination
 * keeps them honest.
 */
async function swapToPrice(ctx: Awaited<ReturnType<typeof emptyPool>>, sqrtPriceX96: bigint) {
  const pool = await ctx.pool.getAddress();
  const current = (await ctx.pool.slot0()).sqrtPriceX96;

  if (sqrtPriceX96 < current) {
    await ctx.callee.connect(ctx.alice).swapToLowerSqrtPrice(pool, sqrtPriceX96, ctx.alice.address);
  } else {
    await ctx.callee.connect(ctx.alice).swapToHigherSqrtPrice(pool, sqrtPriceX96, ctx.alice.address);
  }
}

/** Roughly tick -1054: well below any range these tests put at +/- a few spacings. */
const WELL_BELOW = encodeSqrtRatioX96(90n, 100n);

describe("V3 concentrated liquidity", () => {
  describe("what a range costs", () => {
    it("gets far more liquidity out of the same tokens when the range is narrow", async () => {
      const ctx = await loadFixture(emptyPool);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      const wide = await ctx.pool.liquidity();

      // +/- ~1% around the current price instead of the whole number line.
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING * 2,
        tickUpper: SPACING * 2,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.alice,
      });
      const narrow = (await ctx.pool.liquidity()) - wide;

      // Same tokens, an order of magnitude more depth where the trading happens.
      expect(narrow).to.be.greaterThan(wide * 50n);
    });

    it("takes only token0 for a range entirely above the price", async () => {
      const ctx = await loadFixture(emptyPool);
      const before = await Promise.all([
        ctx.tokenA.balanceOf(ctx.deployer.address),
        ctx.tokenB.balanceOf(ctx.deployer.address),
      ]);

      // Price is 1:1 (tick 0); this range only ever holds token0 until the price rises.
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: SPACING * 10,
        tickUpper: SPACING * 20,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });

      const after = await Promise.all([
        ctx.tokenA.balanceOf(ctx.deployer.address),
        ctx.tokenB.balanceOf(ctx.deployer.address),
      ]);

      expect(before[0] - after[0]).to.be.greaterThan(0n);
      expect(before[1] - after[1]).to.equal(0n);
    });

    it("takes only token1 for a range entirely below the price", async () => {
      const ctx = await loadFixture(emptyPool);
      const before = await Promise.all([
        ctx.tokenA.balanceOf(ctx.deployer.address),
        ctx.tokenB.balanceOf(ctx.deployer.address),
      ]);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING * 20,
        tickUpper: -SPACING * 10,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });

      const after = await Promise.all([
        ctx.tokenA.balanceOf(ctx.deployer.address),
        ctx.tokenB.balanceOf(ctx.deployer.address),
      ]);

      expect(before[0] - after[0]).to.equal(0n);
      expect(before[1] - after[1]).to.be.greaterThan(0n);
    });

    it("counts only in-range positions towards the pool's active liquidity", async () => {
      const ctx = await loadFixture(emptyPool);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING,
        tickUpper: SPACING,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      const inRange = await ctx.pool.liquidity();

      // A position nowhere near the price adds nothing to what a swap can trade against.
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: SPACING * 100,
        tickUpper: SPACING * 200,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });

      expect(await ctx.pool.liquidity()).to.equal(inRange);
    });
  });

  describe("earning fees", () => {
    it("pays an in-range position", async () => {
      const ctx = await loadFixture(emptyPool);
      const tokenId = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });

      await swapDown(ctx, ethers.parseEther("10"));

      // collect's static call reports what is owed without taking it.
      const owed = await ctx.positionManager.collect.staticCall({
        tokenId,
        recipient: ctx.deployer.address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      });

      // The trader paid in token0, so the fee is in token0.
      expect(owed[0]).to.be.greaterThan(0n);
    });

    it("pays nothing to a position the price never reached", async () => {
      const ctx = await loadFixture(emptyPool);

      // Wide position to trade against, plus a narrow one far above the price.
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      const idle = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: SPACING * 100,
        tickUpper: SPACING * 200,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });

      await swapDown(ctx, ethers.parseEther("10"));

      const owed = await ctx.positionManager.collect.staticCall({
        tokenId: idle,
        recipient: ctx.deployer.address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      });

      expect(owed[0]).to.equal(0n);
      expect(owed[1]).to.equal(0n);
    });

    it("splits fees between two LPs in proportion to their liquidity", async () => {
      const ctx = await loadFixture(emptyPool);

      const big = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT * 2n,
        amount1: AMOUNT * 2n,
      });
      const small = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.bob,
      });

      await swapDown(ctx, ethers.parseEther("10"));

      const owedBig = await ctx.positionManager.collect.staticCall({
        tokenId: big,
        recipient: ctx.deployer.address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      });
      const owedSmall = await ctx.positionManager
        .connect(ctx.bob)
        .collect.staticCall({
          tokenId: small,
          recipient: ctx.bob.address,
          amount0Max: 2n ** 128n - 1n,
          amount1Max: 2n ** 128n - 1n,
        });

      // Twice the liquidity, twice the fee — within a wei or two of rounding.
      expect(owedBig[0]).to.be.closeTo(owedSmall[0] * 2n, 10n);
    });

    it("gives a concentrated position a bigger share than a wide one of the same size", async () => {
      const ctx = await loadFixture(emptyPool);

      const wide = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      const tight = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING * 2,
        tickUpper: SPACING * 2,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.bob,
      });

      // Small enough to stay inside the tight range.
      await swapDown(ctx, ethers.parseEther("1"));

      const owedWide = await ctx.positionManager.collect.staticCall({
        tokenId: wide,
        recipient: ctx.deployer.address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      });
      const owedTight = await ctx.positionManager.connect(ctx.bob).collect.staticCall({
        tokenId: tight,
        recipient: ctx.bob.address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      });

      // This is the whole pitch for V3: same capital, far more of the fee.
      expect(owedTight[0]).to.be.greaterThan(owedWide[0] * 10n);
    });
  });

  describe("crossing a range boundary", () => {
    it("drops the concentrated liquidity when the price leaves its range", async () => {
      const ctx = await loadFixture(emptyPool);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING,
        tickUpper: SPACING,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.bob,
      });

      const inside = await ctx.pool.liquidity();
      expect((await ctx.pool.slot0()).tick).to.be.within(-SPACING, SPACING - 1);

      // Push the price well below the narrow position's lower tick.
      await swapToPrice(ctx, WELL_BELOW);

      const outside = await ctx.pool.liquidity();
      expect((await ctx.pool.slot0()).tick).to.be.lessThan(-SPACING);
      // The narrow position is gone from the active set; only the wide one is left.
      expect(outside).to.be.lessThan(inside);
      expect(outside).to.be.greaterThan(0n);
    });

    it("turns a position that fell out of range into a single-sided one", async () => {
      const ctx = await loadFixture(emptyPool);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      const tokenId = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING,
        tickUpper: SPACING,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.bob,
      });

      await swapToPrice(ctx, WELL_BELOW);

      const position = await ctx.positionManager.positions(tokenId);
      const withdrawn = await ctx.positionManager
        .connect(ctx.bob)
        .decreaseLiquidity.staticCall({
          tokenId,
          liquidity: position.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: (await ethers.provider.getBlock("latest"))!.timestamp + 3600,
        });

      // Price fell through the range, so the LP was bought out of token1 entirely and
      // holds only token0 — sold the dip, in effect.
      expect(withdrawn[0]).to.be.greaterThan(0n);
      expect(withdrawn[1]).to.equal(0n);
    });

    it("hands liquidity back when the price comes home", async () => {
      const ctx = await loadFixture(emptyPool);

      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...WIDE,
        amount0: AMOUNT,
        amount1: AMOUNT,
      });
      await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING,
        tickUpper: SPACING,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.bob,
      });

      const before = await ctx.pool.liquidity();
      await swapToPrice(ctx, WELL_BELOW);
      expect(await ctx.pool.liquidity()).to.be.lessThan(before);

      // Trade the other way until the price is back inside the narrow range.
      await ctx.callee
        .connect(ctx.alice)
        .swapToHigherSqrtPrice(await ctx.pool.getAddress(), Q96, ctx.alice.address);

      expect((await ctx.pool.slot0()).tick).to.be.within(-SPACING, SPACING - 1);
      expect(await ctx.pool.liquidity()).to.equal(before);
    });

    it("keeps overlapping ranges consistent as the price moves through them", async () => {
      const ctx = await loadFixture(emptyPool);

      // Three positions that overlap around the current price.
      for (const [lower, upper, signer] of [
        [-SPACING * 10, SPACING * 10, ctx.deployer],
        [-SPACING * 5, SPACING * 20, ctx.alice],
        [-SPACING * 20, SPACING * 5, ctx.bob],
      ] as const) {
        await mintPosition(ctx, {
          token0: ctx.tokenA,
          token1: ctx.tokenB,
          fee: FEE.MEDIUM,
          tickLower: lower,
          tickUpper: upper,
          amount0: AMOUNT,
          amount1: AMOUNT,
          signer,
        });
      }

      const all = await ctx.pool.liquidity();

      // Walk the price down past the first boundary (-5 * spacing, from the second
      // position's lower tick being above it) and check liquidity only ever falls.
      await swapToPrice(ctx, WELL_BELOW);
      const after = await ctx.pool.liquidity();

      expect(after).to.be.lessThan(all);
      expect(after).to.be.greaterThan(0n);
      // Whatever crossed, the pool's own invariant holds: net liquidity across every
      // initialized tick sums back to zero.
      const [lowerTick, upperTick] = [-SPACING * 20, SPACING * 20];
      let net = 0n;
      for (let tick = lowerTick; tick <= upperTick; tick += SPACING) {
        net += (await ctx.pool.ticks(tick)).liquidityNet;
      }
      expect(net).to.equal(0n);
    });
  });

  describe("TickMath", () => {
    it("round-trips a tick through its sqrt price across the whole domain", async () => {
      // getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t. If this drifts anywhere, every
      // range boundary in the protocol is off by a tick.
      const tickMath = await ethers.deployContract("TickMathTest");

      const ticks = [
        MIN_TICK,
        MIN_TICK + 1,
        -887271,
        -500000,
        -100000,
        -10000,
        -60,
        -1,
        0,
        1,
        60,
        10000,
        100000,
        500000,
        887271,
        MAX_TICK - 1,
      ];

      for (const tick of ticks) {
        const sqrtRatio = await tickMath.getSqrtRatioAtTick(tick);
        expect(await tickMath.getTickAtSqrtRatio(sqrtRatio), `tick ${tick}`).to.equal(BigInt(tick));
      }
    });

    it("agrees with the pool about where MIN_TICK and MAX_TICK are", async () => {
      const tickMath = await ethers.deployContract("TickMathTest");

      expect(await tickMath.MIN_SQRT_RATIO()).to.equal(4295128739n);
      expect(await tickMath.getSqrtRatioAtTick(MIN_TICK)).to.equal(await tickMath.MIN_SQRT_RATIO());
      expect(await tickMath.getSqrtRatioAtTick(MAX_TICK)).to.equal(await tickMath.MAX_SQRT_RATIO());
    });

    it("refuses a tick outside the domain", async () => {
      const tickMath = await ethers.deployContract("TickMathTest");

      await expect(tickMath.getSqrtRatioAtTick(MIN_TICK - 1)).to.be.revert(ethers);
      await expect(tickMath.getSqrtRatioAtTick(MAX_TICK + 1)).to.be.revert(ethers);
    });
  });
});
