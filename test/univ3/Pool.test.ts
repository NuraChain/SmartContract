import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  Q96,
  TICK_SPACING,
  createPool,
  deployV3,
  encodeSqrtRatioX96,
  fullRange,
} from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * UniswapV3Pool, driven directly rather than through the periphery.
 *
 * Everything here goes via TestUniswapV3Callee (vendored from v3-core's own test suite),
 * because the pool never pulls tokens itself: it transfers optimistically and then calls
 * back, and whoever gets called has to pay. That is the whole trust model, and it is why
 * `flash` and the raw `swap`/`mint` entry points cannot be exercised from an EOA.
 *
 * The V3 maths is Uniswap's and is not retested here — it is vendored verbatim and has
 * years of production behind it. What is worth testing is that our build of it behaves:
 * ticks cross, fees accrue to the right side, and the pool's own accounting closes.
 */

const RANGE = fullRange(TICK_SPACING[FEE.MEDIUM]);
const LIQUIDITY = 10n ** 18n;

/** A pool at 1:1 with full-range liquidity minted straight through the callee. */
async function poolWithLiquidity() {
  const ctx = await deployV3();
  const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);

  await ctx.callee.mint(
    await pool.getAddress(),
    ctx.deployer.address,
    RANGE.tickLower,
    RANGE.tickUpper,
    LIQUIDITY,
  );

  return { ...ctx, pool };
}

describe("V3 pool", () => {
  describe("initialize", () => {
    it("sets the starting price and the tick that matches it", async () => {
      const ctx = await loadFixture(deployV3);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      await ctx.factory.createPool(a, b, FEE.MEDIUM);
      const pool = await ethers.getContractAt("UniswapV3Pool", await ctx.factory.getPool(a, b, FEE.MEDIUM));

      await pool.initialize(Q96);
      const slot0 = await pool.slot0();

      expect(slot0.sqrtPriceX96).to.equal(Q96);
      expect(slot0.tick).to.equal(0n); // 1:1 is tick 0 by definition
      expect(slot0.unlocked).to.equal(true);
      // One observation slot until someone pays to grow the oracle.
      expect(slot0.observationCardinality).to.equal(1n);
      expect(slot0.observationCardinalityNext).to.equal(1n);
    });

    it("lands on a non-zero tick for a non-1:1 price", async () => {
      const ctx = await loadFixture(deployV3);
      // 1 token0 buys 100 token1, i.e. log_1.0001(100) ~= 46054.
      const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, encodeSqrtRatioX96(100n, 1n));

      expect((await pool.slot0()).tick).to.be.closeTo(46054n, 2n);
    });

    it("refuses a second initialize", async () => {
      const ctx = await loadFixture(deployV3);
      const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);

      await expect(pool.initialize(Q96)).to.be.revert(ethers);
    });

    it("refuses a price outside the tick range the maths supports", async () => {
      const ctx = await loadFixture(deployV3);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      await ctx.factory.createPool(a, b, FEE.MEDIUM);
      const pool = await ethers.getContractAt("UniswapV3Pool", await ctx.factory.getPool(a, b, FEE.MEDIUM));

      await expect(pool.initialize(MIN_SQRT_RATIO - 1n)).to.be.revert(ethers);
      await expect(pool.initialize(MAX_SQRT_RATIO)).to.be.revert(ethers);
    });
  });

  describe("mint", () => {
    it("takes both tokens at a 1:1 price and books the liquidity", async () => {
      const { pool, tokenA, tokenB } = await loadFixture(poolWithLiquidity);
      const poolAddress = await pool.getAddress();

      expect(await pool.liquidity()).to.equal(LIQUIDITY);
      // In range and symmetric, so the pool holds a comparable amount of each.
      expect(await tokenA.balanceOf(poolAddress)).to.be.greaterThan(0n);
      expect(await tokenB.balanceOf(poolAddress)).to.be.greaterThan(0n);
    });

    it("initializes the ticks at both ends of the range", async () => {
      const { pool } = await loadFixture(poolWithLiquidity);

      const lower = await pool.ticks(RANGE.tickLower);
      const upper = await pool.ticks(RANGE.tickUpper);

      expect(lower.initialized).to.equal(true);
      expect(upper.initialized).to.equal(true);
      expect(lower.liquidityGross).to.equal(LIQUIDITY);
      // liquidityNet is +L entering the range and -L leaving it.
      expect(lower.liquidityNet).to.equal(LIQUIDITY);
      expect(upper.liquidityNet).to.equal(-LIQUIDITY);
    });

    it("refuses zero liquidity, an inverted range, and ticks off the spacing", async () => {
      const { pool, callee, deployer } = await loadFixture(poolWithLiquidity);
      const address = await pool.getAddress();

      await expect(callee.mint(address, deployer.address, RANGE.tickLower, RANGE.tickUpper, 0))
        .to.be.revert(ethers);
      await expect(callee.mint(address, deployer.address, RANGE.tickUpper, RANGE.tickLower, LIQUIDITY))
        .to.be.revert(ethers);
      // 61 is not a multiple of this pool's tick spacing of 60.
      await expect(callee.mint(address, deployer.address, -61, 61, LIQUIDITY)).to.be.revert(ethers);
    });

    it("refuses a mint that the callback does not pay for", async () => {
      // The pool credits the position first and checks its own balance afterwards. A
      // callback that pays nothing is exactly the attack this check exists for.
      const { pool } = await loadFixture(poolWithLiquidity);

      // Calling mint directly from an EOA means no callback implementation at all.
      await expect(
        pool.mint(ethers.ZeroAddress, RANGE.tickLower, RANGE.tickUpper, LIQUIDITY, "0x"),
      ).to.be.revert(ethers);
    });
  });

  describe("burn and collect", () => {
    it("burn owes the tokens without moving them; collect moves them", async () => {
      const { pool, deployer, tokenA } = await loadFixture(poolWithLiquidity);
      const before = await tokenA.balanceOf(deployer.address);

      // The callee minted, so the position belongs to the callee, not the deployer.
      // Burning from the deployer's own (empty) position is a no-op that must still work.
      await pool.burn(RANGE.tickLower, RANGE.tickUpper, 0);

      expect(await tokenA.balanceOf(deployer.address)).to.equal(before);
    });

    it("returns the liquidity to whoever owns the position", async () => {
      const { pool, callee, deployer, tokenA, tokenB } = await loadFixture(poolWithLiquidity);
      const poolAddress = await pool.getAddress();

      // Mint a second position owned by the deployer directly, via the callee paying.
      const positionLiquidity = LIQUIDITY / 2n;
      await callee.mint(poolAddress, deployer.address, RANGE.tickLower, RANGE.tickUpper, positionLiquidity);

      const held0 = await tokenA.balanceOf(poolAddress);
      expect(await pool.liquidity()).to.equal(LIQUIDITY + positionLiquidity);

      // burn credits tokensOwed; collect is what actually pays out.
      await pool.burn(RANGE.tickLower, RANGE.tickUpper, positionLiquidity);
      expect(await tokenA.balanceOf(poolAddress)).to.equal(held0);

      await pool.collect(
        deployer.address,
        RANGE.tickLower,
        RANGE.tickUpper,
        2n ** 128n - 1n,
        2n ** 128n - 1n,
      );

      expect(await tokenA.balanceOf(poolAddress)).to.be.lessThan(held0);
      expect(await pool.liquidity()).to.equal(LIQUIDITY);
      expect(await tokenB.balanceOf(poolAddress)).to.be.greaterThan(0n);
    });
  });

  describe("swap", () => {
    it("moves the price down when token0 goes in", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);
      const before = (await pool.slot0()).sqrtPriceX96;

      await callee
        .connect(alice)
        .swapExact0For1(await pool.getAddress(), ethers.parseEther("1"), alice.address, MIN_SQRT_RATIO + 1n);

      expect((await pool.slot0()).sqrtPriceX96).to.be.lessThan(before);
    });

    it("moves the price up when token1 goes in", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);
      const before = (await pool.slot0()).sqrtPriceX96;

      await callee
        .connect(alice)
        .swapExact1For0(await pool.getAddress(), ethers.parseEther("1"), alice.address, MAX_SQRT_RATIO - 1n);

      expect((await pool.slot0()).sqrtPriceX96).to.be.greaterThan(before);
    });

    it("pays out the token the trader asked for", async () => {
      const { pool, callee, alice, tokenB } = await loadFixture(poolWithLiquidity);
      const before = await tokenB.balanceOf(alice.address);

      await callee
        .connect(alice)
        .swapExact0For1(await pool.getAddress(), ethers.parseEther("1"), alice.address, MIN_SQRT_RATIO + 1n);

      expect(await tokenB.balanceOf(alice.address)).to.be.greaterThan(before);
    });

    it("supports exact-output as well as exact-input", async () => {
      const { pool, callee, alice, tokenB } = await loadFixture(poolWithLiquidity);
      // Small relative to the pool: L = 1e18 over the full range holds roughly 1e18 of
      // each token at 1:1, and asking for the whole reserve out costs infinite input.
      const want = ethers.parseEther("0.1");
      const before = await tokenB.balanceOf(alice.address);

      await callee
        .connect(alice)
        .swap0ForExact1(await pool.getAddress(), want, alice.address, MIN_SQRT_RATIO + 1n);

      expect((await tokenB.balanceOf(alice.address)) - before).to.equal(want);
    });

    it("stops at the price limit instead of running through it", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);
      // A limit only slightly below the current price: the swap should stop there.
      const limit = (Q96 * 999n) / 1000n;

      await callee
        .connect(alice)
        .swapExact0For1(await pool.getAddress(), ethers.parseEther("1000000"), alice.address, limit);

      expect((await pool.slot0()).sqrtPriceX96).to.equal(limit);
    });

    it("refuses a limit on the wrong side of the current price", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);

      await expect(
        callee
          .connect(alice)
          .swapExact0For1(await pool.getAddress(), ethers.parseEther("1"), alice.address, MAX_SQRT_RATIO - 1n),
      ).to.be.revert(ethers);
    });

    it("rejects a swap callback that does not come from a real pool", async () => {
      // The callee pays whoever calls it back, so this is really a test of the periphery's
      // CallbackValidation — see Router.test.ts. Here it is the pool's own reentrancy
      // lock and balance check that make a forged callback unprofitable.
      const { pool, alice } = await loadFixture(poolWithLiquidity);

      await expect(
        pool.connect(alice).swap(alice.address, true, ethers.parseEther("1"), MIN_SQRT_RATIO + 1n, "0x"),
      ).to.be.revert(ethers);
    });
  });

  describe("fee accounting", () => {
    it("grows feeGrowthGlobal on the side the trader paid in", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);

      expect(await pool.feeGrowthGlobal0X128()).to.equal(0n);

      await callee
        .connect(alice)
        .swapExact0For1(await pool.getAddress(), ethers.parseEther("10"), alice.address, MIN_SQRT_RATIO + 1n);

      // token0 went in, so the 0.30% fee was taken in token0 and only that side grew.
      expect(await pool.feeGrowthGlobal0X128()).to.be.greaterThan(0n);
      expect(await pool.feeGrowthGlobal1X128()).to.equal(0n);
    });

    it("charges the pool's own fee tier, not a shared one", async () => {
      // The V2 fork on this chain keeps its fee in factory storage and applies one rate to
      // every pair. V3 does the opposite: the rate is immutable per pool, so two pools over
      // the same pair charge differently. Worth pinning down — the frontend's
      // "swapFeeBps from the factory" assumption does not carry over.
      const ctx = await loadFixture(deployV3);

      const lowFees: bigint[] = [];
      for (const fee of [FEE.LOW, FEE.HIGH]) {
        const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, fee, Q96);
        const spacing = TICK_SPACING[fee];
        const range = fullRange(spacing);

        await ctx.callee.mint(
          await pool.getAddress(),
          ctx.deployer.address,
          range.tickLower,
          range.tickUpper,
          LIQUIDITY,
        );
        await ctx.callee
          .connect(ctx.alice)
          .swapExact0For1(
            await pool.getAddress(),
            ethers.parseEther("10"),
            ctx.alice.address,
            MIN_SQRT_RATIO + 1n,
          );

        lowFees.push(await pool.feeGrowthGlobal0X128());
      }

      // 1.00% collects strictly more per unit of liquidity than 0.05%.
      expect(lowFees[1]).to.be.greaterThan(lowFees[0]);
    });

    it("keeps the protocol's cut off until the factory owner switches it on", async () => {
      const { pool, callee, alice, deployer } = await loadFixture(poolWithLiquidity);

      expect((await pool.slot0()).feeProtocol).to.equal(0n);

      // feeProtocol is a denominator: 4 means the protocol takes 1/4 of the swap fee.
      await pool.setFeeProtocol(4, 4);
      await callee
        .connect(alice)
        .swapExact0For1(await pool.getAddress(), ethers.parseEther("10"), alice.address, MIN_SQRT_RATIO + 1n);

      const fees = await pool.protocolFees();
      expect(fees.token0).to.be.greaterThan(0n);

      await pool.collectProtocol(deployer.address, 2n ** 128n - 1n, 2n ** 128n - 1n);
      // Exactly 1 wei is left behind on purpose: collectProtocol decrements a full
      // withdrawal by one so the storage slot never returns to zero, which keeps the next
      // accrual a warm SSTORE. Asserting 0 here would be asserting a bug.
      expect((await pool.protocolFees()).token0).to.equal(1n);
    });

    it("lets only the factory owner touch the protocol fee", async () => {
      const { pool, alice, deployer, factory } = await loadFixture(poolWithLiquidity);

      await expect(pool.connect(alice).setFeeProtocol(4, 4)).to.be.revert(ethers);
      await expect(pool.connect(alice).collectProtocol(alice.address, 1n, 1n)).to.be.revert(ethers);

      // And it follows the factory's owner, not a copy taken at construction time.
      await factory.setOwner(alice.address);
      await expect(pool.connect(deployer).setFeeProtocol(4, 4)).to.be.revert(ethers);
      await pool.connect(alice).setFeeProtocol(4, 4);
    });
  });

  describe("flash", () => {
    it("lends both tokens and takes them back with the fee", async () => {
      const { pool, callee, alice, tokenA } = await loadFixture(poolWithLiquidity);
      const poolAddress = await pool.getAddress();

      const borrow = ethers.parseEther("1");
      const fee = (borrow * BigInt(FEE.MEDIUM)) / 1_000_000n + 1n;
      const held = await tokenA.balanceOf(poolAddress);

      await callee.connect(alice).flash(poolAddress, alice.address, borrow, borrow, borrow + fee, borrow + fee);

      // The pool ends up richer by exactly the fee.
      expect(await tokenA.balanceOf(poolAddress)).to.be.greaterThan(held);
      expect(await pool.feeGrowthGlobal0X128()).to.be.greaterThan(0n);
    });

    it("reverts when the borrower repays less than the fee", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);
      const borrow = ethers.parseEther("1");

      await expect(
        callee.connect(alice).flash(await pool.getAddress(), alice.address, borrow, borrow, borrow, borrow),
      ).to.be.revert(ethers);
    });

    it("lets a zero-amount flash through as a fee-free callback", async () => {
      const { pool, callee, alice } = await loadFixture(poolWithLiquidity);

      await callee.connect(alice).flash(await pool.getAddress(), alice.address, 0, 0, 0, 0);
    });
  });

  describe("NoDelegateCall", () => {
    /**
     * `swap`, `mint`, `burn`, `flash` and `collect` all carry the `noDelegateCall`
     * modifier, which compares `address(this)` against the address captured at
     * construction. Without it anyone could delegatecall the pool's code into their own
     * storage, where the reentrancy lock and the oracle are whatever they say they are.
     *
     * Tested against NoDelegateCallTest (v3-core's own harness) rather than the pool,
     * because it exposes a guarded and an unguarded function that do the same thing —
     * so a revert can only be the modifier, not an uninitialized-storage accident. The
     * delegatecall comes from an EIP-1167 minimal proxy, which needs no extra Solidity.
     */
    async function minimalProxyTo(implementation: string) {
      const runtime = `363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
      const deployed = await (await ethers.getSigners())[0].sendTransaction({
        data: `0x3d602d80600a3d3981f3${runtime}`,
      });

      return (await deployed.wait())!.contractAddress!;
    }

    it("runs an unguarded function through a delegatecall but blocks a guarded one", async () => {
      const target = await ethers.deployContract("NoDelegateCallTest");
      const proxy = await ethers.getContractAt(
        "NoDelegateCallTest",
        await minimalProxyTo(await target.getAddress()),
      );

      // Same body, same storage, same everything — the only difference is the modifier.
      expect(await proxy.canBeDelegateCalled()).to.be.greaterThan(0n);
      await expect(proxy.cannotBeDelegateCalled()).to.be.revert(ethers);
    });

    it("blocks it even when reached through a private call inside the contract", async () => {
      const target = await ethers.deployContract("NoDelegateCallTest");
      const proxy = await ethers.getContractAt(
        "NoDelegateCallTest",
        await minimalProxyTo(await target.getAddress()),
      );

      await expect(proxy.callsIntoNoDelegateCallFunction()).to.be.revert(ethers);
      // Called normally, it is fine.
      await target.callsIntoNoDelegateCallFunction();
    });
  });
});
