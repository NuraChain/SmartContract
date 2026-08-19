import { expect } from "chai";
import { network } from "hardhat";

import {
  FEE,
  MIN_SQRT_RATIO,
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
 * NonfungiblePositionManager — V3 liquidity as an ERC721.
 *
 * The NFT is not decoration. A V3 position is identified by (owner, tickLower, tickUpper)
 * inside the pool, which would make positions non-transferable and impossible to hold in
 * a contract that does not know about V3. The position manager owns every position in the
 * pool on everyone's behalf and hands out a token that says who really owns each one — so
 * transferring the token transfers the liquidity, the uncollected fees and all.
 */

const SPACING = TICK_SPACING[FEE.MEDIUM];
const RANGE = fullRange(SPACING);
const AMOUNT = ethers.parseEther("1000");
const MAX_U128 = 2n ** 128n - 1n;

async function pooled() {
  const ctx = await deployV3();
  const pool = await createPool(ctx, ctx.tokenA, ctx.tokenB, FEE.MEDIUM, Q96);

  return { ...ctx, pool };
}

/** A position owned by the deployer, plus enough depth to trade against. */
async function withPosition() {
  const ctx = await pooled();
  const tokenId = await mintPosition(ctx, {
    token0: ctx.tokenA,
    token1: ctx.tokenB,
    fee: FEE.MEDIUM,
    ...RANGE,
    amount0: AMOUNT,
    amount1: AMOUNT,
  });

  return { ...ctx, tokenId };
}

async function tradeThrough(ctx: Awaited<ReturnType<typeof withPosition>>) {
  await ctx.callee
    .connect(ctx.alice)
    .swapExact0For1(
      await ctx.pool.getAddress(),
      ethers.parseEther("10"),
      ctx.alice.address,
      MIN_SQRT_RATIO + 1n,
    );
}

describe("V3 position manager", () => {
  describe("mint", () => {
    it("creates and initializes a pool that does not exist yet", async () => {
      const ctx = await loadFixture(deployV3);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      expect(await ctx.factory.getPool(a, b, FEE.MEDIUM)).to.equal(ethers.ZeroAddress);

      await ctx.positionManager.createAndInitializePoolIfNecessary(a, b, FEE.MEDIUM, Q96);

      const pool = await ethers.getContractAt(
        "UniswapV3Pool",
        await ctx.factory.getPool(a, b, FEE.MEDIUM),
      );
      expect((await pool.slot0()).sqrtPriceX96).to.equal(Q96);
    });

    it("leaves an existing pool's price alone", async () => {
      const ctx = await loadFixture(deployV3);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      await ctx.positionManager.createAndInitializePoolIfNecessary(a, b, FEE.MEDIUM, Q96);
      // Second call at a different price must be a no-op, not a reprice.
      await ctx.positionManager.createAndInitializePoolIfNecessary(a, b, FEE.MEDIUM, Q96 * 2n);

      const pool = await ethers.getContractAt(
        "UniswapV3Pool",
        await ctx.factory.getPool(a, b, FEE.MEDIUM),
      );
      expect((await pool.slot0()).sqrtPriceX96).to.equal(Q96);
    });

    it("issues an NFT and records the position behind it", async () => {
      const ctx = await loadFixture(withPosition);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      expect(ctx.tokenId).to.equal(1n);
      expect(await ctx.positionManager.ownerOf(ctx.tokenId)).to.equal(ctx.deployer.address);
      expect(await ctx.positionManager.balanceOf(ctx.deployer.address)).to.equal(1n);

      const position = await ctx.positionManager.positions(ctx.tokenId);
      expect(position.token0).to.equal(a);
      expect(position.token1).to.equal(b);
      expect(position.fee).to.equal(BigInt(FEE.MEDIUM));
      expect(position.tickLower).to.equal(BigInt(RANGE.tickLower));
      expect(position.tickUpper).to.equal(BigInt(RANGE.tickUpper));
      expect(position.liquidity).to.be.greaterThan(0n);
      expect(position.tokensOwed0).to.equal(0n);
    });

    it("numbers tokens from 1 upwards", async () => {
      const ctx = await loadFixture(withPosition);

      const second = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        tickLower: -SPACING * 10,
        tickUpper: SPACING * 10,
        amount0: AMOUNT,
        amount1: AMOUNT,
        signer: ctx.alice,
      });

      expect(second).to.equal(2n);
      expect(await ctx.positionManager.ownerOf(second)).to.equal(ctx.alice.address);
    });

    it("mints to a recipient other than the payer", async () => {
      const ctx = await loadFixture(pooled);

      const tokenId = await mintPosition(ctx, {
        token0: ctx.tokenA,
        token1: ctx.tokenB,
        fee: FEE.MEDIUM,
        ...RANGE,
        amount0: AMOUNT,
        amount1: AMOUNT,
        recipient: ctx.bob.address,
      });

      expect(await ctx.positionManager.ownerOf(tokenId)).to.equal(ctx.bob.address);
    });

    it("refuses a mint whose slippage bounds cannot be met", async () => {
      const ctx = await loadFixture(pooled);
      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);

      await expect(
        ctx.positionManager.mint({
          token0: a,
          token1: b,
          fee: FEE.MEDIUM,
          ...RANGE,
          amount0Desired: AMOUNT,
          amount1Desired: AMOUNT,
          amount0Min: AMOUNT + 1n,
          amount1Min: 0n,
          recipient: ctx.deployer.address,
          deadline: await deadline(),
        }),
      ).to.be.revertedWith("Price slippage check");
    });
  });

  describe("increaseLiquidity", () => {
    it("adds to an existing position without minting a new token", async () => {
      const ctx = await loadFixture(withPosition);
      const before = (await ctx.positionManager.positions(ctx.tokenId)).liquidity;

      await ctx.positionManager.increaseLiquidity({
        tokenId: ctx.tokenId,
        amount0Desired: AMOUNT,
        amount1Desired: AMOUNT,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });

      expect((await ctx.positionManager.positions(ctx.tokenId)).liquidity).to.be.greaterThan(before);
      expect(await ctx.positionManager.balanceOf(ctx.deployer.address)).to.equal(1n);
    });

    it("lets anyone add to someone else's position", async () => {
      // Adding liquidity is a gift to the token holder, so it is deliberately open.
      const ctx = await loadFixture(withPosition);
      const before = (await ctx.positionManager.positions(ctx.tokenId)).liquidity;

      await ctx.positionManager.connect(ctx.alice).increaseLiquidity({
        tokenId: ctx.tokenId,
        amount0Desired: AMOUNT,
        amount1Desired: AMOUNT,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });

      expect((await ctx.positionManager.positions(ctx.tokenId)).liquidity).to.be.greaterThan(before);
      expect(await ctx.positionManager.ownerOf(ctx.tokenId)).to.equal(ctx.deployer.address);
    });
  });

  describe("decreaseLiquidity and collect", () => {
    it("credits the position but pays nothing until collect", async () => {
      const ctx = await loadFixture(withPosition);
      const position = await ctx.positionManager.positions(ctx.tokenId);
      const before = await ctx.tokenA.balanceOf(ctx.deployer.address);

      await ctx.positionManager.decreaseLiquidity({
        tokenId: ctx.tokenId,
        liquidity: position.liquidity / 2n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });

      // Owed, not paid.
      expect(await ctx.tokenA.balanceOf(ctx.deployer.address)).to.equal(before);
      expect((await ctx.positionManager.positions(ctx.tokenId)).tokensOwed0).to.be.greaterThan(0n);

      await ctx.positionManager.collect({
        tokenId: ctx.tokenId,
        recipient: ctx.deployer.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });

      expect(await ctx.tokenA.balanceOf(ctx.deployer.address)).to.be.greaterThan(before);
      expect((await ctx.positionManager.positions(ctx.tokenId)).tokensOwed0).to.equal(0n);
    });

    it("collects trading fees without touching the liquidity", async () => {
      const ctx = await loadFixture(withPosition);
      await tradeThrough(ctx);

      const before = (await ctx.positionManager.positions(ctx.tokenId)).liquidity;
      const owed = await ctx.positionManager.collect.staticCall({
        tokenId: ctx.tokenId,
        recipient: ctx.deployer.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });

      expect(owed[0]).to.be.greaterThan(0n);

      await ctx.positionManager.collect({
        tokenId: ctx.tokenId,
        recipient: ctx.deployer.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });

      expect((await ctx.positionManager.positions(ctx.tokenId)).liquidity).to.equal(before);
    });

    it("lets only the owner or an approved operator withdraw", async () => {
      const ctx = await loadFixture(withPosition);
      const position = await ctx.positionManager.positions(ctx.tokenId);

      await expect(
        ctx.positionManager.connect(ctx.alice).decreaseLiquidity({
          tokenId: ctx.tokenId,
          liquidity: position.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: await deadline(),
        }),
      ).to.be.revertedWith("Not approved");

      await ctx.positionManager.approve(ctx.alice.address, ctx.tokenId);
      await ctx.positionManager.connect(ctx.alice).decreaseLiquidity({
        tokenId: ctx.tokenId,
        liquidity: position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });
    });

    it("refuses a withdrawal below its slippage bound", async () => {
      const ctx = await loadFixture(withPosition);
      const position = await ctx.positionManager.positions(ctx.tokenId);

      await expect(
        ctx.positionManager.decreaseLiquidity({
          tokenId: ctx.tokenId,
          liquidity: position.liquidity,
          amount0Min: ethers.MaxUint256 / 2n,
          amount1Min: 0n,
          deadline: await deadline(),
        }),
      ).to.be.revertedWith("Price slippage check");
    });
  });

  describe("transfer", () => {
    it("moves the liquidity and the uncollected fees with the token", async () => {
      const ctx = await loadFixture(withPosition);
      await tradeThrough(ctx);

      const owedBefore = await ctx.positionManager.collect.staticCall({
        tokenId: ctx.tokenId,
        recipient: ctx.deployer.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });
      expect(owedBefore[0]).to.be.greaterThan(0n);

      await ctx.positionManager.transferFrom(ctx.deployer.address, ctx.bob.address, ctx.tokenId);
      expect(await ctx.positionManager.ownerOf(ctx.tokenId)).to.equal(ctx.bob.address);

      // The old owner cannot collect any more...
      await expect(
        ctx.positionManager.collect({
          tokenId: ctx.tokenId,
          recipient: ctx.deployer.address,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        }),
      ).to.be.revertedWith("Not approved");

      // ...and the new one gets the fees that accrued before the transfer.
      const before = await ctx.tokenA.balanceOf(ctx.bob.address);
      await ctx.positionManager.connect(ctx.bob).collect({
        tokenId: ctx.tokenId,
        recipient: ctx.bob.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });

      expect((await ctx.tokenA.balanceOf(ctx.bob.address)) - before).to.equal(owedBefore[0]);
    });

    it("signs an approval with permit instead of sending a transaction", async () => {
      const ctx = await loadFixture(withPosition);
      const verifyingContract = await ctx.positionManager.getAddress();
      const { chainId } = await ethers.provider.getNetwork();
      const expiry = await deadline();

      const signature = await ctx.deployer.signTypedData(
        { name: "Uniswap V3 Positions NFT-V1", version: "1", chainId, verifyingContract },
        {
          Permit: [
            { name: "spender", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { spender: ctx.bob.address, tokenId: ctx.tokenId, nonce: 0n, deadline: expiry },
      );
      const { v, r, s } = ethers.Signature.from(signature);

      await ctx.positionManager.connect(ctx.bob).permit(ctx.bob.address, ctx.tokenId, expiry, v, r, s);

      expect(await ctx.positionManager.getApproved(ctx.tokenId)).to.equal(ctx.bob.address);
    });

    it("rejects a permit signed by someone who does not own the token", async () => {
      const ctx = await loadFixture(withPosition);
      const verifyingContract = await ctx.positionManager.getAddress();
      const { chainId } = await ethers.provider.getNetwork();
      const expiry = await deadline();

      const signature = await ctx.alice.signTypedData(
        { name: "Uniswap V3 Positions NFT-V1", version: "1", chainId, verifyingContract },
        {
          Permit: [
            { name: "spender", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { spender: ctx.alice.address, tokenId: ctx.tokenId, nonce: 0n, deadline: expiry },
      );
      const { v, r, s } = ethers.Signature.from(signature);

      await expect(
        ctx.positionManager.connect(ctx.alice).permit(ctx.alice.address, ctx.tokenId, expiry, v, r, s),
      ).to.be.revertedWith("Unauthorized");
    });
  });

  describe("burn", () => {
    it("refuses while the position still holds liquidity or owes tokens", async () => {
      const ctx = await loadFixture(withPosition);

      await expect(ctx.positionManager.burn(ctx.tokenId)).to.be.revertedWith("Not cleared");

      const position = await ctx.positionManager.positions(ctx.tokenId);
      await ctx.positionManager.decreaseLiquidity({
        tokenId: ctx.tokenId,
        liquidity: position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });

      // Liquidity is zero now, but the tokens are still owed.
      await expect(ctx.positionManager.burn(ctx.tokenId)).to.be.revertedWith("Not cleared");
    });

    it("burns once the position is fully emptied and collected", async () => {
      const ctx = await loadFixture(withPosition);
      const position = await ctx.positionManager.positions(ctx.tokenId);

      await ctx.positionManager.decreaseLiquidity({
        tokenId: ctx.tokenId,
        liquidity: position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await deadline(),
      });
      await ctx.positionManager.collect({
        tokenId: ctx.tokenId,
        recipient: ctx.deployer.address,
        amount0Max: MAX_U128,
        amount1Max: MAX_U128,
      });
      await ctx.positionManager.burn(ctx.tokenId);

      expect(await ctx.positionManager.balanceOf(ctx.deployer.address)).to.equal(0n);
      await expect(ctx.positionManager.ownerOf(ctx.tokenId)).to.be.revert(ethers);
    });
  });

  describe("tokenURI", () => {
    it("renders on-chain JSON naming the native coin NURA", async () => {
      // The descriptor is deployed with bytes32("NURA"), so the art has to say NURA and
      // not ETH. This is the one place the Nurachain-specific configuration shows up.
      const ctx = await loadFixture(deployV3);

      await createPool(ctx, ctx.wnura, ctx.tokenA, FEE.MEDIUM, Q96);
      await ctx.wnura.deposit({ value: ethers.parseEther("100") });
      await ctx.wnura.approve(await ctx.positionManager.getAddress(), ethers.MaxUint256);

      const tokenId = await mintPosition(ctx, {
        token0: ctx.wnura,
        token1: ctx.tokenA,
        fee: FEE.MEDIUM,
        ...RANGE,
        amount0: ethers.parseEther("10"),
        amount1: ethers.parseEther("10"),
      });

      const uri = await ctx.positionManager.tokenURI(tokenId);
      expect(uri).to.match(/^data:application\/json;base64,/);

      const json = JSON.parse(
        Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8"),
      );

      expect(json.name).to.be.a("string");
      expect(json.image).to.match(/^data:image\/svg\+xml;base64,/);
      expect(`${json.name} ${json.description}`).to.include("NURA");
    });

    it("says NURA rather than WNURA for the wrapped side", async () => {
      const ctx = await loadFixture(deployV3);
      const descriptor = ctx.descriptor;

      expect(await descriptor.nativeCurrencyLabel()).to.equal("NURA");
      expect(await descriptor.WETH9()).to.equal(await ctx.wnura.getAddress());
    });

    it("orders a Nurachain stablecoin pair as price-per-USDT", async () => {
      // tokenRatioPriority is the local modification in contracts/univ3/VENDORED.md: without
      // the chainId 1020 branch every token here scores 0 and the ratio is whichever way
      // the addresses happen to sort.
      const ctx = await loadFixture(deployV3);
      const NURA_USDT = "0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC";
      const NURA_BNB = "0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc";

      expect(await ctx.descriptor.tokenRatioPriority(NURA_USDT, 1020)).to.be.greaterThan(0n);
      expect(await ctx.descriptor.tokenRatioPriority(NURA_BNB, 1020)).to.be.lessThan(0n);
      // Unknown tokens stay neutral, and the branch is chain-scoped.
      expect(await ctx.descriptor.tokenRatioPriority(await ctx.tokenA.getAddress(), 1020)).to.equal(0n);
      expect(await ctx.descriptor.tokenRatioPriority(NURA_USDT, 1)).to.equal(0n);
    });
  });
});
