import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();

/**
 * The Forecast factory's N-of-M resolution multisig.
 *
 * Resolution is the one action that decides who gets paid, so it is gated behind a
 * signer set appointed by an owner: `requiredConfirmations` distinct signers must vote
 * for the SAME outcome before the clone's resolve() runs and coins become distributable
 * to winners. These tests exercise that flow end to end on both engines.
 */

type Params = {
  title: string;
  description: string;
  category: string;
  imageURI: string;
  creator: string;
  lockTime: bigint;
  resolveTime: bigint;
  feeBps: number;
  protocolFeeShareBps: number;
  outcomeNames: string[];
};

/** Deploys treasury + both implementations + a factory with a 5-signer / 3-quorum setup. */
async function deployForecast() {
  const [deployer, s1, s2, s3, s4, s5, alice, bob] = await ethers.getSigners();
  const signers = [s1, s2, s3, s4, s5];

  const treasury = await ethers.deployContract("PredictionTreasury", [deployer.address, deployer.address], deployer);
  const marketImpl = await ethers.deployContract("PredictionMarket", [], deployer);
  const poolImpl = await ethers.deployContract("PredictionPool", [], deployer);
  const factory = await ethers.deployContract(
    "PredictionFactory",
    [
      deployer.address,
      await treasury.getAddress(),
      await marketImpl.getAddress(),
      await poolImpl.getAddress(),
      300n,
      2000n,
      deployer.address,
      signers.map((s) => s.address),
      3n,
    ],
    deployer,
  );

  return { factory, treasury, deployer, signers, alice, bob };
}

async function marketParams(creator: string): Promise<Params> {
  return {
    title: "Will it rain?",
    description: "Rain in Tehran",
    category: "weather",
    imageURI: "",
    creator,
    lockTime: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600),
    resolveTime: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 7200),
    feeBps: 0, // inherit the factory default
    protocolFeeShareBps: 2000,
    outcomeNames: ["Yes", "No"],
  };
}

/** Creates a parimutuel pool market and advances time past its lockTime. */
async function createPool(factory: any, params: Params) {
  const tx = await factory.createMarket2(params);
  const receipt = await tx.wait();

  const ev = receipt.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "MarketCreated");
  return ev!.args.market;
}

/** Moves block time past a market's lockTime so resolution becomes legal. */
async function passLock(params: Params) {
  await networkHelpers.time.increaseTo(params.lockTime + 2n);
}

describe("Forecast resolution multisig", () => {
  describe("deployment", () => {
    it("stores the signer set, quorum and owner", async () => {
      const { factory, signers, deployer } = await deployForecast();

      expect(await factory.resolutionSigners()).to.deep.equal(signers.map((s) => s.address));
      expect(await factory.requiredConfirmations()).to.equal(3n);
      expect(await factory.owner()).to.equal(deployer.address);
      for (const s of signers) {
        expect(await factory.isResolutionSigner(s.address)).to.equal(true);
      }
      // No votes cast yet: sentinel value.
      expect(await factory.confirmationOf(0n, signers[0].address)).to.equal(2n ** 256n - 1n);
    });

    it("rejects duplicate, zero or over-length signer sets", async () => {
      const [deployer, s1, s2] = await ethers.getSigners();
      const treasury = await ethers.deployContract("PredictionTreasury", [deployer.address, deployer.address], deployer);
      const m = await ethers.deployContract("PredictionMarket", [], deployer);
      const p = await ethers.deployContract("PredictionPool", [], deployer);
      const base = [
        deployer.address,
        await treasury.getAddress(),
        await m.getAddress(),
        await p.getAddress(),
        300n,
        2000n,
      ];

      const factory = await ethers.getContractFactory("PredictionFactory");
      const dup: any[] = [...base, deployer.address, [s1.address, s1.address], 1n];
      await expect((factory.deploy as any)(...dup)).to.be.revertedWithCustomError(factory, "DuplicateSigner");

      const zero: any[] = [...base, deployer.address, [s1.address, ethers.ZeroAddress], 2n];
      await expect((factory.deploy as any)(...zero)).to.be.revertedWithCustomError(factory, "ZeroAddress");

      const tooMany: any[] = [...base, deployer.address, Array.from({ length: 11 }, () => s2.address), 1n];
      await expect((factory.deploy as any)(...tooMany)).to.be.revertedWithCustomError(factory, "BadQuorum");

      const badQuorum: any[] = [...base, deployer.address, [s1.address], 2n];
      await expect((factory.deploy as any)(...badQuorum)).to.be.revertedWithCustomError(factory, "BadQuorum");
    });
  });

  describe("confirmResolution", () => {
    it("resolves a pool market at quorum and lets winners claim pro-rata net of fee", async () => {
      const { factory, treasury, signers, alice, bob } = await deployForecast();
      const [deployer] = await ethers.getSigners();

      const params = await marketParams(deployer.address);
      const pool = await createPool(factory, params);
      const poolC = await ethers.getContractAt("PredictionPool", pool);

      // Alice backs outcome 0 with 90, Bob outcome 1 with 10. Pool = 100.
      await poolC.connect(alice).bet(0n, { value: 90n * 10n ** 18n });
      await poolC.connect(bob).bet(1n, { value: 10n * 10n ** 18n });

      await passLock(params);
      expect(await poolC.status()).to.equal(0n); // Open

      // Two of three needed confirmations: nothing happens yet.
      await factory.connect(signers[0]).confirmResolution(0n, 0n);
      await factory.connect(signers[1]).confirmResolution(0n, 0n);
      expect(await poolC.status()).to.equal(0n);
      expect(await factory.confirmationCount(0n, 0n)).to.equal(2n);

      // Third confirmation crosses the threshold and resolves on-chain.
      await expect(factory.connect(signers[2]).confirmResolution(0n, 0n))
        .to.emit(poolC, "MarketResolved")
        .and.to.emit(factory, "ResolutionExecuted")
        .withArgs(0n, 0n, 3n);

      expect(await poolC.status()).to.equal(3n); // Resolved
      expect(await poolC.winningOutcome()).to.equal(0n);

      // House fee (default 300 bps) went to the treasury once.
      const totalPool = 100n * 10n ** 18n;
      const fee = (totalPool * 300n) / 10_000n;
      expect(await treasury.collectedFor(pool)).to.equal(fee);

      // Alice holds all of the winning side: pool minus fee exactly (gas added back).
      const balanceBefore = await ethers.provider.getBalance(alice.address);
      const claimTx = await poolC.connect(alice).claim();
      const receipt = await claimTx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const paid = (await ethers.provider.getBalance(alice.address)) - balanceBefore + gas;
      expect(paid).to.equal(totalPool - fee);

      // A losing bettor has nothing to claim.
      await expect(poolC.connect(bob).claim()).to.be.revertedWithCustomError(poolC, "NothingToClaim");
    });

    it("ignores votes for other outcomes until ONE outcome reaches the quorum", async () => {
      const { factory, signers } = await deployForecast();
      const [deployer] = await ethers.getSigners();
      const params = await marketParams(deployer.address);
      const pool = await createPool(factory, params);
      await passLock(params);

      await factory.connect(signers[0]).confirmResolution(0n, 0n);
      await factory.connect(signers[1]).confirmResolution(0n, 1n);
      await factory.connect(signers[2]).confirmResolution(0n, 1n);
      await factory.connect(signers[3]).confirmResolution(0n, 1n);

      const poolC = await ethers.getContractAt("PredictionPool", pool);
      expect(await poolC.status()).to.equal(3n); // Resolved to outcome 1
      expect(await poolC.winningOutcome()).to.equal(1n);
    });

    it("lets a signer move their vote before quorum", async () => {
      const { factory, signers } = await deployForecast();
      const [deployer] = await ethers.getSigners();
      const params = await marketParams(deployer.address);
      const pool = await createPool(factory, params);

      await factory.connect(signers[0]).confirmResolution(0n, 0n);
      await factory.connect(signers[0]).confirmResolution(0n, 1n);

      expect(await factory.confirmationCount(0n, 0n)).to.equal(0n);
      expect(await factory.confirmationCount(0n, 1n)).to.equal(1n);
      expect(await factory.confirmationOf(0n, signers[0].address)).to.equal(1n);

      const poolC = await ethers.getContractAt("PredictionPool", pool);
      expect(await poolC.status()).to.equal(0n); // still open
    });

    it("rejects non-signers, dead markets and unknown outcomes", async () => {
      const { factory, signers, alice } = await deployForecast();
      const [deployer] = await ethers.getSigners();
      const params = await marketParams(deployer.address);
      await createPool(factory, params);
      await passLock(params);

      await expect(
        factory.connect(alice).confirmResolution(0n, 0n),
      ).to.be.revertedWithCustomError(factory, "NotSigner");

      await expect(
        factory.connect(signers[0]).confirmResolution(0n, 5n),
      ).to.be.revertedWithCustomError(factory, "InvalidOutcome");

      // Resolve, then confirm again must fail on the terminal state.
      await factory.connect(signers[0]).confirmResolution(0n, 0n);
      await factory.connect(signers[1]).confirmResolution(0n, 0n);
      await factory.connect(signers[2]).confirmResolution(0n, 0n);
      await expect(
        factory.connect(signers[3]).confirmResolution(0n, 0n),
      ).to.be.revertedWithCustomError(factory, "MarketAlreadyEnded");
    });

    it("also drives the CPMM engine", async () => {
      const { factory, signers } = await deployForecast();
      const [deployer] = await ethers.getSigners();

      const params = await marketParams(deployer.address);
      const tx = await factory.createMarket(params, { value: 10n ** 18n });
      const receipt = await tx.wait();
      const ev = receipt!.logs
        .map((l: any) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "MarketCreated")!;

      const market = await ethers.getContractAt("PredictionMarket", ev.args.market);
      await factory.connect(signers[0]).confirmResolution(ev.args.marketId, 1n);
      await factory.connect(signers[1]).confirmResolution(ev.args.marketId, 1n);
      await factory.connect(signers[2]).confirmResolution(ev.args.marketId, 1n);

      expect(await market.status()).to.equal(3n);
      expect(await market.winningOutcome()).to.equal(1n);
    });
  });

  describe("setResolutionSigners", () => {
    it("is owner-only", async () => {
      const { factory, signers, alice } = await deployForecast();
      await expect(
        factory.connect(alice).setResolutionSigners([alice.address], 1n),
      ).to.be.revertedWithCustomError(factory, "NotOwner");
      await expect(
        factory.connect(signers[0]).setResolutionSigners([signers[0].address], 1n),
      ).to.be.revertedWithCustomError(factory, "NotOwner");
    });

    it("replaces the whole set atomically and enforces the new quorum", async () => {
      const { factory, signers, alice, bob } = await deployForecast();
      const [deployer] = await ethers.getSigners();
      const params = await marketParams(deployer.address);
      const pool = await createPool(factory, params);
      await passLock(params);

      await factory.setResolutionSigners([alice.address, bob.address], 2n);
      expect(await factory.resolutionSigners()).to.deep.equal([alice.address, bob.address]);
      expect(await factory.isResolutionSigner(signers[0].address)).to.equal(false);

      // Old signer can no longer vote; new ones can, at the new 2-of-2 quorum.
      await expect(
        factory.connect(signers[0]).confirmResolution(0n, 0n),
      ).to.be.revertedWithCustomError(factory, "NotSigner");
      await factory.connect(alice).confirmResolution(0n, 0n);
      await factory.connect(bob).confirmResolution(0n, 0n);

      const poolC = await ethers.getContractAt("PredictionPool", pool);
      expect(await poolC.status()).to.equal(3n);
    });

    it("validates uniqueness, zero addresses and quorum bounds", async () => {
      const { factory, alice } = await deployForecast();

      await expect(
        factory.setResolutionSigners([alice.address, alice.address], 1n),
      ).to.be.revertedWithCustomError(factory, "DuplicateSigner");
      await expect(
        factory.setResolutionSigners([ethers.ZeroAddress], 1n),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(
        factory.setResolutionSigners([alice.address], 2n),
      ).to.be.revertedWithCustomError(factory, "BadQuorum");
      await expect(factory.setResolutionSigners([], 1n)).to.be.revertedWithCustomError(
        factory,
        "BadQuorum",
      );
    });
  });
});
