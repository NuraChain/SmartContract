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
  categoryId: number;
  imageURI: string;
  creator: string;
  lockTime: bigint;
  resolveTime: bigint;
  feeBps: number;
  protocolFeeShareBps: number;
  outcomeNames: string[];
};

/** A short language tag as the registry stores it: left-aligned in bytes8. */
function lang(tag: string) {
  return ethers.zeroPadBytes(ethers.toUtf8Bytes(tag), 8).slice(0, 18) + "";
}

/** The weather category used by most tests, named in English and Persian. */
const WEATHER = 7;

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

  await factory.addCategory(WEATHER, [lang("en"), lang("fa")], ["Weather", "آب و هوا"]);

  return { factory, treasury, deployer, signers, alice, bob };
}

async function marketParams(creator: string): Promise<Params> {
  return {
    title: "Will it rain?",
    description: "Rain in Tehran",
    categoryId: WEATHER,
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

/** Creates a CPMM market seeded with `value` and returns its id and contract. */
async function createAmm(factory: any, params: Params, value = 10n ** 18n) {
  const receipt = await (await factory.createMarket(params, { value })).wait();
  const ev = receipt.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "MarketCreated")!;
  return {
    marketId: ev.args.marketId as bigint,
    market: await ethers.getContractAt("PredictionMarket", ev.args.market),
  };
}

/** Opts a market into the push-at-settlement that markets start with switched off. */
async function pushOnSettle(factory: any, marketId: bigint | number = 0n) {
  await factory.setMarketAutoDistribute(marketId, true);
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
    it("resolves a pool market at quorum and pays winners pro-rata net of fee", async () => {
      const { factory, treasury, signers, alice, bob } = await deployForecast();
      const [deployer] = await ethers.getSigners();

      const params = await marketParams(deployer.address);
      const pool = await createPool(factory, params);
      const poolC = await ethers.getContractAt("PredictionPool", pool);
      await pushOnSettle(factory);

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

      // Third confirmation crosses the threshold and resolves on-chain. Alice holds all of
      // the winning side and is paid inside that very transaction — she never calls claim.
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await expect(factory.connect(signers[2]).confirmResolution(0n, 0n))
        .to.emit(poolC, "MarketResolved")
        .and.to.emit(factory, "ResolutionExecuted")
        .withArgs(0n, 0n, 3n);
      const aliceAfter = await ethers.provider.getBalance(alice.address);

      expect(await poolC.status()).to.equal(3n); // Resolved
      expect(await poolC.winningOutcome()).to.equal(0n);

      // House fee (default 300 bps) went to the treasury once.
      const totalPool = 100n * 10n ** 18n;
      const fee = (totalPool * 300n) / 10_000n;
      expect(await treasury.collectedFor(pool)).to.equal(fee);
      expect(aliceAfter - aliceBefore).to.equal(totalPool - fee);

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

/**
 * Automatic payout.
 *
 * Settling a market pays its participants without anyone having to come and claim: resolve
 * and voidMarket push the first batch of payouts in the very transaction that settles the
 * market, and anyone can carry the rest. Claiming survives only as the fallback for whoever
 * the push could not reach.
 */
describe("Forecast automatic payout", () => {
  /** Resolves a market through the 3-of-5 signer quorum. */
  async function resolveVia(factory: any, signers: any[], marketId: bigint, outcome: bigint) {
    for (let i = 0; i < 3; i++) {
      await factory.connect(signers[i]).confirmResolution(marketId, outcome);
    }
  }

  /** Creates `count` funded throwaway wallets. */
  async function fundedWallets(funder: any, count: number) {
    const wallets = [];
    for (let i = 0; i < count; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await funder.sendTransaction({ to: w.address, value: 10n ** 18n });
      wallets.push(w);
    }
    return wallets;
  }

  it("pays pool winners at resolution without anyone claiming", async () => {
    const { factory, signers, alice, bob } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    await pushOnSettle(factory);
    await poolC.connect(alice).bet(0n, { value: 60n * 10n ** 18n });
    await poolC.connect(bob).bet(0n, { value: 40n * 10n ** 18n });
    await passLock(params);

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await resolveVia(factory, signers, 0n, 0n);

    // 100 staked, 3% house fee, 97 shared 60/40 — delivered, not offered.
    const distributable = 97n * 10n ** 18n;
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal((distributable * 60n) / 100n);
    expect((await ethers.provider.getBalance(bob.address)) - bobBefore).to.equal((distributable * 40n) / 100n);

    // The pool is empty and there is nothing left to claim.
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
    const [cursor, total] = await poolC.distributionProgress();
    expect([cursor, total]).to.deep.equal([2n, 2n]);
    await expect(poolC.connect(alice).claim()).to.be.revertedWithCustomError(poolC, "NothingToClaim");
  });

  it("refunds every bettor automatically when a pool is voided", async () => {
    const { factory, alice, bob } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    await pushOnSettle(factory);
    await poolC.connect(alice).bet(0n, { value: 7n * 10n ** 18n });
    await poolC.connect(bob).bet(1n, { value: 3n * 10n ** 18n });

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await factory.voidMarket(0n);

    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(7n * 10n ** 18n);
    expect((await ethers.provider.getBalance(bob.address)) - bobBefore).to.equal(3n * 10n ** 18n);
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
  });

  it("pushes a first batch at settlement and lets anyone carry the rest", async () => {
    const { factory, signers } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    // Two more bettors than one settlement transaction pays for.
    await pushOnSettle(factory);
    const batch = await poolC.AUTO_DISTRIBUTE_BATCH();
    const bettors = await fundedWallets(deployer, Number(batch) + 2);
    for (const w of bettors) {
      await poolC.connect(w).bet(0n, { value: 10n ** 17n });
    }
    await passLock(params);
    await resolveVia(factory, signers, 0n, 0n);

    // The tail is untouched but already accounted for, and still in the contract.
    const [cursor, total] = await poolC.distributionProgress();
    expect([cursor, total]).to.deep.equal([batch, batch + 2n]);
    const tail = bettors[bettors.length - 1];
    const owed = await poolC.pendingPayout(tail.address);
    expect(owed).to.be.greaterThan(0n);
    expect(await ethers.provider.getBalance(pool)).to.equal(owed * 2n);

    // Anyone may finish it — here a bystander, through the factory.
    const tailBefore = await ethers.provider.getBalance(tail.address);
    await factory.connect(signers[4]).distributeMarket(0n, 10n);

    expect((await ethers.provider.getBalance(tail.address)) - tailBefore).to.equal(owed);
    expect((await poolC.distributionProgress())[0]).to.equal(batch + 2n);
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
  });

  it("credits a recipient it cannot pay instead of stalling the batch", async () => {
    const { factory, signers, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    // The rejector bets first, so the push hits it before it reaches Alice.
    await pushOnSettle(factory);
    const rejector = await ethers.deployContract("PayoutRejector", [pool], deployer);
    await rejector.betPool(0n, { value: 50n * 10n ** 18n });
    await poolC.connect(alice).bet(0n, { value: 50n * 10n ** 18n });
    await passLock(params);

    const rejectorAddr = await rejector.getAddress();
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await factory.connect(signers[0]).confirmResolution(0n, 0n);
    await factory.connect(signers[1]).confirmResolution(0n, 0n);
    await expect(factory.connect(signers[2]).confirmResolution(0n, 0n))
      .to.emit(poolC, "PayoutDeferred")
      .withArgs(pool, rejectorAddr, 485n * 10n ** 17n);

    // Alice, queued behind the failure, was still paid in the same transaction.
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(485n * 10n ** 17n);

    // The rejector's share is held for it, and it can pull once it will take the money.
    expect(await poolC.pendingPayout(rejectorAddr)).to.equal(485n * 10n ** 17n);
    await rejector.startAccepting();
    await rejector.claimPool();
    expect(await ethers.provider.getBalance(rejectorAddr)).to.equal(485n * 10n ** 17n);
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
  });

  it("pays CPMM share holders and liquidity providers at resolution", async () => {
    const { factory, signers, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const { marketId, market } = await createAmm(factory, params);
    await pushOnSettle(factory, marketId);

    await market.connect(alice).buy(1n, 0n, params.resolveTime, { value: 10n ** 18n });

    // The creator seeded the market, so they hold every LP share; Alice holds the shares
    // of the outcome about to win.
    const aliceShares = await market.balanceOf(alice.address, 1n);
    const lpPot = (await market.getReserves())[1];
    const held = await ethers.provider.getBalance(await market.getAddress());

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const lpBefore = await ethers.provider.getBalance(deployer.address);
    await resolveVia(factory, signers, marketId, 1n);

    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(aliceShares);
    expect((await ethers.provider.getBalance(deployer.address)) - lpBefore).to.equal(lpPot);

    // Winners' shares plus the LP pot is the whole pot: the market is left empty.
    expect(aliceShares + lpPot).to.equal(held);
    expect(await market.totalSets()).to.equal(0n);
    expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(0n);
    await expect(market.connect(alice).redeem()).to.be.revertedWithCustomError(market, "NothingToClaim");
  });

  it("refuses to unwind liquidity once a CPMM market has settled", async () => {
    const { factory, signers } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const { marketId, market } = await createAmm(factory, params);

    await resolveVia(factory, signers, marketId, 0n);

    // LP value is paid out in collateral by the distribution; converting LP shares into
    // outcome tokens afterwards would pay the same reserves twice.
    await expect(market.removeFunding(1n)).to.be.revertedWithCustomError(market, "MarketAlreadyEnded");
  });
});

/**
 * Unclaimed collateral after settlement.
 *
 * Automatic payout empties most markets on the spot, but not all of them: a recipient can
 * refuse delivery, and a market can resolve to an outcome nobody backed. Whatever is left
 * stays claimable for a full year; after that the payout functions shut for everyone at the
 * same instant and an admin can move the residue into the treasury, so a settled market
 * never turns into a permanently stranded pot of coins.
 */
describe("Forecast claim window", () => {
  const YEAR = 365n * 24n * 60n * 60n;

  /** Resolves a market through the 3-of-5 signer quorum. */
  async function resolveVia(factory: any, signers: any[], marketId: bigint, outcome: bigint) {
    for (let i = 0; i < 3; i++) {
      await factory.connect(signers[i]).confirmResolution(marketId, outcome);
    }
  }

  it("starts a one-year clock at settlement and reports the deadline", async () => {
    const { factory, signers } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    // Nothing to sweep while the market is still live.
    expect(await poolC.claimDeadline()).to.equal(0n);
    await expect(factory.sweepUnclaimed(0n)).to.be.revertedWithCustomError(poolC, "MarketNotResolved");

    await passLock(params);
    await resolveVia(factory, signers, 0n, 0n);

    const endedAt = await poolC.endedAt();
    expect(endedAt).to.not.equal(0n);
    expect(await poolC.claimDeadline()).to.equal(endedAt + YEAR);
  });

  it("holds an undeliverable payout for a year, then sweeps it to the treasury", async () => {
    const { factory, treasury, signers } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    await pushOnSettle(factory);
    const rejector = await ethers.deployContract("PayoutRejector", [pool], deployer);
    await rejector.betPool(0n, { value: 100n * 10n ** 18n });
    await passLock(params);
    await resolveVia(factory, signers, 0n, 0n);

    // Its whole share stayed behind, credited but undelivered.
    const credited = 97n * 10n ** 18n;
    expect(await ethers.provider.getBalance(pool)).to.equal(credited);
    await expect(factory.sweepUnclaimed(0n)).to.be.revertedWithCustomError(poolC, "ClaimWindowOpen");

    const deadline = await poolC.claimDeadline();
    await networkHelpers.time.increaseTo(deadline - 10n);
    await expect(factory.sweepUnclaimed(0n)).to.be.revertedWithCustomError(poolC, "ClaimWindowOpen");

    // At the deadline the window shuts for claimants and opens for the admin.
    await networkHelpers.time.increaseTo(deadline);
    await rejector.startAccepting();
    await expect(rejector.claimPool()).to.be.revertedWithCustomError(poolC, "ClaimWindowClosed");
    await expect(factory.distributeMarket(0n, 5n)).to.be.revertedWithCustomError(poolC, "ClaimWindowClosed");

    const feeFromResolution = 3n * 10n ** 18n;
    expect(await treasury.collectedFor(pool)).to.equal(feeFromResolution);

    await expect(factory.sweepUnclaimed(0n))
      .to.emit(poolC, "UnclaimedSwept")
      .withArgs(pool, await treasury.getAddress(), credited);

    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
    expect(await treasury.collectedFor(pool)).to.equal(feeFromResolution + credited);

    // Nothing left over: a second sweep has no work to do.
    await expect(factory.sweepUnclaimed(0n)).to.be.revertedWithCustomError(poolC, "ZeroAmount");
  });

  it("sweeps a pool resolved to an outcome nobody backed", async () => {
    const { factory, treasury, signers, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    await poolC.connect(alice).bet(0n, { value: 10n * 10n ** 18n });
    await passLock(params);
    await resolveVia(factory, signers, 0n, 1n); // nobody staked outcome 1

    // There is no one to pay, so the whole distributable pool waits out the window.
    const stranded = 97n * 10n ** 17n;
    expect(await poolC.pendingPayout(alice.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(pool)).to.equal(stranded);

    await networkHelpers.time.increaseTo(await poolC.claimDeadline());
    await expect(factory.sweepUnclaimed(0n))
      .to.emit(poolC, "UnclaimedSwept")
      .withArgs(pool, await treasury.getAddress(), stranded);
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
  });

  it("sweeps a settled CPMM market and closes redemption at the same instant", async () => {
    const { factory, treasury, signers } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const { marketId, market } = await createAmm(factory, params);
    const marketAddr = await market.getAddress();

    // A holder that refuses delivery is what keeps collateral in a settled CPMM market.
    await pushOnSettle(factory, marketId);
    const rejector = await ethers.deployContract("PayoutRejector", [marketAddr], deployer);
    await rejector.buyMarket(1n, { value: 10n ** 18n });
    await resolveVia(factory, signers, marketId, 1n);

    const held = await ethers.provider.getBalance(marketAddr);
    expect(held).to.be.greaterThan(0n);
    await expect(factory.sweepUnclaimed(marketId)).to.be.revertedWithCustomError(market, "ClaimWindowOpen");

    await networkHelpers.time.increaseTo(await market.claimDeadline());
    await rejector.startAccepting();
    await expect(rejector.redeemMarket()).to.be.revertedWithCustomError(market, "ClaimWindowClosed");

    const before = await treasury.collectedFor(marketAddr);
    await expect(factory.sweepUnclaimed(marketId))
      .to.emit(market, "UnclaimedSwept")
      .withArgs(marketAddr, await treasury.getAddress(), held);

    expect(await ethers.provider.getBalance(marketAddr)).to.equal(0n);
    expect(await market.totalSets()).to.equal(0n);
    expect(await treasury.collectedFor(marketAddr)).to.equal(before + held);
  });

  it("is admin-only", async () => {
    const { factory, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    const rejector = await ethers.deployContract("PayoutRejector", [pool], deployer);
    await rejector.betPool(0n, { value: 10n ** 18n });
    await factory.voidMarket(0n);
    await networkHelpers.time.increaseTo(await poolC.claimDeadline());

    await expect(factory.connect(alice).sweepUnclaimed(0n)).to.be.revertedWithCustomError(
      factory,
      "AccessControlUnauthorizedAccount",
    );
    await expect(factory.sweepUnclaimed(0n)).to.emit(poolC, "UnclaimedSwept");
  });
});

/**
 * Categories.
 *
 * A market files itself under a numeric category id, never a name. What that id is called
 * lives once in the factory's registry, one entry per language, so renaming or translating a
 * category is a registry edit rather than a migration over every market that used it.
 */
describe("Forecast categories", () => {
  const EN = lang("en");
  const FA = lang("fa");
  const TR = lang("tr");

  it("names one id in several languages and falls back to the default", async () => {
    const { factory } = await deployForecast();

    expect(await factory.categoryMeaning(WEATHER, EN)).to.equal("Weather");
    expect(await factory.categoryMeaning(WEATHER, FA)).to.equal("آب و هوا");

    // A language nobody has translated yet reads as the default rather than as blank.
    expect(await factory.categoryMeaning(WEATHER, TR)).to.equal("Weather");

    await expect(factory.setCategoryMeanings(WEATHER, [TR], ["Hava durumu"]))
      .to.emit(factory, "CategoryMeaningSet")
      .withArgs(WEATHER, TR, "Hava durumu");
    expect(await factory.categoryMeaning(WEATHER, TR)).to.equal("Hava durumu");

    const [langs, meanings] = await factory.categoryMeanings(WEATHER);
    expect(langs).to.deep.equal([EN, FA, TR]);
    expect(meanings).to.deep.equal(["Weather", "آب و هوا", "Hava durumu"]);
  });

  it("retranslating a category does not touch the markets under it", async () => {
    const { factory } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    expect(await poolC.categoryId()).to.equal(WEATHER);
    expect((await factory.marketAt(0n)).categoryId).to.equal(WEATHER);

    await factory.setCategoryMeanings(WEATHER, [EN], ["Climate"]);

    // The market never stored the word, so it needed no migration.
    expect(await poolC.categoryId()).to.equal(WEATHER);
    expect(await factory.categoryMeaning(WEATHER, EN)).to.equal("Climate");
  });

  it("lists markets by category", async () => {
    const { factory } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    await factory.addCategory(9, [lang("en")], ["Politics"]);

    const weather = await marketParams(deployer.address);
    await createPool(factory, weather);
    const politics = { ...weather, categoryId: 9 };
    await createPool(factory, politics);
    await createPool(factory, politics);

    expect(await factory.countByCategory(WEATHER)).to.equal(1n);
    expect(await factory.countByCategory(9)).to.equal(2n);
    const page = await factory.marketsByCategory(9, 0n, 10n);
    expect(page.length).to.equal(2);
    expect(page[0].categoryId).to.equal(9n);
    expect(await factory.categoryIds()).to.deep.equal([BigInt(WEATHER), 9n]);
  });

  it("refuses unregistered, duplicate and untranslated categories", async () => {
    const { factory } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);

    // Id 0 is reserved, so a market with an unset category cannot slip through.
    await expect(factory.createMarket2({ ...params, categoryId: 0 })).to.be.revertedWithCustomError(
      factory,
      "UnknownCategory",
    );
    await expect(factory.createMarket2({ ...params, categoryId: 404 })).to.be.revertedWithCustomError(
      factory,
      "UnknownCategory",
    );

    await expect(factory.addCategory(WEATHER, [EN], ["Weather"])).to.be.revertedWithCustomError(
      factory,
      "CategoryExists",
    );
    await expect(factory.addCategory(0, [EN], ["Nothing"])).to.be.revertedWithCustomError(
      factory,
      "UnknownCategory",
    );

    // Without the fallback language a category would read as blank everywhere else.
    await expect(factory.addCategory(11, [FA], ["ورزش"])).to.be.revertedWithCustomError(
      factory,
      "MissingDefaultMeaning",
    );
    await expect(factory.addCategory(11, [EN, FA], ["Sport"])).to.be.revertedWithCustomError(
      factory,
      "BadCategoryInput",
    );
    await expect(factory.addCategory(11, [], [])).to.be.revertedWithCustomError(factory, "BadCategoryInput");
  });

  it("retires a category without disturbing its markets", async () => {
    const { factory } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    await createPool(factory, params);

    await expect(factory.setCategoryEnabled(WEATHER, false))
      .to.emit(factory, "CategoryEnabledSet")
      .withArgs(WEATHER, false);

    await expect(factory.createMarket2(params)).to.be.revertedWithCustomError(factory, "UnknownCategory");

    // The market already filed under it stays listed and readable.
    expect(await factory.countByCategory(WEATHER)).to.equal(1n);
    expect(await factory.categoryMeaning(WEATHER, EN)).to.equal("Weather");
    expect(await factory.categoryState(WEATHER)).to.deep.equal([true, false]);

    await factory.setCategoryEnabled(WEATHER, true);
    await factory.createMarket2(params);
    expect(await factory.countByCategory(WEATHER)).to.equal(2n);
  });

  it("is admin-only", async () => {
    const { factory, alice } = await deployForecast();

    await expect(factory.connect(alice).addCategory(12, [EN], ["Nope"])).to.be.revertedWithCustomError(
      factory,
      "AccessControlUnauthorizedAccount",
    );
    await expect(
      factory.connect(alice).setCategoryMeanings(WEATHER, [EN], ["Nope"]),
    ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");
    await expect(factory.connect(alice).setCategoryEnabled(WEATHER, false)).to.be.revertedWithCustomError(
      factory,
      "AccessControlUnauthorizedAccount",
    );
  });
});

/**
 * The push at settlement is opt-in.
 *
 * Markets start with it off: participants collect their own share, exactly as they always
 * could. Turning it on changes nothing about the money, only about who pays the gas and when
 * — the permissionless distribute works either way.
 */
describe("Forecast optional distribution", () => {
  it("is off by default, leaving participants to collect their own share", async () => {
    const { factory, signers, alice, bob } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const pool = await createPool(factory, params);
    const poolC = await ethers.getContractAt("PredictionPool", pool);

    expect(await poolC.autoDistribute()).to.equal(false);

    await poolC.connect(alice).bet(0n, { value: 60n * 10n ** 18n });
    await poolC.connect(bob).bet(0n, { value: 40n * 10n ** 18n });
    await passLock(params);

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    for (let i = 0; i < 3; i++) {
      await factory.connect(signers[i]).confirmResolution(0n, 0n);
    }

    // Settlement paid nobody; the money is accounted for and waiting.
    expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore);
    expect((await poolC.distributionProgress())[0]).to.equal(0n);
    const owed = await poolC.pendingPayout(alice.address);
    expect(owed).to.equal((97n * 10n ** 18n * 60n) / 100n);

    // Alice takes her own share whenever she likes.
    const tx = await poolC.connect(alice).claim();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore + gas).to.equal(owed);

    // And anyone may still push the rest out — Bob never has to act.
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await factory.connect(signers[4]).distributeMarket(0n, 10n);
    expect((await ethers.provider.getBalance(bob.address)) - bobBefore).to.equal(
      (97n * 10n ** 18n * 40n) / 100n,
    );
    expect(await ethers.provider.getBalance(pool)).to.equal(0n);
  });

  it("can be switched on, and only by an admin", async () => {
    const { factory, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    await createPool(factory, params);

    await expect(factory.connect(alice).setMarketAutoDistribute(0n, true)).to.be.revertedWithCustomError(
      factory,
      "AccessControlUnauthorizedAccount",
    );

    const poolC = await ethers.getContractAt("PredictionPool", await factory.marketAddress(0n));
    await expect(factory.setMarketAutoDistribute(0n, true))
      .to.emit(poolC, "AutoDistributeSet")
      .withArgs(await poolC.getAddress(), true);
    expect(await poolC.autoDistribute()).to.equal(true);
  });

  it("leaves the CPMM pull path open when the push is off", async () => {
    const { factory, signers, alice } = await deployForecast();
    const [deployer] = await ethers.getSigners();
    const params = await marketParams(deployer.address);
    const { marketId, market } = await createAmm(factory, params);

    await market.connect(alice).buy(1n, 0n, params.resolveTime, { value: 10n ** 18n });
    const shares = await market.balanceOf(alice.address, 1n);

    for (let i = 0; i < 3; i++) {
      await factory.connect(signers[i]).confirmResolution(marketId, 1n);
    }
    expect((await market.distributionProgress())[0]).to.equal(0n);
    expect(await market.pendingPayout(alice.address)).to.equal(shares);

    const before = await ethers.provider.getBalance(alice.address);
    const receipt = await (await market.connect(alice).redeem()).wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    expect((await ethers.provider.getBalance(alice.address)) - before + gas).to.equal(shares);
  });
});
