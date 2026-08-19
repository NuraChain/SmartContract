import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  Q96,
  TICK_SPACING,
  createPool,
  deadline,
  deployV3,
  fullRange,
  mintPosition,
} from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * V2 and V3 on the same chain, over the same tokens, sharing the same WNURA.
 *
 * This is the point of the whole exercise: contracts/univ2 is live on Nurachain and has to
 * stay live. The two AMMs are independent by construction — different factories, different
 * pool bytecode, different addresses — but "by construction" is worth checking, because
 * the ways they could interfere are not obvious:
 *
 *   - Both derive pool addresses from a hardcoded init code hash. Two hashes, two
 *     libraries, and a build that disturbs either one breaks a deployed router.
 *   - This fork of V2 keeps its swap fee in factory storage and applies it to every pair.
 *     If that reached V3, a single call would reprice every V3 pool.
 *   - They share WNURA, which means they share the wrapped-native balance.
 */

const SPACING = TICK_SPACING[FEE.MEDIUM];
const RANGE = fullRange(SPACING);
const DEPTH = ethers.parseEther("100000");

/** Both AMMs deployed, both with a tokenA/tokenB pool, both pointed at the same WNURA. */
async function bothAmms() {
  const ctx = await deployV3();

  const v2Factory = await ethers.deployContract("UniswapV2Factory", [ctx.deployer.address]);
  const v2Router = await ethers.deployContract("UniswapV2Router02", [
    await v2Factory.getAddress(),
    await ctx.wnura.getAddress(),
  ]);

  const v2RouterAddress = await v2Router.getAddress();
  for (const token of [ctx.tokenA, ctx.tokenB]) {
    for (const who of [ctx.deployer, ctx.alice, ctx.bob]) {
      await token.connect(who).approve(v2RouterAddress, ethers.MaxUint256);
    }
  }

  // V2 side: one pair, seeded.
  const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);
  await v2Router.addLiquidity(a, b, DEPTH, DEPTH, 0n, 0n, ctx.deployer.address, await deadline());

  // V3 side: one 0.30% pool at the same 1:1 price, same depth.
  const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);
  await mintPosition(ctx, {
    token0: ctx.tokenA,
    token1: ctx.tokenB,
    fee: FEE.MEDIUM,
    ...RANGE,
    amount0: DEPTH,
    amount1: DEPTH,
  });

  return { ...ctx, v2Factory, v2Router, pool };
}

describe("V2 and V3 side by side", () => {
  it("puts the V2 pair and the V3 pool at different addresses", async () => {
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

    const pair = await ctx.v2Factory.getPair(a, b);
    const pool = await ctx.factory.getPool(a, b, FEE.MEDIUM);

    expect(pair).to.not.equal(ethers.ZeroAddress);
    expect(pool).to.not.equal(ethers.ZeroAddress);
    expect(pair).to.not.equal(pool);
  });

  it("trades on both in the same block", async () => {
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);
    const amountIn = ethers.parseEther("100");

    const before = await ctx.tokenB.balanceOf(ctx.alice.address);

    await ethers.provider.send("evm_setAutomine", [false]);
    await ctx.v2Router
      .connect(ctx.alice)
      .swapExactTokensForTokens(amountIn, 0n, [a, b], ctx.alice.address, await deadline());
    await ctx.swapRouter.connect(ctx.alice).exactInputSingle({
      tokenIn: a,
      tokenOut: b,
      fee: FEE.MEDIUM,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });
    await ethers.provider.send("evm_setAutomine", [true]);
    await networkHelpers.mine();

    // Both legs cleared; alice received roughly 200 of tokenB across the two.
    const received = (await ctx.tokenB.balanceOf(ctx.alice.address)) - before;
    expect(received).to.be.greaterThan(ethers.parseEther("197"));
    expect(received).to.be.lessThan(amountIn * 2n);
  });

  it("charges V2's 0.25% and V3's 0.30% on the same trade size", async () => {
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);
    const amountIn = ethers.parseEther("100");

    const v2Out = (await ctx.v2Router.getAmountsOut(amountIn, [a, b]))[1];
    const v3Out = await ctx.swapRouter.connect(ctx.alice).exactInputSingle.staticCall({
      tokenIn: a,
      tokenOut: b,
      fee: FEE.MEDIUM,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });

    // Same price, same depth, different fee — V2's 25bps beats V3's 30bps here. Which is
    // exactly why a router that assumed one fee for both would misprice every quote.
    expect(v2Out).to.be.greaterThan(v3Out);
    expect(await ctx.v2Factory.swapFee()).to.equal(25n);
    expect(await ctx.pool.fee()).to.equal(BigInt(FEE.MEDIUM));
  });

  it("leaves V3 untouched when V2's factory-wide fee is retuned", async () => {
    // setSwapFee reprices every V2 pair at once. V3's fee is immutable per pool and lives
    // in the pool's own bytecode-set state, so it cannot be reached from here.
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);
    const amountIn = ethers.parseEther("100");

    const quote = () =>
      ctx.swapRouter.connect(ctx.alice).exactInputSingle.staticCall({
        tokenIn: a,
        tokenOut: b,
        fee: FEE.MEDIUM,
        recipient: ctx.alice.address,
        deadline: 2n ** 32n,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      });

    const v3Before = await quote();
    const v2Before = (await ctx.v2Router.getAmountsOut(amountIn, [a, b]))[1];

    await ctx.v2Factory.setSwapFee(100); // 1.00%, the cap

    expect((await ctx.v2Router.getAmountsOut(amountIn, [a, b]))[1]).to.be.lessThan(v2Before);
    expect(await quote()).to.equal(v3Before);
    expect(await ctx.pool.fee()).to.equal(BigInt(FEE.MEDIUM));
  });

  it("keeps the two fee authorities separate", async () => {
    const ctx = await loadFixture(bothAmms);

    // V2's key cannot touch V3's factory...
    expect(await ctx.v2Factory.feeToSetter()).to.equal(ctx.deployer.address);
    await ctx.factory.setOwner(ctx.alice.address);
    await expect(ctx.factory.enableFeeAmount(4242, 60)).to.be.revert(ethers);

    // ...and V3's new owner has no say over V2.
    await expect(ctx.v2Factory.connect(ctx.alice).setSwapFee(50)).to.be.revertedWith(
      "UniswapV2: FORBIDDEN",
    );
    await ctx.v2Factory.setSwapFee(50);
    expect(await ctx.v2Factory.swapFee()).to.equal(50n);
  });

  it("shares one WNURA between both routers", async () => {
    const ctx = await loadFixture(bothAmms);

    expect(await ctx.v2Router.WETH()).to.equal(await ctx.wnura.getAddress());
    expect(await ctx.swapRouter.WETH9()).to.equal(await ctx.wnura.getAddress());
    expect(await ctx.positionManager.WETH9()).to.equal(await ctx.wnura.getAddress());
  });

  it("keeps each AMM's pool addresses derivable from its own init code hash", async () => {
    // Both routers compute addresses off-chain rather than asking their factory. Two
    // constants, two libraries — and Build.test.ts pins both.
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

    const v2Predicted = ethers.getCreate2Address(
      await ctx.v2Factory.getAddress(),
      ethers.keccak256(ethers.solidityPacked(["address", "address"], [a, b])),
      ethers.keccak256((await ethers.getContractFactory("UniswapV2Pair")).bytecode),
    );
    const v3Predicted = ethers.getCreate2Address(
      await ctx.factory.getAddress(),
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24"],
          [a, b, FEE.MEDIUM],
        ),
      ),
      ethers.keccak256((await ethers.getContractFactory("UniswapV3Pool")).bytecode),
    );

    expect(await ctx.v2Factory.getPair(a, b)).to.equal(v2Predicted);
    expect(await ctx.factory.getPool(a, b, FEE.MEDIUM)).to.equal(v3Predicted);
  });

  it("lets a V2 pair and a V3 pool over the same tokens hold different prices", async () => {
    // No arbitrage bot in a test, so the two just diverge. Worth stating: nothing in
    // either protocol keeps them in line, and a frontend showing one price for a pair is
    // showing one venue's price.
    const ctx = await loadFixture(bothAmms);
    const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

    await ctx.swapRouter.connect(ctx.alice).exactInputSingle({
      tokenIn: a,
      tokenOut: b,
      fee: FEE.MEDIUM,
      recipient: ctx.alice.address,
      deadline: await deadline(),
      amountIn: ethers.parseEther("5000"),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });

    const pair = await ethers.getContractAt("UniswapV2Pair", await ctx.v2Factory.getPair(a, b));
    const reserves = await pair.getReserves();

    // V2 untouched at 1:1, V3 pushed off it.
    expect(reserves[0]).to.equal(reserves[1]);
    expect((await ctx.pool.slot0()).sqrtPriceX96).to.be.lessThan(Q96);
  });
});
