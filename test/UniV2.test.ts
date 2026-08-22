import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

// The AMM math is UniswapV2's and is not retested here — it is vendored verbatim and
// has a decade of production behind it. What is worth testing is everything this repo
// could get wrong about it: the init code hash baked into UniswapV2Library by
// scripts/write-init-code-hash.ts, the wiring between router, factory and WNURA, and
// that a swap actually clears end to end on our build with our compiler settings.

const SUPPLY = ethers.parseEther("1000000");

async function deploySwap() {
  const [deployer, alice] = await ethers.getSigners();

  const wnura = await ethers.deployContract("WNURA", deployer);
  const factory = await ethers.deployContract("UniswapV2Factory", [deployer.address], deployer);
  const router = await ethers.deployContract(
    "UniswapV2Router02",
    [await factory.getAddress(), await wnura.getAddress()],
    deployer,
  );

  const tokenA = await ethers.deployContract(
    "MockToken",
    ["Mock Tether USD", "mUSDT", 18, false],
    deployer,
  );
  const tokenB = await ethers.deployContract("MockToken", ["Mock Dai", "mDAI", 18, false], deployer);

  for (const token of [tokenA, tokenB]) {
    await token.mint(deployer.address, SUPPLY);
    await token.mint(alice.address, SUPPLY);
    await token.approve(await router.getAddress(), ethers.MaxUint256);
    await token.connect(alice).approve(await router.getAddress(), ethers.MaxUint256);
  }

  return { wnura, factory, router, tokenA, tokenB, deployer, alice };
}

/** A pool of 100k of each token, so prices are round and slippage is small. */
async function deployWithLiquidity() {
  const ctx = await deploySwap();
  const amount = ethers.parseEther("100000");

  await ctx.router.addLiquidity(
    await ctx.tokenA.getAddress(),
    await ctx.tokenB.getAddress(),
    amount,
    amount,
    0n,
    0n,
    ctx.deployer.address,
    await deadline(),
  );

  return ctx;
}

async function deadline() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp) + 3600n;
}

/** The pair address CREATE2 puts a pair at, worked out from our compiled Pair. */
async function predictPair(factory: string, tokenX: string, tokenY: string) {
  const [token0, token1] =
    tokenX.toLowerCase() < tokenY.toLowerCase() ? [tokenX, tokenY] : [tokenY, tokenX];

  return ethers.getCreate2Address(
    factory,
    ethers.keccak256(ethers.solidityPacked(["address", "address"], [token0, token1])),
    ethers.keccak256((await ethers.getContractFactory("UniswapV2Pair")).bytecode),
  );
}

/** Floor integer square root, matching the Babylonian method in UniswapV2's Math.sqrt. */
function sqrt(value: bigint): bigint {
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }

  return x;
}

describe("UniswapV2", () => {
  describe("deployment", () => {
    it("wires the router to the factory and the wrapped native coin", async () => {
      const { router, factory, wnura } = await loadFixture(deploySwap);

      expect(await router.factory()).to.equal(await factory.getAddress());
      expect(await router.WETH()).to.equal(await wnura.getAddress());
      expect(await wnura.symbol()).to.equal("WNURA");
    });

    it("starts with the protocol fee off and feeToSetter holding the switch", async () => {
      const { factory, deployer } = await loadFixture(deploySwap);

      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
      expect(await factory.feeToSetter()).to.equal(deployer.address);
      expect(await factory.allPairsLength()).to.equal(0n);
    });
  });

  // If the constant in UniswapV2Library does not match the Pair this repo compiles,
  // every router call computes an address with no contract at it. These are the tests
  // that fail when someone changes the optimizer settings or moves the source file
  // without rerunning `npm run initcodehash`.
  describe("pair init code hash", () => {
    it("puts a new pair exactly where CREATE2 on our Pair bytecode says", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deploySwap);
      const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()];

      await factory.createPair(a, b);

      expect(await factory.getPair(a, b)).to.equal(await predictPair(await factory.getAddress(), a, b));
    });

    it("lets the router find that pair without asking the factory", async () => {
      // getAmountsOut goes through UniswapV2Library.pairFor and then calls getReserves
      // on whatever address it computed. A stale hash reverts here.
      const { router, tokenA, tokenB } = await loadFixture(deployWithLiquidity);

      const amounts = await router.getAmountsOut(ethers.parseEther("1000"), [
        await tokenA.getAddress(),
        await tokenB.getAddress(),
      ]);

      expect(amounts[0]).to.equal(ethers.parseEther("1000"));
      expect(amounts[1]).to.be.greaterThan(0n);
    });
  });

  describe("liquidity", () => {
    it("creates the pair on first addLiquidity and mints LP tokens", async () => {
      const { router, factory, tokenA, tokenB, deployer } = await loadFixture(deploySwap);
      const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amount = ethers.parseEther("100000");

      expect(await factory.getPair(a, b)).to.equal(ethers.ZeroAddress);

      await router.addLiquidity(a, b, amount, amount, 0n, 0n, deployer.address, await deadline());

      const pairAddress = await factory.getPair(a, b);
      expect(pairAddress).to.not.equal(ethers.ZeroAddress);

      const pair = await ethers.getContractAt("UniswapV2Pair", pairAddress);
      const [reserve0, reserve1] = await pair.getReserves();

      expect(reserve0).to.equal(amount);
      expect(reserve1).to.equal(amount);
      // The first provider gets sqrt(x*y) minus the 1000 wei burned forever, which is
      // what stops the pool from being drained to zero and re-primed at a fake price.
      expect(await pair.balanceOf(deployer.address)).to.equal(amount - 1000n);
      expect(await pair.totalSupply()).to.equal(amount);
    });

    it("gives the liquidity back on removeLiquidity", async () => {
      const { router, factory, tokenA, tokenB, deployer } = await loadFixture(deployWithLiquidity);
      const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()];

      const pair = await ethers.getContractAt("UniswapV2Pair", await factory.getPair(a, b));
      const liquidity = await pair.balanceOf(deployer.address);
      await pair.approve(await router.getAddress(), liquidity);

      const before = await tokenA.balanceOf(deployer.address);
      await router.removeLiquidity(a, b, liquidity, 0n, 0n, deployer.address, await deadline());

      expect(await tokenA.balanceOf(deployer.address)).to.be.greaterThan(before);
      expect(await pair.balanceOf(deployer.address)).to.equal(0n);
    });
  });

  describe("swapping", () => {
    it("pays out exactly what getAmountsOut quoted", async () => {
      const { router, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amountIn = ethers.parseEther("1000");

      const quoted = await router.getAmountsOut(amountIn, path);
      const before = await tokenB.balanceOf(alice.address);

      await router
        .connect(alice)
        .swapExactTokensForTokens(amountIn, quoted[1], path, alice.address, await deadline());

      expect(await tokenB.balanceOf(alice.address)).to.equal(before + quoted[1]);
    });

    it("takes the 0.25% fee, so a round trip comes back short", async () => {
      const { router, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amountIn = ethers.parseEther("1000");

      const before = await tokenA.balanceOf(alice.address);

      await router
        .connect(alice)
        .swapExactTokensForTokens(amountIn, 0n, [a, b], alice.address, await deadline());

      const received = await tokenB.balanceOf(alice.address);
      await router
        .connect(alice)
        .swapExactTokensForTokens(received - SUPPLY, 0n, [b, a], alice.address, await deadline());

      const after = await tokenA.balanceOf(alice.address);
      expect(after).to.be.lessThan(before);
      // Two hops at 0.25% each: 1 - 0.9975^2, so ~0.4994% of the trade is gone.
      // These bounds straddle 0.25% and exclude 0.30% (which would lose ~0.5991%),
      // so this test fails if the pair and the library drift apart on the rate.
      expect(before - after).to.be.greaterThan((amountIn * 4n) / 1000n);
      expect(before - after).to.be.lessThan((amountIn * 55n) / 10000n);
    });

    it("refuses a swap whose deadline has passed", async () => {
      const { router, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const block = await ethers.provider.getBlock("latest");
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];

      await expect(
        router
          .connect(alice)
          .swapExactTokensForTokens(1000n, 0n, path, alice.address, BigInt(block!.timestamp) - 1n),
      ).to.be.revertedWith("UniswapV2Router: EXPIRED");
    });

    it("refuses a swap that would land under the minimum out", async () => {
      const { router, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amountIn = ethers.parseEther("1000");
      const quoted = await router.getAmountsOut(amountIn, path);

      await expect(
        router
          .connect(alice)
          .swapExactTokensForTokens(amountIn, quoted[1] + 1n, path, alice.address, await deadline()),
      ).to.be.revertedWith("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
    });
  });

  describe("native coin routing", () => {
    it("wraps on the way in and unwraps on the way out", async () => {
      const { router, wnura, factory, tokenA, deployer, alice } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();

      await router.addLiquidityETH(
        a,
        ethers.parseEther("100000"),
        0n,
        0n,
        deployer.address,
        await deadline(),
        { value: ethers.parseEther("100") },
      );

      // The pool holds wrapped coin, not native — that is the whole job of WNURA here.
      const pairAddress = await factory.getPair(a, await wnura.getAddress());
      expect(await wnura.balanceOf(pairAddress)).to.equal(ethers.parseEther("100"));

      const before = await tokenA.balanceOf(alice.address);
      await router
        .connect(alice)
        .swapExactETHForTokens(0n, [await wnura.getAddress(), a], alice.address, await deadline(), {
          value: ethers.parseEther("1"),
        });

      expect(await tokenA.balanceOf(alice.address)).to.be.greaterThan(before);
    });
  });

  // Upstream UniswapV2 hardcodes the fee in the pair bytecode. Here it is a slot on the
  // factory that feeToSetter can retune, which buys flexibility and costs a trust
  // assumption — hence the cap, and hence these tests.
  describe("the adjustable fee", () => {
    it("starts at 0.25% and cannot be raised past 1%", async () => {
      const { factory } = await loadFixture(deploySwap);

      expect(await factory.swapFee()).to.equal(25n);
      expect(await factory.MAX_SWAP_FEE()).to.equal(100n);
    });

    it("lets feeToSetter retune it and announces the change", async () => {
      const { factory } = await loadFixture(deploySwap);

      await expect(factory.setSwapFee(10)).to.emit(factory, "SwapFeeUpdated").withArgs(25, 10);
      expect(await factory.swapFee()).to.equal(10n);
    });

    it("blocks anyone who is not feeToSetter", async () => {
      const { factory, alice } = await loadFixture(deploySwap);

      await expect(factory.connect(alice).setSwapFee(10)).to.be.revertedWith(
        "UniswapV2: FORBIDDEN",
      );
      expect(await factory.swapFee()).to.equal(25n);
    });

    // The cap is the whole reason a mutable fee is not simply a rug: without it, the
    // key holder could set 100% and take every trade in full.
    it("refuses any fee above the cap", async () => {
      const { factory } = await loadFixture(deploySwap);

      await expect(factory.setSwapFee(101)).to.be.revertedWith("UniswapV2: SWAP_FEE_TOO_HIGH");
      await expect(factory.setSwapFee(10000)).to.be.revertedWith("UniswapV2: SWAP_FEE_TOO_HIGH");
      expect(await factory.swapFee()).to.equal(25n);
    });

    // The one that matters. The pair enforces the fee in its K check and the library
    // quotes it, from the same slot. If a change moved only one of them, this either
    // reverts on K or pays the stale rate.
    it("charges the new rate on the next swap, pair and router in step", async () => {
      const { router, factory, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amountIn = ethers.parseEther("1000");

      const at25 = (await router.getAmountsOut(amountIn, path))[1];

      await factory.setSwapFee(5); // 0.05%
      const at5 = (await router.getAmountsOut(amountIn, path))[1];
      expect(at5).to.be.greaterThan(at25);

      // amountOutMin is the exact quote, so the pair has to honour it to the wei.
      const before = await tokenB.balanceOf(alice.address);
      await router
        .connect(alice)
        .swapExactTokensForTokens(amountIn, at5, path, alice.address, await deadline());

      expect(await tokenB.balanceOf(alice.address)).to.equal(before + at5);
    });

    it("still clears at the 1% ceiling and at no fee at all", async () => {
      const { router, factory, tokenA, tokenB, alice } = await loadFixture(deployWithLiquidity);
      const path = [await tokenA.getAddress(), await tokenB.getAddress()];
      const amountIn = ethers.parseEther("1000");

      for (const fee of [100n, 0n]) {
        await factory.setSwapFee(fee);
        const quoted = (await router.getAmountsOut(amountIn, path))[1];
        const before = await tokenB.balanceOf(alice.address);

        await router
          .connect(alice)
          .swapExactTokensForTokens(amountIn, quoted, path, alice.address, await deadline());

        expect(await tokenB.balanceOf(alice.address)).to.equal(before + quoted);
      }
    });
  });

  // ---------------------------------------------------------------------------------
  // The protocol fee is the 1/6 slice of trading fees the factory can switch on by
  // setting feeTo. It is minted as LP tokens during liquidity events rather than taken
  // per swap, so nothing about it shows up until someone mints or burns — which is
  // exactly why it is worth pinning down.
  // ---------------------------------------------------------------------------------
  describe("the protocol fee", () => {
    /** Pool with liquidity, plus a handle on the pair and a collector address. */
    async function withPair() {
      const ctx = await loadFixture(deployWithLiquidity);
      const [, , collector] = await ethers.getSigners();

      const pairAddress = await ctx.factory.getPair(
        await ctx.tokenA.getAddress(),
        await ctx.tokenB.getAddress(),
      );
      const pair = await ethers.getContractAt("UniswapV2Pair", pairAddress);

      return { ...ctx, pair, pairAddress, collector };
    }

    /** Trades back and forth so K grows by accumulated fees. */
    async function churn(ctx: Awaited<ReturnType<typeof withPair>>, rounds = 4) {
      const a = await ctx.tokenA.getAddress();
      const b = await ctx.tokenB.getAddress();
      const size = ethers.parseEther("5000");

      for (let i = 0; i < rounds; i++) {
        await ctx.router
          .connect(ctx.alice)
          .swapExactTokensForTokens(size, 0n, [a, b], ctx.alice.address, await deadline());
        await ctx.router
          .connect(ctx.alice)
          .swapExactTokensForTokens(size, 0n, [b, a], ctx.alice.address, await deadline());
      }
    }

    /** Adds a little liquidity, which is what makes the pair settle the protocol fee. */
    async function touchLiquidity(ctx: Awaited<ReturnType<typeof withPair>>) {
      const amount = ethers.parseEther("100");

      await ctx.router.addLiquidity(
        await ctx.tokenA.getAddress(),
        await ctx.tokenB.getAddress(),
        amount,
        amount,
        0n,
        0n,
        ctx.deployer.address,
        await deadline(),
      );
    }

    it("mints nothing and tracks no kLast while feeTo is unset", async () => {
      const ctx = await withPair();

      expect(await ctx.factory.feeTo()).to.equal(ethers.ZeroAddress);
      expect(await ctx.pair.kLast()).to.equal(0n);

      // address(0) already holds MINIMUM_LIQUIDITY from the first mint — the permanent
      // lock every pair burns, which is not the protocol fee. What matters is that it
      // does not grow, since an unset feeTo is also address(0).
      const locked = await ctx.pair.balanceOf(ethers.ZeroAddress);
      expect(locked).to.equal(await ctx.pair.MINIMUM_LIQUIDITY());

      await churn(ctx);
      await touchLiquidity(ctx);

      // Fees stayed with the liquidity providers: nothing was minted to anyone else.
      expect(await ctx.pair.kLast()).to.equal(0n);
      expect(await ctx.pair.balanceOf(ethers.ZeroAddress)).to.equal(locked);
    });

    it("starts tracking kLast as soon as feeTo is set", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      expect(await ctx.pair.kLast()).to.equal(0n);

      // kLast is written on the first liquidity event after the switch, not on the switch.
      await touchLiquidity(ctx);

      const [reserve0, reserve1] = await ctx.pair.getReserves();
      expect(await ctx.pair.kLast()).to.equal(reserve0 * reserve1);
    });

    it("pays the collector LP tokens out of the growth in K", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      await touchLiquidity(ctx);

      expect(await ctx.pair.balanceOf(ctx.collector.address)).to.equal(0n);

      await churn(ctx);
      await touchLiquidity(ctx);

      const minted = await ctx.pair.balanceOf(ctx.collector.address);
      expect(minted).to.be.greaterThan(0n);

      // The collector holds LP, not tokens: its claim is on the pool, like any other LP.
      expect(await ctx.tokenA.balanceOf(ctx.collector.address)).to.equal(0n);
      expect(await ctx.tokenB.balanceOf(ctx.collector.address)).to.equal(0n);
    });

    it("mints the 1/6 share the formula specifies", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      await touchLiquidity(ctx);

      const kLastBefore = await ctx.pair.kLast();
      const supplyBefore = await ctx.pair.totalSupply();

      await churn(ctx, 6);

      // Recompute _mintFee's arithmetic from the state it will see, then trigger it.
      const [reserve0, reserve1] = await ctx.pair.getReserves();
      const rootK = sqrt(reserve0 * reserve1);
      const rootKLast = sqrt(kLastBefore);
      const expected = (supplyBefore * (rootK - rootKLast)) / (rootK * 5n + rootKLast);

      await touchLiquidity(ctx);

      expect(await ctx.pair.balanceOf(ctx.collector.address)).to.equal(expected);
      expect(expected).to.be.greaterThan(0n);
    });

    it("lets the collector redeem its LP for real tokens", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      await touchLiquidity(ctx);
      await churn(ctx, 6);
      await touchLiquidity(ctx);

      const lp = await ctx.pair.balanceOf(ctx.collector.address);
      expect(lp).to.be.greaterThan(0n);

      await ctx.pair.connect(ctx.collector).approve(await ctx.router.getAddress(), lp);
      await ctx.router
        .connect(ctx.collector)
        .removeLiquidity(
          await ctx.tokenA.getAddress(),
          await ctx.tokenB.getAddress(),
          lp,
          0n,
          0n,
          ctx.collector.address,
          await deadline(),
        );

      expect(await ctx.tokenA.balanceOf(ctx.collector.address)).to.be.greaterThan(0n);
      expect(await ctx.tokenB.balanceOf(ctx.collector.address)).to.be.greaterThan(0n);
      expect(await ctx.pair.balanceOf(ctx.collector.address)).to.equal(0n);
    });

    it("clears kLast when the fee is switched back off", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      await touchLiquidity(ctx);
      expect(await ctx.pair.kLast()).to.be.greaterThan(0n);

      await ctx.factory.setFeeTo(ethers.ZeroAddress);
      await churn(ctx);
      await touchLiquidity(ctx);

      // Left set, a stale kLast would hand the next collector a share of growth that
      // accrued while the fee was off.
      expect(await ctx.pair.kLast()).to.equal(0n);
    });

    it("accrues nothing for the collector across a period with no trading", async () => {
      const ctx = await withPair();

      await ctx.factory.setFeeTo(ctx.collector.address);
      await touchLiquidity(ctx);
      await touchLiquidity(ctx);

      // K only grows on fees, so liquidity events on their own owe the collector nothing.
      expect(await ctx.pair.balanceOf(ctx.collector.address)).to.equal(0n);
    });
  });

  describe("fee authority", () => {
    it("blocks everyone but feeToSetter from setFeeTo and setFeeToSetter", async () => {
      const { factory, alice } = await loadFixture(deploySwap);

      await expect(factory.connect(alice).setFeeTo(alice.address)).to.be.revertedWith(
        "UniswapV2: FORBIDDEN",
      );
      await expect(factory.connect(alice).setFeeToSetter(alice.address)).to.be.revertedWith(
        "UniswapV2: FORBIDDEN",
      );
    });

    it("hands all three powers over together and strips them from the old setter", async () => {
      const { factory, deployer, alice } = await loadFixture(deploySwap);

      await factory.setFeeToSetter(alice.address);
      expect(await factory.feeToSetter()).to.equal(alice.address);

      // The new setter holds every power the old one had.
      await factory.connect(alice).setFeeTo(alice.address);
      await factory.connect(alice).setSwapFee(30);
      expect(await factory.feeTo()).to.equal(alice.address);
      expect(await factory.swapFee()).to.equal(30n);

      // And the old one has none of them left. These are thunks, not calls: an array of
      // already-invoked promises leaves the later rejections unhandled until the loop
      // reaches them, which Node intermittently reports as an unhandled rejection and
      // kills the run over.
      for (const call of [
        () => factory.setFeeTo(deployer.address),
        () => factory.setSwapFee(25),
        () => factory.setFeeToSetter(deployer.address),
      ]) {
        await expect(call()).to.be.revertedWith("UniswapV2: FORBIDDEN");
      }
    });

    it("keeps MAX_SWAP_FEE fixed at 1% with no way to raise it", async () => {
      const { factory } = await loadFixture(deploySwap);

      expect(await factory.MAX_SWAP_FEE()).to.equal(100n);

      // A constant has no setter; the ABI is the proof that the ceiling cannot move.
      expect(factory.interface.hasFunction("setMaxSwapFee")).to.equal(false);
      await expect(factory.setSwapFee(101)).to.be.revertedWith("UniswapV2: SWAP_FEE_TOO_HIGH");
      expect(await factory.swapFee()).to.equal(25n);
    });

    it("allows the exact ceiling and the exact floor", async () => {
      const { factory } = await loadFixture(deploySwap);

      await factory.setSwapFee(100);
      expect(await factory.swapFee()).to.equal(100n);

      await factory.setSwapFee(0);
      expect(await factory.swapFee()).to.equal(0n);
    });
  });

  describe("createPair validation", () => {
    it("refuses identical tokens", async () => {
      const { factory, tokenA } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();

      await expect(factory.createPair(a, a)).to.be.revertedWith("UniswapV2: IDENTICAL_ADDRESSES");
    });

    it("refuses the zero address on either side", async () => {
      const { factory, tokenA } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();

      await expect(factory.createPair(ethers.ZeroAddress, a)).to.be.revertedWith(
        "UniswapV2: ZERO_ADDRESS",
      );
      await expect(factory.createPair(a, ethers.ZeroAddress)).to.be.revertedWith(
        "UniswapV2: ZERO_ADDRESS",
      );
    });

    it("refuses a duplicate pair in either token order", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();

      await factory.createPair(a, b);

      await expect(factory.createPair(a, b)).to.be.revertedWith("UniswapV2: PAIR_EXISTS");
      await expect(factory.createPair(b, a)).to.be.revertedWith("UniswapV2: PAIR_EXISTS");
    });

    it("registers the pair under both orderings and appends it to allPairs", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();

      expect(await factory.allPairsLength()).to.equal(0n);

      await expect(factory.createPair(a, b)).to.emit(factory, "PairCreated");

      const pair = await factory.getPair(a, b);
      expect(await factory.getPair(b, a)).to.equal(pair);
      expect(await factory.allPairsLength()).to.equal(1n);
      expect(await factory.allPairs(0)).to.equal(pair);
    });

    it("sorts token0 and token1 by address regardless of argument order", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deploySwap);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      const [expected0, expected1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

      await factory.createPair(b, a);
      const pair = await ethers.getContractAt("UniswapV2Pair", await factory.getPair(a, b));

      expect(await pair.token0()).to.equal(expected0);
      expect(await pair.token1()).to.equal(expected1);
    });
  });

  // ---------------------------------------------------------------------------------
  // swap() calls out to `to` before its K check whenever data is non-empty. That is the
  // flash-swap path, and the `lock` modifier is the only thing standing between it and a
  // re-entrant drain.
  // ---------------------------------------------------------------------------------
  describe("flash swaps and the pair lock", () => {
    async function withBorrower(name: string) {
      const ctx = await loadFixture(deployWithLiquidity);
      const pairAddress = await ctx.factory.getPair(
        await ctx.tokenA.getAddress(),
        await ctx.tokenB.getAddress(),
      );
      const pair = await ethers.getContractAt("UniswapV2Pair", pairAddress);
      const borrower = await ethers.deployContract(name, ctx.deployer);

      // Stake the borrower so it can cover the fee on repayment.
      await ctx.tokenA.transfer(await borrower.getAddress(), ethers.parseEther("1000"));
      await ctx.tokenB.transfer(await borrower.getAddress(), ethers.parseEther("1000"));

      const token0 = await pair.token0();
      const borrowAmount = ethers.parseEther("1000");
      const [out0, out1] =
        token0.toLowerCase() === (await ctx.tokenA.getAddress()).toLowerCase()
          ? [borrowAmount, 0n]
          : [0n, borrowAmount];

      return { ...ctx, pair, pairAddress, borrower, out0, out1 };
    }

    it("lets an honest borrower take and repay a flash swap", async () => {
      const ctx = await withBorrower("FlashBorrower");
      const [r0Before, r1Before] = await ctx.pair.getReserves();

      await ctx.borrower.flash(ctx.pairAddress, ctx.out0, ctx.out1);

      expect(await ctx.borrower.called()).to.equal(true);

      // The pool kept the fee, so both reserves are at least where they started.
      const [r0After, r1After] = await ctx.pair.getReserves();
      expect(r0After).to.be.greaterThanOrEqual(r0Before);
      expect(r1After).to.be.greaterThanOrEqual(r1Before);
    });

    it("rejects a flash swap that repays too little to satisfy K", async () => {
      const ctx = await withBorrower("FlashBorrower");

      // 0 bps back means returning exactly what was borrowed, which leaves K short by
      // the fee. The pair's invariant check is what catches it.
      await ctx.borrower.setRepayMarginBps(0);

      await expect(
        ctx.borrower.flash(ctx.pairAddress, ctx.out0, ctx.out1),
      ).to.be.revertedWith("UniswapV2: K");
    });

    it("blocks a swap re-entered from the flash callback", async () => {
      const ctx = await withBorrower("ReentrantBorrower");

      await ctx.borrower.flash(ctx.pairAddress, ctx.out0, ctx.out1);

      expect(await ctx.borrower.called()).to.equal(true);
      expect(await ctx.borrower.reentryReverted()).to.equal(true);
    });

    it("refuses a swap asking for more than the pool holds", async () => {
      const ctx = await withBorrower("FlashBorrower");
      const [r0] = await ctx.pair.getReserves();

      await expect(
        ctx.borrower.flash(ctx.pairAddress, r0, 0n),
      ).to.be.revertedWith("UniswapV2: INSUFFICIENT_LIQUIDITY");
    });

    it("refuses a swap with no output at all", async () => {
      const ctx = await withBorrower("FlashBorrower");

      await expect(
        ctx.borrower.flash(ctx.pairAddress, 0n, 0n),
      ).to.be.revertedWith("UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT");
    });
  });
});
