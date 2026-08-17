import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

// The AMM math is UniswapV2's and is not retested here — it is vendored verbatim and
// has a decade of production behind it. What is worth testing is everything this repo
// could get wrong about it: the init code hash baked into UniswapV2Library by
// scripts/write-init-code-hash.ts, the wiring between router, factory and WBNB, and
// that a swap actually clears end to end on our build with our compiler settings.

const SUPPLY = ethers.parseEther("1000000");

async function deploySwap() {
  const [deployer, alice] = await ethers.getSigners();

  const wbnb = await ethers.deployContract("WBNB", deployer);
  const factory = await ethers.deployContract("UniswapV2Factory", [deployer.address], deployer);
  const router = await ethers.deployContract(
    "UniswapV2Router02",
    [await factory.getAddress(), await wbnb.getAddress()],
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

  return { wbnb, factory, router, tokenA, tokenB, deployer, alice };
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

describe("Swap", () => {
  describe("deployment", () => {
    it("wires the router to the factory and the wrapped native coin", async () => {
      const { router, factory, wbnb } = await loadFixture(deploySwap);

      expect(await router.factory()).to.equal(await factory.getAddress());
      expect(await router.WETH()).to.equal(await wbnb.getAddress());
      expect(await wbnb.symbol()).to.equal("WBNB");
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

    it("takes the 0.30% fee, so a round trip comes back short", async () => {
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
      // Two hops at 0.30% each, so ~0.6% of the trade is gone.
      expect(before - after).to.be.greaterThan((amountIn * 5n) / 1000n);
      expect(before - after).to.be.lessThan((amountIn * 7n) / 1000n);
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
      const { router, wbnb, factory, tokenA, deployer, alice } = await loadFixture(deploySwap);
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

      // The pool holds wrapped coin, not native — that is the whole job of WBNB here.
      const pairAddress = await factory.getPair(a, await wbnb.getAddress());
      expect(await wbnb.balanceOf(pairAddress)).to.equal(ethers.parseEther("100"));

      const before = await tokenA.balanceOf(alice.address);
      await router
        .connect(alice)
        .swapExactETHForTokens(0n, [await wbnb.getAddress(), a], alice.address, await deadline(), {
          value: ethers.parseEther("1"),
        });

      expect(await tokenA.balanceOf(alice.address)).to.be.greaterThan(before);
    });
  });
});
