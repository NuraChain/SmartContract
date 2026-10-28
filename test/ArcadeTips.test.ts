import { expect } from "chai";
import hre, { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/** Coverage instruments the bytecode, so gas measured under it says nothing about the deployed contract. */
const measuring = hre.globalOptions.coverage !== true;

const AMOUNT = ethers.parseEther("5");

const idOf = (label: string) => ethers.id(`donation:${label}`);

/** A deadline nobody here reaches. */
const FAR = 2n ** 63n;

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow would re-run the setup every time instead of
// reverting to a snapshot.

async function deploy() {
  const [admin, giver, player, outsider, next] = await ethers.getSigners();
  const tips = await ethers.deployContract("ArcadeTips", [admin.address], admin);

  return { tips, admin, giver, player, outsider, next };
}

/** The contract, and a contract wallet that gives, and on being given takes it, refuses it or gives it on. */
async function deployActor() {
  const ctx = await deploy();
  const actor = await ethers.deployContract("TipsActor", [await ctx.tips.getAddress()], ctx.admin);

  return { ...ctx, actor };
}

async function latest() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function gasCostOf(tx: { wait(): Promise<{ gasUsed: bigint; gasPrice: bigint } | null> }) {
  const receipt = await tx.wait();
  return receipt!.gasUsed * receipt!.gasPrice;
}

async function balanceOf(address: string | { getAddress(): Promise<string> }) {
  return ethers.provider.getBalance(typeof address === "string" ? address : await address.getAddress());
}

describe("ArcadeTips", () => {
  describe("deployment", () => {
    it("gives the owner the pause and nothing else to hold", async () => {
      const { tips, admin } = await loadFixture(deploy);

      expect(await tips.defaultAdmin()).to.equal(admin.address);
      expect(await tips.hasRole(await tips.PAUSER_ROLE(), admin.address)).to.equal(true);
      expect(await tips.paused()).to.equal(false);
      expect(await balanceOf(tips)).to.equal(0n);
    });

    it("refuses a zero owner", async () => {
      const factory = await ethers.getContractFactory("ArcadeTips");

      await expect(ethers.deployContract("ArcadeTips", [ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(factory, "AccessControlInvalidDefaultAdmin")
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe("giving", () => {
    it("sends the whole gift to the player in the same call, and keeps a record of it", async () => {
      const { tips, giver, player } = await loadFixture(deploy);
      const before = { giver: await balanceOf(giver.address), player: await balanceOf(player.address) };

      const tx = await tips.connect(giver).tip(idOf("first"), player.address, FAR, { value: AMOUNT });
      const cost = await gasCostOf(tx);

      await expect(tx).to.emit(tips, "Tipped").withArgs(giver.address, idOf("first"), player.address, AMOUNT);
      expect(await balanceOf(player.address)).to.equal(before.player + AMOUNT);
      expect(await balanceOf(giver.address)).to.equal(before.giver - AMOUNT - cost);
      expect(await balanceOf(tips)).to.equal(0n);

      const record = await tips.tipOf(giver.address, idOf("first"));
      expect(record.to).to.equal(player.address);
      expect(record.amount).to.equal(AMOUNT);
      expect(record.givenAt).to.equal(await latest());
    });

    it("knows nothing of an id nobody used", async () => {
      const { tips, giver } = await loadFixture(deploy);
      const record = await tips.tipOf(giver.address, idOf("never"));

      expect(record.to).to.equal(ethers.ZeroAddress);
      expect(record.amount).to.equal(0n);
      expect(record.givenAt).to.equal(0n);
    });

    it("takes the smallest gift there is, and many gifts to one player under ids of their own", async () => {
      const { tips, giver, player } = await loadFixture(deploy);
      const before = await balanceOf(player.address);

      await tips.connect(giver).tip(idOf("one wei"), player.address, FAR, { value: 1n });
      await tips.connect(giver).tip(idOf("another"), player.address, FAR, { value: AMOUNT });

      expect(await balanceOf(player.address)).to.equal(before + AMOUNT + 1n);
      expect((await tips.tipOf(giver.address, idOf("one wei"))).amount).to.equal(1n);
      expect((await tips.tipOf(giver.address, idOf("another"))).amount).to.equal(AMOUNT);
    });

    describe("refusals", () => {
      it("refuses nobody, oneself and nothing sent, and moves nothing", async () => {
        const { tips, giver, player } = await loadFixture(deploy);
        const before = await balanceOf(player.address);

        await expect(tips.connect(giver).tip(idOf("nobody"), ethers.ZeroAddress, FAR, { value: AMOUNT }))
          .to.be.revertedWithCustomError(tips, "ZeroAddress");
        await expect(tips.connect(giver).tip(idOf("self"), giver.address, FAR, { value: AMOUNT }))
          .to.be.revertedWithCustomError(tips, "SelfTip");
        await expect(tips.connect(giver).tip(idOf("empty"), player.address, FAR))
          .to.be.revertedWithCustomError(tips, "ZeroAmount");

        expect(await balanceOf(player.address)).to.equal(before);
        expect((await tips.tipOf(giver.address, idOf("empty"))).to).to.equal(ethers.ZeroAddress);
      });

      it("pays an id once a giver, whoever it would go to the second time", async () => {
        const { tips, giver, player, outsider } = await loadFixture(deploy);
        await tips.connect(giver).tip(idOf("once"), player.address, FAR, { value: AMOUNT });

        await expect(tips.connect(giver).tip(idOf("once"), player.address, FAR, { value: AMOUNT }))
          .to.be.revertedWithCustomError(tips, "TipUsed")
          .withArgs(giver.address, idOf("once"));
        await expect(tips.connect(giver).tip(idOf("once"), outsider.address, FAR, { value: 1n }))
          .to.be.revertedWithCustomError(tips, "TipUsed");

        expect((await tips.tipOf(giver.address, idOf("once"))).amount).to.equal(AMOUNT);
      });

      it("lets nobody spend a giver's id first: the same id from another wallet is that wallet's", async () => {
        const { tips, giver, player, outsider } = await loadFixture(deploy);

        await tips.connect(outsider).tip(idOf("watched for"), player.address, FAR, { value: 1n });
        await expect(tips.connect(giver).tip(idOf("watched for"), player.address, FAR, { value: AMOUNT }))
          .to.emit(tips, "Tipped")
          .withArgs(giver.address, idOf("watched for"), player.address, AMOUNT);

        expect((await tips.tipOf(giver.address, idOf("watched for"))).amount).to.equal(AMOUNT);
        expect((await tips.tipOf(outsider.address, idOf("watched for"))).amount).to.equal(1n);
      });

      it("takes a call in the second its deadline names, and refuses it one second after", async () => {
        const { tips, giver, player } = await loadFixture(deploy);
        const now = await latest();

        await networkHelpers.time.setNextBlockTimestamp(now + 10n);
        await expect(tips.connect(giver).tip(idOf("in time"), player.address, now + 10n, { value: AMOUNT })).to.emit(tips, "Tipped");

        await networkHelpers.time.setNextBlockTimestamp(now + 20n);
        await expect(tips.connect(giver).tip(idOf("too late"), player.address, now + 19n, { value: AMOUNT }))
          .to.be.revertedWithCustomError(tips, "TipExpired")
          .withArgs(giver.address, idOf("too late"), now + 19n);

        expect((await tips.tipOf(giver.address, idOf("too late"))).to).to.equal(ethers.ZeroAddress);
      });

      it("refuses a plain transfer rather than keep it", async () => {
        const { tips, giver } = await loadFixture(deploy);

        await expect(giver.sendTransaction({ to: await tips.getAddress(), value: AMOUNT })).to.be.revert(ethers);
        expect(await balanceOf(tips)).to.equal(0n);
      });
    });
  });

  describe("pausing", () => {
    it("stops new gifts and starts them again, and nobody but the owner may", async () => {
      const { tips, admin, giver, player, outsider } = await loadFixture(deploy);

      await expect(tips.connect(outsider).pause())
        .to.be.revertedWithCustomError(tips, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await tips.PAUSER_ROLE());

      await tips.connect(admin).pause();
      await expect(tips.connect(giver).tip(idOf("paused"), player.address, FAR, { value: AMOUNT }))
        .to.be.revertedWithCustomError(tips, "EnforcedPause");
      expect((await tips.tipOf(giver.address, idOf("paused"))).to).to.equal(ethers.ZeroAddress);

      await expect(tips.connect(outsider).unpause())
        .to.be.revertedWithCustomError(tips, "AccessControlUnauthorizedAccount");
      await tips.connect(admin).unpause();
      await expect(tips.connect(giver).tip(idOf("paused"), player.address, FAR, { value: AMOUNT })).to.emit(tips, "Tipped");
    });

    it("hands the pause on with the contract, in two steps", async () => {
      const { tips, admin, next } = await loadFixture(deploy);
      const pauser = await tips.PAUSER_ROLE();

      await tips.connect(admin).beginDefaultAdminTransfer(next.address);
      await tips.connect(next).acceptDefaultAdminTransfer();

      expect(await tips.defaultAdmin()).to.equal(next.address);
      expect(await tips.hasRole(pauser, next.address)).to.equal(true);
      expect(await tips.hasRole(pauser, admin.address)).to.equal(false);
      await expect(tips.connect(admin).pause()).to.be.revertedWithCustomError(tips, "AccessControlUnauthorizedAccount");
      await tips.connect(next).pause();
      expect(await tips.paused()).to.equal(true);
    });
  });

  describe("a contract on the receiving end", () => {
    it("reverts the whole gift when its receiver refuses it, and records nothing", async () => {
      const { tips, giver, actor } = await loadFixture(deployActor);
      const address = await actor.getAddress();

      await actor.setMode(1);
      await expect(tips.connect(giver).tip(idOf("refused"), address, FAR, { value: AMOUNT })).to.be.revertedWith("TipsActor: refused");

      expect((await tips.tipOf(giver.address, idOf("refused"))).to).to.equal(ethers.ZeroAddress);
      expect(await balanceOf(address)).to.equal(0n);
      expect(await balanceOf(tips)).to.equal(0n);
    });

    it("lets a receiver give it on from inside the payment, each gift recorded once", async () => {
      const { tips, giver, player, actor } = await loadFixture(deployActor);
      const address = await actor.getAddress();
      const before = await balanceOf(player.address);

      await actor.setMode(2);
      await actor.passTo(player.address, idOf("onward"));
      await tips.connect(giver).tip(idOf("to the actor"), address, FAR, { value: AMOUNT });

      expect(await actor.receiveCount()).to.equal(1n);
      expect((await tips.tipOf(giver.address, idOf("to the actor"))).to).to.equal(address);
      expect((await tips.tipOf(address, idOf("onward"))).amount).to.equal(AMOUNT);
      expect(await balanceOf(player.address)).to.equal(before + AMOUNT);
      expect(await balanceOf(address)).to.equal(0n);
      expect(await balanceOf(tips)).to.equal(0n);
    });

    it("takes a gift from a contract wallet, recorded under the contract", async () => {
      const { tips, player, actor } = await loadFixture(deployActor);
      const address = await actor.getAddress();

      await expect(actor.give(idOf("from a contract"), player.address, { value: AMOUNT }))
        .to.emit(tips, "Tipped")
        .withArgs(address, idOf("from a contract"), player.address, AMOUNT);
      expect((await tips.tipOf(address, idOf("from a contract"))).amount).to.equal(AMOUNT);
    });
  });

  (measuring ? describe : describe.skip)("gas", () => {
    it("gives within bounds", async () => {
      const { tips, giver, player } = await loadFixture(deploy);
      const receipt = await (await tips.connect(giver).tip(idOf("gas"), player.address, FAR, { value: AMOUNT })).wait();

      console.log(`      tip ${receipt!.gasUsed}`);
      expect(receipt!.gasUsed).to.be.lessThan(100_000n);
    });
  });
});
