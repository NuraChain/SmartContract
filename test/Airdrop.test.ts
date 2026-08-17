import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

const MAX_CLAIMS = 50_000n;
const REWARD = ethers.parseEther("200");

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow would re-run the setup every time instead of
// reverting to a snapshot. Each test then starts from a clean chain, which matters here
// because funding the pool moves 2,000 native coin per run out of the admin account.

async function deployUnfunded() {
  const [admin, signer, alice, bob, carol] = await ethers.getSigners();
  const airdrop = await ethers.deployContract(
    "Airdrop",
    [admin.address, signer.address, MAX_CLAIMS, REWARD],
    admin,
  );
  return { airdrop, admin, signer, alice, bob, carol };
}

async function deployFunded() {
  const ctx = await deployUnfunded();
  await ctx.airdrop.fund({ value: REWARD * 10n });
  return ctx;
}

async function deployTinyCap() {
  const [admin, signer, alice, bob] = await ethers.getSigners();
  const airdrop = await ethers.deployContract(
    "Airdrop",
    [admin.address, signer.address, 1n, REWARD],
    admin,
  );
  await airdrop.fund({ value: REWARD * 2n });
  return { airdrop, admin, signer, alice, bob };
}

/** Signs an eligibility approval the way the backend would. */
async function sign(
  airdrop: { getAddress(): Promise<string> },
  signer: { signTypedData: Function },
  account: string,
  deadline: bigint,
) {
  const { chainId } = await ethers.provider.getNetwork();

  return signer.signTypedData(
    {
      name: "Airdrop",
      version: "1",
      chainId,
      verifyingContract: await airdrop.getAddress(),
    },
    {
      Claim: [
        { name: "account", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { account, deadline },
  );
}

async function soon() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp) + 3600n;
}

describe("Airdrop", () => {
  describe("deployment", () => {
    it("stores the cap, reward and roles", async () => {
      const { airdrop, admin, signer } = await loadFixture(deployUnfunded);

      expect(await airdrop.maxClaims()).to.equal(MAX_CLAIMS);
      expect(await airdrop.rewardAmount()).to.equal(REWARD);
      expect(await airdrop.totalClaims()).to.equal(0n);
      expect(await airdrop.hasRole(await airdrop.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await airdrop.hasRole(await airdrop.SIGNER_ROLE(), signer.address)).to.equal(true);
    });

    it("rejects zero addresses and zero amounts", async () => {
      const { admin, signer } = await loadFixture(deployUnfunded);
      const factory = await ethers.getContractFactory("Airdrop");

      await expect(
        factory.deploy(ethers.ZeroAddress, signer.address, MAX_CLAIMS, REWARD),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        factory.deploy(admin.address, ethers.ZeroAddress, MAX_CLAIMS, REWARD),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        factory.deploy(admin.address, signer.address, 0n, REWARD),
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");

      await expect(
        factory.deploy(admin.address, signer.address, MAX_CLAIMS, 0n),
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");
    });
  });

  describe("getReward", () => {
    it("pays 200 to a signed claimer and records the claim", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const signature = await sign(airdrop, signer, alice.address, deadline);

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await airdrop.connect(alice).getReward(deadline, signature);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      await expect(tx).to.emit(airdrop, "RewardClaimed").withArgs(alice.address, REWARD, 1n);

      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + REWARD - gasCost);
      expect(await airdrop.hasClaimed(alice.address)).to.equal(true);
      expect(await airdrop.totalClaims()).to.equal(1n);
    });

    it("refuses a second claim from the same address", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await airdrop.connect(alice).getReward(deadline, signature);

      await expect(airdrop.connect(alice).getReward(deadline, signature))
        .to.be.revertedWithCustomError(airdrop, "AlreadyClaimed")
        .withArgs(alice.address);
    });

    it("refuses a signature issued for a different address", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployFunded);
      const deadline = await soon();
      const forAlice = await sign(airdrop, signer, alice.address, deadline);

      await expect(
        airdrop.connect(bob).getReward(deadline, forAlice),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses a signature from a key without SIGNER_ROLE", async () => {
      const { airdrop, alice, carol } = await loadFixture(deployFunded);
      const deadline = await soon();
      const rogue = await sign(airdrop, carol, alice.address, deadline);

      await expect(
        airdrop.connect(alice).getReward(deadline, rogue),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses malformed signature bytes", async () => {
      const { airdrop, alice } = await loadFixture(deployFunded);

      await expect(
        airdrop.connect(alice).getReward(await soon(), "0xdeadbeef"),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses an expired signature", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const block = await ethers.provider.getBlock("latest");
      const past = BigInt(block!.timestamp) - 60n;
      const signature = await sign(airdrop, signer, alice.address, past);

      await expect(airdrop.connect(alice).getReward(past, signature))
        .to.be.revertedWithCustomError(airdrop, "SignatureExpired")
        .withArgs(past);
    });

    it("refuses to pay when the pool is empty", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployUnfunded);
      const deadline = await soon();
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await expect(
        airdrop.connect(alice).getReward(deadline, signature),
      ).to.be.revertedWithCustomError(airdrop, "InsufficientBalance");
    });

    it("refuses claims while paused, and allows them after unpause", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await airdrop.pause();
      await expect(
        airdrop.connect(alice).getReward(deadline, signature),
      ).to.be.revertedWithCustomError(airdrop, "EnforcedPause");

      await airdrop.unpause();
      await airdrop.connect(alice).getReward(deadline, signature);
      expect(await airdrop.totalClaims()).to.equal(1n);
    });

    it("serves several distinct claimers and counts each once", async () => {
      const { airdrop, signer, alice, bob, carol } = await loadFixture(deployFunded);
      const deadline = await soon();

      for (const account of [alice, bob, carol]) {
        const signature = await sign(airdrop, signer, account.address, deadline);
        await airdrop.connect(account).getReward(deadline, signature);
      }

      expect(await airdrop.totalClaims()).to.equal(3n);
      expect(await airdrop.remainingClaims()).to.equal(MAX_CLAIMS - 3n);
    });

    it("stops at the cap", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployTinyCap);
      const deadline = await soon();

      await airdrop
        .connect(alice)
        .getReward(deadline, await sign(airdrop, signer, alice.address, deadline));

      await expect(
        airdrop.connect(bob).getReward(deadline, await sign(airdrop, signer, bob.address, deadline)),
      )
        .to.be.revertedWithCustomError(airdrop, "AirdropFull")
        .withArgs(1n);
    });

    it("matches the digest exposed by claimDigest", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const signature = await sign(airdrop, signer, alice.address, deadline);
      const digest = await airdrop.claimDigest(alice.address, deadline);

      expect(ethers.recoverAddress(digest, signature)).to.equal(signer.address);
    });
  });

  describe("funding and accounting", () => {
    it("accepts plain transfers and reports pool coverage", async () => {
      const { airdrop, admin } = await loadFixture(deployUnfunded);

      await expect(admin.sendTransaction({ to: await airdrop.getAddress(), value: REWARD * 3n }))
        .to.emit(airdrop, "Funded")
        .withArgs(admin.address, REWARD * 3n);

      expect(await airdrop.fundedClaims()).to.equal(3n);
      expect(await airdrop.outstandingLiability()).to.equal(MAX_CLAIMS * REWARD);
    });

    it("rejects a zero-value fund call", async () => {
      const { airdrop } = await loadFixture(deployUnfunded);

      await expect(airdrop.fund({ value: 0n })).to.be.revertedWithCustomError(airdrop, "ZeroAmount");
    });

    it("lets the admin withdraw the remainder", async () => {
      const { airdrop, alice } = await loadFixture(deployFunded);

      await expect(airdrop.withdraw(alice.address, REWARD))
        .to.emit(airdrop, "Withdrawn")
        .withArgs(alice.address, REWARD);

      expect(await ethers.provider.getBalance(await airdrop.getAddress())).to.equal(REWARD * 9n);
    });

    it("blocks non-admins from withdrawing", async () => {
      const { airdrop, alice } = await loadFixture(deployFunded);

      await expect(
        airdrop.connect(alice).withdraw(alice.address, REWARD),
      ).to.be.revertedWithCustomError(airdrop, "AccessControlUnauthorizedAccount");
    });

    it("refuses to withdraw more than the balance", async () => {
      const { airdrop, alice } = await loadFixture(deployFunded);

      await expect(
        airdrop.withdraw(alice.address, REWARD * 50n),
      ).to.be.revertedWithCustomError(airdrop, "InsufficientBalance");
    });
  });

  describe("administration", () => {
    it("lets the admin change the reward for future claims only", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployFunded);
      const deadline = await soon();
      const newReward = ethers.parseEther("50");

      await airdrop
        .connect(alice)
        .getReward(deadline, await sign(airdrop, signer, alice.address, deadline));

      await expect(airdrop.setRewardAmount(newReward))
        .to.emit(airdrop, "RewardAmountUpdated")
        .withArgs(REWARD, newReward);

      const before = await ethers.provider.getBalance(bob.address);
      const tx = await airdrop
        .connect(bob)
        .getReward(deadline, await sign(airdrop, signer, bob.address, deadline));
      const receipt = await tx.wait();

      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        before + newReward - receipt!.gasUsed * receipt!.gasPrice,
      );
    });

    it("blocks non-admins from changing the reward", async () => {
      const { airdrop, alice } = await loadFixture(deployUnfunded);

      await expect(
        airdrop.connect(alice).setRewardAmount(1n),
      ).to.be.revertedWithCustomError(airdrop, "AccessControlUnauthorizedAccount");
    });

    it("lets the admin rotate the signing key", async () => {
      const { airdrop, signer, carol, alice } = await loadFixture(deployFunded);
      const signerRole = await airdrop.SIGNER_ROLE();
      const deadline = await soon();

      await airdrop.revokeRole(signerRole, signer.address);
      await airdrop.grantRole(signerRole, carol.address);

      await expect(
        airdrop.connect(alice).getReward(deadline, await sign(airdrop, signer, alice.address, deadline)),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");

      await airdrop
        .connect(alice)
        .getReward(deadline, await sign(airdrop, carol, alice.address, deadline));

      expect(await airdrop.totalClaims()).to.equal(1n);
    });
  });
});
