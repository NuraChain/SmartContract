import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

const ZERO = ethers.ZeroAddress;

/** Deploys BridgeUSDT with `admin` as the sole role holder. */
async function deployUSDT() {
  const [admin, bridge, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("BridgeUSDT", [admin.address], admin);
  return { token, admin, bridge, alice, bob };
}

describe("BridgeUSDT", () => {
  describe("deployment", () => {
    it("exposes the expected metadata", async () => {
      const { token } = await deployUSDT();

      expect(await token.name()).to.equal("Bridge USDT");
      expect(await token.symbol()).to.equal("USDT");
      expect(await token.decimals()).to.equal(18n);
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("grants every role to the admin", async () => {
      const { token, admin } = await deployUSDT();

      for (const role of [
        await token.DEFAULT_ADMIN_ROLE(),
        await token.MINTER_ROLE(),
        await token.BURNER_ROLE(),
        await token.PAUSER_ROLE(),
      ]) {
        expect(await token.hasRole(role, admin.address)).to.equal(true);
      }
    });

    it("rejects the zero address as admin", async () => {
      const factory = await ethers.getContractFactory("BridgeUSDT");

      await expect(factory.deploy(ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("mint", () => {
    it("lets the minter create supply", async () => {
      const { token, admin, alice } = await deployUSDT();
      const amount = ethers.parseUnits("1000", 18);

      await expect(token.mint(alice.address, amount))
        .to.emit(token, "BridgeMint")
        .withArgs(alice.address, amount, admin.address);

      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await token.totalSupply()).to.equal(amount);
    });

    it("blocks accounts without MINTER_ROLE", async () => {
      const { token, alice } = await deployUSDT();

      await expect(token.connect(alice).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.MINTER_ROLE());
    });

    it("mints a batch in one transaction", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amounts = [ethers.parseUnits("5", 18), ethers.parseUnits("7", 18)];

      await token.mintBatch([alice.address, bob.address], amounts);

      expect(await token.balanceOf(alice.address)).to.equal(amounts[0]);
      expect(await token.balanceOf(bob.address)).to.equal(amounts[1]);
    });

    it("rejects a batch with mismatched array lengths", async () => {
      const { token, alice, bob } = await deployUSDT();

      await expect(token.mintBatch([alice.address, bob.address], [1n]))
        .to.be.revertedWithCustomError(token, "ArrayLengthMismatch")
        .withArgs(2n, 1n);
    });

    it("rejects an empty batch", async () => {
      const { token } = await deployUSDT();

      await expect(token.mintBatch([], [])).to.be.revertedWithCustomError(token, "EmptyBatch");
    });
  });

  describe("burn", () => {
    it("lets the burner destroy any balance without an allowance", async () => {
      const { token, admin, alice } = await deployUSDT();
      const amount = ethers.parseUnits("100", 18);
      await token.mint(alice.address, amount);

      await expect(token.adminBurn(alice.address, amount))
        .to.emit(token, "BridgeBurn")
        .withArgs(alice.address, amount, admin.address);

      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("blocks accounts without BURNER_ROLE", async () => {
      const { token, alice, bob } = await deployUSDT();
      await token.mint(bob.address, 10n);

      await expect(token.connect(alice).adminBurn(bob.address, 10n))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.BURNER_ROLE());
    });

    it("lets a holder burn their own balance to exit the bridge", async () => {
      const { token, alice } = await deployUSDT();
      const amount = ethers.parseUnits("40", 18);
      await token.mint(alice.address, amount);

      await token.connect(alice).burn(amount);

      expect(await token.totalSupply()).to.equal(0n);
    });

    it("keeps the inherited burnFrom allowance-gated", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amount = ethers.parseUnits("40", 18);
      await token.mint(alice.address, amount);

      await expect(token.connect(bob).burnFrom(alice.address, amount)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance",
      );

      await token.connect(alice).approve(bob.address, amount);
      await token.connect(bob).burnFrom(alice.address, amount);

      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("role delegation", () => {
    it("lets the admin hand minting to a bridge contract and take it back", async () => {
      const { token, bridge, alice } = await deployUSDT();
      const minterRole = await token.MINTER_ROLE();

      await token.grantRole(minterRole, bridge.address);
      await token.connect(bridge).mint(alice.address, 1_000n);
      expect(await token.balanceOf(alice.address)).to.equal(1_000n);

      await token.revokeRole(minterRole, bridge.address);
      await expect(
        token.connect(bridge).mint(alice.address, 1_000n),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("blocks non-admins from granting roles", async () => {
      const { token, alice, bob } = await deployUSDT();

      await expect(
        token.connect(alice).grantRole(await token.MINTER_ROLE(), bob.address),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("pause", () => {
    it("halts transfers and mints, and resumes on unpause", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amount = ethers.parseUnits("10", 18);
      await token.mint(alice.address, amount);

      await token.pause();

      await expect(token.connect(alice).transfer(bob.address, amount)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
      await expect(token.mint(alice.address, amount)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await token.unpause();
      await token.connect(alice).transfer(bob.address, amount);

      expect(await token.balanceOf(bob.address)).to.equal(amount);
    });

    it("blocks accounts without PAUSER_ROLE", async () => {
      const { token, alice } = await deployUSDT();

      await expect(token.connect(alice).pause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("permit", () => {
    it("approves a spender from an off-chain signature", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amount = ethers.parseUnits("25", 18);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const tokenAddress = await token.getAddress();
      const { chainId } = await ethers.provider.getNetwork();

      const signature = await alice.signTypedData(
        { name: "Bridge USDT", version: "1", chainId, verifyingContract: tokenAddress },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        {
          owner: alice.address,
          spender: bob.address,
          value: amount,
          nonce: await token.nonces(alice.address),
          deadline,
        },
      );
      const { v, r, s } = ethers.Signature.from(signature);

      await token.permit(alice.address, bob.address, amount, deadline, v, r, s);

      expect(await token.allowance(alice.address, bob.address)).to.equal(amount);
    });
  });

  describe("rescueERC20", () => {
    it("sweeps another token that was sent here by mistake", async () => {
      const { token, admin, alice } = await deployUSDT();
      const stray = await ethers.deployContract("BridgeBNB", [admin.address], admin);
      const amount = ethers.parseUnits("3", 18);

      await stray.mint(await token.getAddress(), amount);

      await expect(token.rescueERC20(await stray.getAddress(), alice.address, amount))
        .to.emit(token, "TokensRescued")
        .withArgs(await stray.getAddress(), alice.address, amount);

      expect(await stray.balanceOf(alice.address)).to.equal(amount);
    });

    it("blocks non-admins", async () => {
      const { token, alice } = await deployUSDT();

      await expect(
        token.connect(alice).rescueERC20(await token.getAddress(), alice.address, 1n),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });
});

describe("BridgeBNB", () => {
  it("exposes the expected metadata and mints", async () => {
    const [admin, alice] = await ethers.getSigners();
    const token = await ethers.deployContract("BridgeBNB", [admin.address], admin);
    const amount = ethers.parseUnits("2.5", 18);

    expect(await token.name()).to.equal("Bridge BNB");
    expect(await token.symbol()).to.equal("BNB");
    expect(await token.decimals()).to.equal(18n);

    await token.mint(alice.address, amount);
    expect(await token.balanceOf(alice.address)).to.equal(amount);
  });
});
