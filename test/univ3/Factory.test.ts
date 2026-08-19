import { expect } from "chai";
import { network } from "hardhat";

import { CONSTRUCTOR_FEES, FEE, TICK_SPACING, deployV3 } from "./helpers.ts";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * UniswapV3Factory: the fee-tier registry and the CREATE2 pool deployer.
 *
 * The fee tiers matter more here than they look. `enableFeeAmount` is one-way — a tier
 * can never be removed, and its tick spacing can never be changed — so the set enabled at
 * deploy time is the set this chain lives with. ignition/modules/univ3.ts enables 100/1 on
 * top of the three the constructor sets up, which is the canonical Uniswap ladder.
 */
describe("V3 factory", () => {
  describe("fee tiers", () => {
    it("enables 0.05%, 0.30% and 1.00% in its constructor, with Uniswap's tick spacings", async () => {
      const { factory } = await loadFixture(deployV3);

      for (const fee of CONSTRUCTOR_FEES) {
        expect(await factory.feeAmountTickSpacing(fee), `fee ${fee}`).to.equal(TICK_SPACING[fee]);
      }
    });

    it("does not enable 0.01% until someone asks", async () => {
      // Deployed fresh rather than through the fixture, which enables it the way the
      // Ignition module does — the point is that the constructor alone does not.
      const factory = await ethers.deployContract("UniswapV3Factory");

      expect(await factory.feeAmountTickSpacing(FEE.LOWEST)).to.equal(0n);
    });

    it("enables 0.01% at tick spacing 1 when the owner asks", async () => {
      const { factory } = await loadFixture(deployV3);

      expect(await factory.feeAmountTickSpacing(FEE.LOWEST)).to.equal(1n);
    });

    it("announces a newly enabled tier", async () => {
      const factory = await ethers.deployContract("UniswapV3Factory");

      await expect(factory.enableFeeAmount(FEE.LOWEST, 1))
        .to.emit(factory, "FeeAmountEnabled")
        .withArgs(FEE.LOWEST, 1);
    });

    it("lets only the owner enable a tier", async () => {
      const { factory, alice } = await loadFixture(deployV3);

      await expect(factory.connect(alice).enableFeeAmount(1234, 5)).to.be.revert(ethers);
    });

    it("refuses to change a tier that is already enabled", async () => {
      // This is the property that makes the launch set permanent.
      const { factory } = await loadFixture(deployV3);

      await expect(factory.enableFeeAmount(FEE.MEDIUM, 60)).to.be.revert(ethers);
      await expect(factory.enableFeeAmount(FEE.MEDIUM, 10)).to.be.revert(ethers);
    });

    it("refuses a fee at or above 100% and a tick spacing outside 1..16383", async () => {
      const { factory } = await loadFixture(deployV3);

      await expect(factory.enableFeeAmount(1_000_000, 60)).to.be.revert(ethers);
      await expect(factory.enableFeeAmount(4242, 0)).to.be.revert(ethers);
      await expect(factory.enableFeeAmount(4242, 16384)).to.be.revert(ethers);
    });
  });

  describe("createPool", () => {
    it("creates one pool per (pair, fee) and records it both ways round", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await factory.createPool(a, b, FEE.MEDIUM);
      const pool = await factory.getPool(a, b, FEE.MEDIUM);

      expect(pool).to.not.equal(ethers.ZeroAddress);
      // getPool is populated for both orderings, so callers never have to sort first.
      expect(await factory.getPool(b, a, FEE.MEDIUM)).to.equal(pool);
    });

    it("sorts the tokens, whichever order it is given them in", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      // helpers.ts returns tokenA/tokenB/tokenC sorted by address, so a < b here.
      await factory.createPool(b, a, FEE.MEDIUM);
      const pool = await ethers.getContractAt("UniswapV3Pool", await factory.getPool(a, b, FEE.MEDIUM));

      expect(await pool.token0()).to.equal(a);
      expect(await pool.token1()).to.equal(b);
    });

    it("carries the fee and tick spacing onto the pool", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      for (const fee of [FEE.LOWEST, FEE.LOW, FEE.MEDIUM, FEE.HIGH]) {
        await factory.createPool(a, b, fee);
        const pool = await ethers.getContractAt("UniswapV3Pool", await factory.getPool(a, b, fee));

        expect(await pool.fee(), `fee ${fee}`).to.equal(fee);
        expect(await pool.tickSpacing(), `spacing for ${fee}`).to.equal(TICK_SPACING[fee]);
        expect(await pool.factory()).to.equal(await factory.getAddress());
      }
    });

    it("gives the same pair a different pool per fee tier", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await factory.createPool(a, b, FEE.LOW);
      await factory.createPool(a, b, FEE.MEDIUM);

      expect(await factory.getPool(a, b, FEE.LOW)).to.not.equal(
        await factory.getPool(a, b, FEE.MEDIUM),
      );
    });

    it("announces the pool", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await expect(factory.createPool(a, b, FEE.MEDIUM)).to.emit(factory, "PoolCreated");
    });

    it("refuses a duplicate", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await factory.createPool(a, b, FEE.MEDIUM);

      await expect(factory.createPool(a, b, FEE.MEDIUM)).to.be.revert(ethers);
      await expect(factory.createPool(b, a, FEE.MEDIUM)).to.be.revert(ethers);
    });

    it("refuses a token paired with itself, the zero address, or an unenabled fee", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await expect(factory.createPool(a, a, FEE.MEDIUM)).to.be.revert(ethers);
      await expect(factory.createPool(a, ethers.ZeroAddress, FEE.MEDIUM)).to.be.revert(ethers);
      await expect(factory.createPool(a, b, 4242)).to.be.revert(ethers);
    });

    it("leaves a new pool uninitialized until someone sets a price", async () => {
      const { factory, tokenA, tokenB } = await loadFixture(deployV3);
      const [a, b] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);

      await factory.createPool(a, b, FEE.MEDIUM);
      const pool = await ethers.getContractAt("UniswapV3Pool", await factory.getPool(a, b, FEE.MEDIUM));

      expect((await pool.slot0()).sqrtPriceX96).to.equal(0n);
      expect(await pool.liquidity()).to.equal(0n);
    });
  });

  describe("ownership", () => {
    it("starts with the deployer holding the key", async () => {
      const { factory, deployer } = await loadFixture(deployV3);

      expect(await factory.owner()).to.equal(deployer.address);
    });

    it("hands over on setOwner and announces it", async () => {
      const { factory, deployer, alice } = await loadFixture(deployV3);

      await expect(factory.setOwner(alice.address))
        .to.emit(factory, "OwnerChanged")
        .withArgs(deployer.address, alice.address);

      expect(await factory.owner()).to.equal(alice.address);
      // And the old owner is out — this is the step that makes a multisig handover real.
      await expect(factory.enableFeeAmount(4242, 60)).to.be.revert(ethers);
    });

    it("blocks anyone who is not the owner", async () => {
      const { factory, alice } = await loadFixture(deployV3);

      await expect(factory.connect(alice).setOwner(alice.address)).to.be.revert(ethers);
    });
  });
});
