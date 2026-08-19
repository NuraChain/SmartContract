import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  MIN_SQRT_RATIO,
  Q96,
  TICK_SPACING,
  createPool,
  deployV3,
  fullRange,
  mintPosition,
} from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture, time } = networkHelpers;

/**
 * The pool's built-in TWAP oracle.
 *
 * Every pool keeps a ring buffer of observations, each one a running sum of
 * tick * seconds. Two observations and the time between them give the time-weighted
 * average tick over that window — a price that cannot be moved by a single transaction,
 * because moving it means holding the price away from the market for real time.
 *
 * The buffer starts at ONE slot, which stores only the current block. Until someone pays
 * to grow it, `observe` can look back no further than the last write, and any "TWAP" read
 * from it is just the spot price. Growing it is a per-pool, permissionless, one-way cost
 * that somebody has to actually incur.
 *
 * Nurachain's block time is the thing that makes this a local decision rather than a
 * copied constant. At ~3.02s a slot covers ~3 seconds of history in the worst case (a
 * swap every block), so a 30-minute window needs ~600 slots where Ethereum's 12s blocks
 * need ~150. Four times the buffer, four times the cost.
 */

const SPACING = TICK_SPACING[FEE.MEDIUM];
const RANGE = fullRange(SPACING);
const DEPTH = ethers.parseEther("100000");

/** Measured against Nurachain's RPC over a 1000-block window. */
const NURA_BLOCK_SECONDS = 3.02;

/** Block timestamps are whole seconds, so advancing the clock uses the rounded value. */
const ONE_BLOCK = Math.round(NURA_BLOCK_SECONDS);

async function oraclePool() {
  const ctx = await deployV3();
  const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);

  await mintPosition(ctx, {
    token0: ctx.tokenA,
    token1: ctx.tokenB,
    fee: FEE.MEDIUM,
    ...RANGE,
    amount0: DEPTH,
    amount1: DEPTH,
  });

  return { ...ctx, pool };
}

async function swapDown(ctx: Awaited<ReturnType<typeof oraclePool>>, amount: bigint) {
  await ctx.callee
    .connect(ctx.alice)
    .swapExact0For1(await ctx.pool.getAddress(), amount, ctx.alice.address, MIN_SQRT_RATIO + 1n);
}

describe("V3 oracle", () => {
  describe("the observation buffer", () => {
    it("starts with a single slot", async () => {
      const { pool } = await loadFixture(oraclePool);
      const slot0 = await pool.slot0();

      expect(slot0.observationCardinality).to.equal(1n);
      expect(slot0.observationCardinalityNext).to.equal(1n);
    });

    it("cannot look back further than that one slot", async () => {
      const { pool } = await loadFixture(oraclePool);

      // The current block is fine; a minute ago is not recorded anywhere.
      await pool.observe([0]);
      await expect(pool.observe([60, 0])).to.be.revertedWith("OLD");
    });

    it("grows on request, and the growth takes effect on the next write", async () => {
      const ctx = await loadFixture(oraclePool);

      await ctx.pool.increaseObservationCardinalityNext(10);

      // `next` moves immediately; the live cardinality only catches up when an
      // observation is actually written.
      let slot0 = await ctx.pool.slot0();
      expect(slot0.observationCardinalityNext).to.equal(10n);
      expect(slot0.observationCardinality).to.equal(1n);

      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1"));

      slot0 = await ctx.pool.slot0();
      expect(slot0.observationCardinality).to.equal(10n);
    });

    it("is permissionless and one-way", async () => {
      const ctx = await loadFixture(oraclePool);

      // Anyone may pay to deepen a pool's oracle...
      await ctx.pool.connect(ctx.alice).increaseObservationCardinalityNext(20);
      expect((await ctx.pool.slot0()).observationCardinalityNext).to.equal(20n);

      // ...and nobody can shrink it again.
      await ctx.pool.increaseObservationCardinalityNext(5);
      expect((await ctx.pool.slot0()).observationCardinalityNext).to.equal(20n);
    });

    it("records at most one observation per block", async () => {
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(10);
      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1"));

      const indexBefore = (await ctx.pool.slot0()).observationIndex;

      // Three swaps mined in one block share a timestamp, so only the first writes.
      await networkHelpers.mine(0);
      await ethers.provider.send("evm_setAutomine", [false]);
      await swapDown(ctx, ethers.parseEther("1"));
      await swapDown(ctx, ethers.parseEther("1"));
      await ethers.provider.send("evm_setAutomine", [true]);
      await swapDown(ctx, ethers.parseEther("1"));

      const indexAfter = (await ctx.pool.slot0()).observationIndex;
      expect(indexAfter - indexBefore).to.be.at.most(1n);
    });
  });

  describe("reading a TWAP", () => {
    it("accumulates tick * seconds, so a longer window is a larger cumulative", async () => {
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(100);
      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1000"));

      const tick = (await ctx.pool.slot0()).tick;
      expect(tick).to.be.lessThan(0n); // token0 went in, price fell

      await time.increase(600);
      await networkHelpers.mine();

      const [cumulatives] = await ctx.pool.observe([600, 0]);
      // Negative ticks accumulate downwards, so the newer cumulative is the smaller one.
      expect(cumulatives[1]).to.be.lessThan(cumulatives[0]);
    });

    it("averages the tick over the window, not the endpoint", async () => {
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(100);

      // Half the window at tick 0, then a move, then the other half at the new tick.
      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1"));
      await time.increase(300);
      await networkHelpers.mine();

      const moved = ethers.parseEther("2000");
      await swapDown(ctx, moved);
      const spot = (await ctx.pool.slot0()).tick;

      await time.increase(300);
      await networkHelpers.mine();

      const [cumulatives] = await ctx.pool.observe([600, 0]);
      const twap = (cumulatives[1] - cumulatives[0]) / 600n;

      // The average sits between where the price started and where it ended.
      expect(twap).to.be.lessThan(0n);
      expect(twap).to.be.greaterThan(spot);
    });

    it("reports a flat TWAP when nothing traded", async () => {
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(10);
      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1"));

      const tick = (await ctx.pool.slot0()).tick;

      await time.increase(300);
      await networkHelpers.mine();

      const [cumulatives] = await ctx.pool.observe([300, 0]);
      expect((cumulatives[1] - cumulatives[0]) / 300n).to.equal(tick);
    });

    it("snapshots the cumulatives inside a range", async () => {
      // What a position's fee-growth accounting and any range-aware integration read.
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(10);
      await time.increase(ONE_BLOCK);
      await swapDown(ctx, ethers.parseEther("1"));

      const first = await ctx.pool.snapshotCumulativesInside(RANGE.tickLower, RANGE.tickUpper);
      await time.increase(300);
      await networkHelpers.mine();
      const second = await ctx.pool.snapshotCumulativesInside(RANGE.tickLower, RANGE.tickUpper);

      expect(second.secondsInside - first.secondsInside).to.be.closeTo(300n, 5n);
    });
  });

  describe("sizing the buffer for Nurachain", () => {
    it("needs about 600 slots for a 30-minute window at ~3s blocks", () => {
      // Not an assertion about the contracts — an assertion about the number anyone
      // deploying a pool here has to pick, so it is written down somewhere that fails
      // if the chain's block time changes.
      const windowSeconds = 30 * 60;
      const needed = Math.ceil(windowSeconds / NURA_BLOCK_SECONDS);

      expect(needed).to.be.within(590, 610);
      // Ethereum's 12s blocks would need a quarter of that, which is why copying
      // mainnet's cardinality onto this chain would silently give a ~7 minute TWAP.
      expect(Math.ceil(windowSeconds / 12)).to.equal(150);
    });

    it("can grow to 600 slots in a single transaction on this chain's gas limit", async () => {
      // Each new slot is a cold SSTORE, so this is the expensive part of running an
      // oracle. Nurachain's block gas limit is 150,000,000 — measured from the node —
      // so the whole buffer fits in one transaction with room to spare.
      const ctx = await loadFixture(oraclePool);

      const gas = await ctx.pool.increaseObservationCardinalityNext.estimateGas(600);

      expect(gas).to.be.lessThan(150_000_000n);
      console.log(`        growing to 600 observations costs ${gas} gas`);

      await ctx.pool.increaseObservationCardinalityNext(600);
      expect((await ctx.pool.slot0()).observationCardinalityNext).to.equal(600n);
    });

    it("still cannot see past what has actually been written", async () => {
      // A deep buffer is capacity, not history. A pool grown to 600 slots one second ago
      // still has one second of history, and anything reading a TWAP off it gets spot.
      const ctx = await loadFixture(oraclePool);
      await ctx.pool.increaseObservationCardinalityNext(600);

      await expect(ctx.pool.observe([1800, 0])).to.be.revertedWith("OLD");
    });
  });
});
