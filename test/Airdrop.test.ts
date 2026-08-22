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

  // ---------------------------------------------------------------------------------
  // The contract's NatSpec claims a signature "cannot be replayed against another
  // deployment or a fork". That is a promise made by the EIP-712 domain separator, and
  // it is the whole reason eligibility cannot be forged, so it gets tested directly
  // rather than assumed.
  // ---------------------------------------------------------------------------------
  describe("signature domain binding", () => {
    /** Signs a claim against an arbitrary domain, so a test can vary one field at a time. */
    async function signWithDomain(
      domain: { name: string; version: string; chainId: bigint; verifyingContract: string },
      signerAccount: { signTypedData: Function },
      account: string,
      deadline: bigint,
    ) {
      return signerAccount.signTypedData(
        domain,
        {
          Claim: [
            { name: "account", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { account, deadline },
      );
    }

    async function currentDomain(airdrop: { getAddress(): Promise<string> }) {
      const { chainId } = await ethers.provider.getNetwork();

      return {
        name: "Airdrop",
        version: "1",
        chainId,
        verifyingContract: await airdrop.getAddress(),
      };
    }

    it("refuses a signature minted for a different Airdrop deployment", async () => {
      const { airdrop, admin, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();

      // A second airdrop, same admin and same signing key: only the address differs.
      const other = await ethers.deployContract(
        "Airdrop",
        [admin.address, signer.address, MAX_CLAIMS, REWARD],
        admin,
      );
      await other.fund({ value: REWARD * 2n });

      const forOther = await sign(other, signer, alice.address, deadline);

      // Valid on the contract it was signed for...
      await expect(airdrop.connect(alice).getReward(deadline, forOther)).to.be.revertedWithCustomError(
        airdrop,
        "InvalidSignature",
      );

      // ...and only there.
      await other.connect(alice).getReward(deadline, forOther);
      expect(await other.totalClaims()).to.equal(1n);
      expect(await airdrop.totalClaims()).to.equal(0n);
    });

    it("refuses a signature minted for another chain id", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const domain = await currentDomain(airdrop);

      const forkedChain = await signWithDomain(
        { ...domain, chainId: domain.chainId + 1n },
        signer,
        alice.address,
        deadline,
      );

      await expect(
        airdrop.connect(alice).getReward(deadline, forkedChain),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses a signature minted under a different domain name or version", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const domain = await currentDomain(airdrop);

      for (const wrong of [
        { ...domain, name: "Airdrop2" },
        { ...domain, version: "2" },
      ]) {
        await expect(
          airdrop
            .connect(alice)
            .getReward(deadline, await signWithDomain(wrong, signer, alice.address, deadline)),
        ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
      }
    });

    it("refuses a signature whose deadline does not match the one submitted", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();

      // Signed for `deadline`, submitted with a later one: the digest changes, so the
      // recovered address is not the signer. This is what stops a claimant stretching
      // their own expiry.
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await expect(
        airdrop.connect(alice).getReward(deadline + 1n, signature),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses a signature over a struct with the fields swapped", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const domain = await currentDomain(airdrop);

      // Same values, different type hash. If the contract hashed loosely this would pass.
      const swapped = await signer.signTypedData(
        domain,
        {
          Claim: [
            { name: "deadline", type: "uint256" },
            { name: "account", type: "address" },
          ],
        },
        { account: alice.address, deadline },
      );

      await expect(
        airdrop.connect(alice).getReward(deadline, swapped),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
    });

    it("refuses a malleable high-s variant of an otherwise valid signature", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();

      const original = await sign(airdrop, signer, alice.address, deadline);
      const { r, s, v } = ethers.Signature.from(original);

      // The second valid (r, s) pair for the same point: s' = n - s, with v flipped.
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const flipped = ethers.concat([
        r,
        ethers.zeroPadValue(ethers.toBeHex(n - BigInt(s)), 32),
        ethers.toBeHex(v === 27 ? 28 : 27, 1),
      ]);

      // ECDSA.tryRecover rejects the upper half of the curve outright.
      await expect(
        airdrop.connect(alice).getReward(deadline, flipped),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");

      // The original still works, so the flip is what was rejected, not the claim.
      await airdrop.connect(alice).getReward(deadline, original);
      expect(await airdrop.totalClaims()).to.equal(1n);
    });

    it("refuses signature bytes of the wrong length", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);
      const deadline = await soon();
      const valid = await sign(airdrop, signer, alice.address, deadline);

      for (const bad of ["0x", ethers.dataSlice(valid, 0, 64), ethers.concat([valid, "0x00"])]) {
        await expect(
          airdrop.connect(alice).getReward(deadline, bad),
        ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");
      }
    });

    it("cannot be claimed by a different address holding someone else's signature", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployFunded);
      const deadline = await soon();

      // Bob front-runs Alice with her own signature. The digest binds the account, and
      // getReward reads the account from msg.sender, so there is nothing to steal.
      const forAlice = await sign(airdrop, signer, alice.address, deadline);

      await expect(
        airdrop.connect(bob).getReward(deadline, forAlice),
      ).to.be.revertedWithCustomError(airdrop, "InvalidSignature");

      await airdrop.connect(alice).getReward(deadline, forAlice);
      expect(await airdrop.hasClaimed(alice.address)).to.equal(true);
      expect(await airdrop.hasClaimed(bob.address)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------------
  // getReward pays with Address.sendValue, which forwards all remaining gas. A contract
  // claimant therefore runs its own code inside the claim, which is the only point where
  // this contract hands over control.
  // ---------------------------------------------------------------------------------
  describe("hostile claimants", () => {
    it("blocks a claim re-entered from the payout, without losing the honest claim", async () => {
      const { airdrop, signer, admin } = await loadFixture(deployFunded);
      const deadline = await soon();

      const claimer = await ethers.deployContract(
        "ReentrantClaimer",
        [await airdrop.getAddress()],
        admin,
      );
      const claimerAddress = await claimer.getAddress();
      const signature = await sign(airdrop, signer, claimerAddress, deadline);

      await claimer.claim(deadline, signature);

      // The re-entrant call was rejected...
      expect(await claimer.reenteredCallFailed()).to.equal(true);
      expect(await claimer.receiveCount()).to.equal(1n);

      // ...and the legitimate claim still settled exactly once.
      expect(await airdrop.totalClaims()).to.equal(1n);
      expect(await airdrop.hasClaimed(claimerAddress)).to.equal(true);
      expect(await ethers.provider.getBalance(claimerAddress)).to.equal(REWARD);
    });

    it("reverts the whole claim when the recipient rejects the payout", async () => {
      const { airdrop, signer, admin } = await loadFixture(deployFunded);
      const deadline = await soon();

      const claimer = await ethers.deployContract(
        "RejectingClaimer",
        [await airdrop.getAddress()],
        admin,
      );
      const claimerAddress = await claimer.getAddress();
      const signature = await sign(airdrop, signer, claimerAddress, deadline);
      const poolBefore = await ethers.provider.getBalance(await airdrop.getAddress());

      // Address.sendValue bubbles the recipient's own reason rather than masking it, so a
      // failed payout is debuggable from the trace instead of surfacing as a bare FailedCall.
      await expect(claimer.claim(deadline, signature)).to.be.revertedWith("no thanks");

      // Nothing was consumed: the slot is still claimable and the pool is untouched.
      expect(await airdrop.hasClaimed(claimerAddress)).to.equal(false);
      expect(await airdrop.totalClaims()).to.equal(0n);
      expect(await ethers.provider.getBalance(await airdrop.getAddress())).to.equal(poolBefore);
    });
  });

  describe("boundaries", () => {
    it("accepts a claim in the same second the signature expires", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);

      // getReward rejects on `block.timestamp > deadline`, so the deadline second itself
      // is still valid. Mining at exactly that timestamp pins the edge.
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 60n;
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await networkHelpers.time.setNextBlockTimestamp(deadline);
      await airdrop.connect(alice).getReward(deadline, signature);

      expect(await airdrop.totalClaims()).to.equal(1n);
    });

    it("rejects a claim one second past the deadline", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployFunded);

      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 60n;
      const signature = await sign(airdrop, signer, alice.address, deadline);

      await networkHelpers.time.setNextBlockTimestamp(deadline + 1n);
      await expect(airdrop.connect(alice).getReward(deadline, signature))
        .to.be.revertedWithCustomError(airdrop, "SignatureExpired")
        .withArgs(deadline);
    });

    it("pays the last claim when the pool holds exactly one reward", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployUnfunded);
      const deadline = await soon();

      await airdrop.fund({ value: REWARD });

      await airdrop.connect(alice).getReward(deadline, await sign(airdrop, signer, alice.address, deadline));
      expect(await ethers.provider.getBalance(await airdrop.getAddress())).to.equal(0n);

      await expect(
        airdrop.connect(bob).getReward(deadline, await sign(airdrop, signer, bob.address, deadline)),
      )
        .to.be.revertedWithCustomError(airdrop, "InsufficientBalance")
        .withArgs(0n, REWARD);
    });

    it("rejects a claim one wei short of a reward", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployUnfunded);
      const deadline = await soon();

      await airdrop.fund({ value: REWARD - 1n });

      await expect(
        airdrop.connect(alice).getReward(deadline, await sign(airdrop, signer, alice.address, deadline)),
      )
        .to.be.revertedWithCustomError(airdrop, "InsufficientBalance")
        .withArgs(REWARD - 1n, REWARD);
    });

    it("reports claims, funded claims and liability consistently as the pool drains", async () => {
      const { airdrop, signer, alice, bob } = await loadFixture(deployUnfunded);
      const deadline = await soon();

      await airdrop.fund({ value: REWARD * 3n });

      expect(await airdrop.remainingClaims()).to.equal(MAX_CLAIMS);
      expect(await airdrop.fundedClaims()).to.equal(3n);
      expect(await airdrop.outstandingLiability()).to.equal(MAX_CLAIMS * REWARD);

      await airdrop.connect(alice).getReward(deadline, await sign(airdrop, signer, alice.address, deadline));

      expect(await airdrop.remainingClaims()).to.equal(MAX_CLAIMS - 1n);
      expect(await airdrop.fundedClaims()).to.equal(2n);
      expect(await airdrop.outstandingLiability()).to.equal((MAX_CLAIMS - 1n) * REWARD);

      await airdrop.connect(bob).getReward(deadline, await sign(airdrop, signer, bob.address, deadline));
      expect(await airdrop.fundedClaims()).to.equal(1n);
    });

    it("reports zero remaining claims and zero liability once the cap is reached", async () => {
      const { airdrop, signer, alice } = await loadFixture(deployTinyCap);
      const deadline = await soon();

      await airdrop.connect(alice).getReward(deadline, await sign(airdrop, signer, alice.address, deadline));

      expect(await airdrop.remainingClaims()).to.equal(0n);
      expect(await airdrop.outstandingLiability()).to.equal(0n);
    });
  });

  describe("pause round trip", () => {
    it("resumes claiming after unpause", async () => {
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

    it("blocks unpause from an account without PAUSER_ROLE", async () => {
      const { airdrop, alice } = await loadFixture(deployFunded);

      await airdrop.pause();
      await expect(airdrop.connect(alice).unpause()).to.be.revertedWithCustomError(
        airdrop,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("leaves funding and withdrawal available while paused", async () => {
      const { airdrop, admin } = await loadFixture(deployFunded);

      await airdrop.pause();

      // Pausing stops claims, not treasury operations — an operator has to be able to
      // recover the pool from a contract that is halted.
      await expect(airdrop.fund({ value: REWARD })).to.emit(airdrop, "Funded");
      await expect(airdrop.withdraw(admin.address, REWARD)).to.emit(airdrop, "Withdrawn");
    });
  });

  describe("input validation", () => {
    it("rejects a zero reward amount", async () => {
      const { airdrop } = await loadFixture(deployUnfunded);

      await expect(airdrop.setRewardAmount(0n)).to.be.revertedWithCustomError(
        airdrop,
        "ZeroAmount",
      );
    });

    it("rejects a withdrawal to the zero address", async () => {
      const { airdrop } = await loadFixture(deployFunded);

      await expect(
        airdrop.withdraw(ethers.ZeroAddress, REWARD),
      ).to.be.revertedWithCustomError(airdrop, "ZeroAddress");
    });

    it("rejects a zero-amount withdrawal", async () => {
      const { airdrop, admin } = await loadFixture(deployFunded);

      await expect(airdrop.withdraw(admin.address, 0n)).to.be.revertedWithCustomError(
        airdrop,
        "ZeroAmount",
      );
    });

    it("credits a plain transfer through receive() to the pool", async () => {
      const { airdrop, admin } = await loadFixture(deployUnfunded);
      const airdropAddress = await airdrop.getAddress();

      await expect(admin.sendTransaction({ to: airdropAddress, value: REWARD }))
        .to.emit(airdrop, "Funded")
        .withArgs(admin.address, REWARD);

      expect(await ethers.provider.getBalance(airdropAddress)).to.equal(REWARD);
      expect(await airdrop.fundedClaims()).to.equal(1n);
    });
  });
});
