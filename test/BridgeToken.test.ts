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

  // ---------------------------------------------------------------------------------
  // permit is an off-chain approval: a signature that moves an allowance without the
  // owner sending a transaction. Everything that keeps one signature from becoming an
  // unlimited, permanent, cross-contract approval lives in the EIP-712 digest, so each
  // field that binds it gets varied on its own.
  // ---------------------------------------------------------------------------------
  describe("permit security", () => {
    const PERMIT_TYPE = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    /** Signs a permit, defaulting every field to a valid one so a test can break exactly one. */
    async function signPermit(
      token: { getAddress(): Promise<string> },
      owner: { address: string; signTypedData: Function },
      overrides: {
        domainName?: string;
        chainId?: bigint;
        verifyingContract?: string;
        spender: string;
        value: bigint;
        nonce: bigint;
        deadline: bigint;
      },
    ) {
      const { chainId } = await ethers.provider.getNetwork();

      return owner.signTypedData(
        {
          name: overrides.domainName ?? "Bridge USDT",
          version: "1",
          chainId: overrides.chainId ?? chainId,
          verifyingContract: overrides.verifyingContract ?? (await token.getAddress()),
        },
        PERMIT_TYPE,
        {
          owner: owner.address,
          spender: overrides.spender,
          value: overrides.value,
          nonce: overrides.nonce,
          deadline: overrides.deadline,
        },
      );
    }

    /** A valid permit for `alice -> bob`, ready to be submitted or tampered with. */
    async function validPermit(overrides: Record<string, unknown> = {}) {
      const ctx = await deployUSDT();
      const value = ethers.parseUnits("25", 18);
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 3600n;

      const signature = await signPermit(ctx.token, ctx.alice, {
        spender: ctx.bob.address,
        value,
        nonce: await ctx.token.nonces(ctx.alice.address),
        deadline,
        ...overrides,
      });

      const { v, r, s } = ethers.Signature.from(signature);

      return { ...ctx, value, deadline, v, r, s };
    }

    it("consumes the nonce so the same signature cannot be replayed", async () => {
      const { token, alice, bob, value, deadline, v, r, s } = await validPermit();

      expect(await token.nonces(alice.address)).to.equal(0n);
      await token.permit(alice.address, bob.address, value, deadline, v, r, s);
      expect(await token.nonces(alice.address)).to.equal(1n);

      // Spend the allowance, then try to restore it with the same signature.
      await token.mint(alice.address, value);
      await token.connect(bob).transferFrom(alice.address, bob.address, value);
      expect(await token.allowance(alice.address, bob.address)).to.equal(0n);

      await expect(
        token.permit(alice.address, bob.address, value, deadline, v, r, s),
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");

      expect(await token.allowance(alice.address, bob.address)).to.equal(0n);
    });

    it("rejects a permit whose deadline has passed", async () => {
      const { token, alice, bob, value, v, r, s } = await validPermit();
      const block = await ethers.provider.getBlock("latest");
      const past = BigInt(block!.timestamp) - 1n;

      await expect(token.permit(alice.address, bob.address, value, past, v, r, s))
        .to.be.revertedWithCustomError(token, "ERC2612ExpiredSignature")
        .withArgs(past);
    });

    it("rejects a permit submitted for a different spender", async () => {
      const { token, alice, bob, admin, value, deadline, v, r, s } = await validPermit();

      // Signed for bob, submitted naming admin: the digest no longer matches.
      await expect(
        token.permit(alice.address, admin.address, value, deadline, v, r, s),
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");

      expect(await token.allowance(alice.address, admin.address)).to.equal(0n);
      expect(await token.allowance(alice.address, bob.address)).to.equal(0n);
    });

    it("rejects a permit submitted for a larger value than was signed", async () => {
      const { token, alice, bob, value, deadline, v, r, s } = await validPermit();

      await expect(
        token.permit(alice.address, bob.address, value + 1n, deadline, v, r, s),
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("rejects a permit signed against another token contract", async () => {
      const { token, admin, alice, bob } = await deployUSDT();
      const other = await ethers.deployContract("BridgeBNB", [admin.address], admin);
      const value = ethers.parseUnits("25", 18);
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 3600n;

      // A real, valid permit — for BridgeBNB. Its domain names a different contract and a
      // different token name, so BridgeUSDT must not honour it.
      const signature = await signPermit(other, alice, {
        domainName: "Bridge BNB",
        verifyingContract: await other.getAddress(),
        spender: bob.address,
        value,
        nonce: await other.nonces(alice.address),
        deadline,
      });
      const { v, r, s } = ethers.Signature.from(signature);

      await expect(
        token.permit(alice.address, bob.address, value, deadline, v, r, s),
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");

      // The same signature is valid where it belongs.
      await other.permit(alice.address, bob.address, value, deadline, v, r, s);
      expect(await other.allowance(alice.address, bob.address)).to.equal(value);
    });

    it("rejects a permit signed for another chain id", async () => {
      const { chainId } = await ethers.provider.getNetwork();
      const { token, alice, bob, value, deadline, v, r, s } = await validPermit({
        chainId: chainId + 1n,
      });

      await expect(
        token.permit(alice.address, bob.address, value, deadline, v, r, s),
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("rejects a permit signed with a stale nonce", async () => {
      const ctx = await deployUSDT();
      const value = ethers.parseUnits("25", 18);
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 3600n;

      // Two signatures made back to back both claim nonce 0. Only the first can land.
      const first = ethers.Signature.from(
        await signPermit(ctx.token, ctx.alice, {
          spender: ctx.bob.address,
          value,
          nonce: 0n,
          deadline,
        }),
      );
      const second = ethers.Signature.from(
        await signPermit(ctx.token, ctx.alice, {
          spender: ctx.admin.address,
          value,
          nonce: 0n,
          deadline,
        }),
      );

      await ctx.token.permit(ctx.alice.address, ctx.bob.address, value, deadline, first.v, first.r, first.s);

      await expect(
        ctx.token.permit(ctx.alice.address, ctx.admin.address, value, deadline, second.v, second.r, second.s),
      ).to.be.revertedWithCustomError(ctx.token, "ERC2612InvalidSigner");
    });

    it("exposes a DOMAIN_SEPARATOR matching the EIP-712 definition", async () => {
      const { token } = await deployUSDT();
      const { chainId } = await ethers.provider.getNetwork();

      const expected = ethers.TypedDataEncoder.hashDomain({
        name: "Bridge USDT",
        version: "1",
        chainId,
        verifyingContract: await token.getAddress(),
      });

      expect(await token.DOMAIN_SEPARATOR()).to.equal(expected);
    });

    it("hands the spender a working allowance end to end", async () => {
      const { token, alice, bob, value, deadline, v, r, s } = await validPermit();

      await token.mint(alice.address, value * 2n);
      await token.permit(alice.address, bob.address, value, deadline, v, r, s);

      await token.connect(bob).transferFrom(alice.address, bob.address, value);

      expect(await token.balanceOf(bob.address)).to.equal(value);
      expect(await token.allowance(alice.address, bob.address)).to.equal(0n);

      // The allowance was exact, so a second pull has nothing left to take.
      await expect(
        token.connect(bob).transferFrom(alice.address, bob.address, 1n),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("still records an approval while the token is paused, but cannot move it", async () => {
      const { token, alice, bob, value, deadline, v, r, s } = await validPermit();

      await token.mint(alice.address, value);
      await token.pause();

      // permit only writes an allowance; it never calls _update, so pausing does not stop it.
      await token.permit(alice.address, bob.address, value, deadline, v, r, s);
      expect(await token.allowance(alice.address, bob.address)).to.equal(value);

      await expect(
        token.connect(bob).transferFrom(alice.address, bob.address, value),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });
  });

  describe("pause coverage", () => {
    it("resumes every operation after unpause", async () => {
      const { token, admin, alice } = await deployUSDT();
      const amount = ethers.parseUnits("10", 18);

      await token.mint(alice.address, amount);
      await token.pause();
      await token.unpause();

      await token.mint(alice.address, amount);
      await token.connect(alice).transfer(admin.address, amount);
      await token.adminBurn(alice.address, amount);

      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.balanceOf(admin.address)).to.equal(amount);
    });

    it("halts burns and batch mints as well as transfers", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amount = ethers.parseUnits("10", 18);

      await token.mint(alice.address, amount);
      await token.pause();

      await expect(token.adminBurn(alice.address, amount)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
      await expect(token.connect(alice).burn(amount)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
      await expect(
        token.mintBatch([alice.address, bob.address], [amount, amount]),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("blocks unpause from an account without PAUSER_ROLE", async () => {
      const { token, alice } = await deployUSDT();

      await token.pause();
      await expect(token.connect(alice).unpause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("role administration", () => {
    it("files every role under DEFAULT_ADMIN_ROLE", async () => {
      const { token } = await deployUSDT();
      const defaultAdmin = await token.DEFAULT_ADMIN_ROLE();

      for (const role of [
        await token.MINTER_ROLE(),
        await token.BURNER_ROLE(),
        await token.PAUSER_ROLE(),
      ]) {
        expect(await token.getRoleAdmin(role)).to.equal(defaultAdmin);
      }
    });

    it("lets a holder renounce their own role but not someone else's", async () => {
      const { token, admin, alice } = await deployUSDT();
      const minter = await token.MINTER_ROLE();

      await token.grantRole(minter, alice.address);
      await token.connect(alice).renounceRole(minter, alice.address);
      expect(await token.hasRole(minter, alice.address)).to.equal(false);

      // renounceRole is self-only, whatever roles the caller holds elsewhere.
      await expect(
        token.connect(alice).renounceRole(minter, admin.address),
      ).to.be.revertedWithCustomError(token, "AccessControlBadConfirmation");
    });

    it("survives the admin handing DEFAULT_ADMIN_ROLE on and stepping down", async () => {
      const { token, admin, alice } = await deployUSDT();
      const defaultAdmin = await token.DEFAULT_ADMIN_ROLE();
      const minter = await token.MINTER_ROLE();

      await token.grantRole(defaultAdmin, alice.address);
      await token.renounceRole(defaultAdmin, admin.address);

      // The new admin can still administer roles; the old one cannot.
      await token.connect(alice).grantRole(minter, alice.address);
      await expect(token.grantRole(minter, admin.address)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("stops a revoked minter immediately", async () => {
      const { token, bridge, alice } = await deployUSDT();
      const minter = await token.MINTER_ROLE();
      const amount = ethers.parseUnits("1", 18);

      await token.grantRole(minter, bridge.address);
      await token.connect(bridge).mint(alice.address, amount);

      await token.revokeRole(minter, bridge.address);
      await expect(
        token.connect(bridge).mint(alice.address, amount),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");

      expect(await token.totalSupply()).to.equal(amount);
    });
  });

  describe("validation and boundaries", () => {
    it("rejects a rescue to the zero address", async () => {
      const { token, admin } = await deployUSDT();
      const stray = await ethers.deployContract("BridgeBNB", [admin.address], admin);

      await expect(
        token.rescueERC20(await stray.getAddress(), ZERO, 1n),
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });

    it("rescues its own token, which is the mistake people actually make", async () => {
      const { token, admin, alice } = await deployUSDT();
      const amount = ethers.parseUnits("5", 18);
      const tokenAddress = await token.getAddress();

      // Sending a token to its own address is the classic slip; the contract allows
      // recovering from it on purpose.
      await token.mint(alice.address, amount);
      await token.connect(alice).transfer(tokenAddress, amount);
      expect(await token.balanceOf(tokenAddress)).to.equal(amount);

      await expect(token.rescueERC20(tokenAddress, alice.address, amount))
        .to.emit(token, "TokensRescued")
        .withArgs(tokenAddress, alice.address, amount);

      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await token.balanceOf(tokenAddress)).to.equal(0n);
    });

    it("rejects minting to the zero address", async () => {
      const { token } = await deployUSDT();

      await expect(token.mint(ZERO, 1n))
        .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver")
        .withArgs(ZERO);
    });

    it("mints nothing at all when one recipient in a batch is invalid", async () => {
      const { token, alice } = await deployUSDT();
      const amount = ethers.parseUnits("1", 18);

      await expect(
        token.mintBatch([alice.address, ZERO], [amount, amount]),
      ).to.be.revertedWithCustomError(token, "ERC20InvalidReceiver");

      // The whole call reverted, so the first recipient got nothing either.
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("mints a zero amount without changing supply", async () => {
      const { token, admin, alice } = await deployUSDT();

      await expect(token.mint(alice.address, 0n))
        .to.emit(token, "BridgeMint")
        .withArgs(alice.address, 0n, admin.address);

      expect(await token.totalSupply()).to.equal(0n);
    });

    it("refuses a transfer larger than the balance", async () => {
      const { token, alice, bob } = await deployUSDT();
      const amount = ethers.parseUnits("10", 18);

      await token.mint(alice.address, amount);

      await expect(token.connect(alice).transfer(bob.address, amount + 1n))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(alice.address, amount, amount + 1n);
    });

    it("refuses an adminBurn larger than the balance", async () => {
      const { token, alice } = await deployUSDT();
      const amount = ethers.parseUnits("10", 18);

      await token.mint(alice.address, amount);

      await expect(token.adminBurn(alice.address, amount + 1n))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(alice.address, amount, amount + 1n);
    });

    it("carries supply up to the uint256 ceiling and refuses to pass it", async () => {
      const { token, alice } = await deployUSDT();
      const max = 2n ** 256n - 1n;

      await token.mint(alice.address, max);
      expect(await token.totalSupply()).to.equal(max);

      // OpenZeppelin's _update adds to _totalSupply in checked arithmetic, so the
      // overflow is an arithmetic panic rather than a silent wrap.
      await expect(token.mint(alice.address, 1n)).to.be.revertedWithPanic(0x11);
      expect(await token.totalSupply()).to.equal(max);
    });

    it("records the operator, not the subject, on mint and burn events", async () => {
      const { token, bridge, alice } = await deployUSDT();
      const minter = await token.MINTER_ROLE();
      const burner = await token.BURNER_ROLE();
      const amount = ethers.parseUnits("3", 18);

      await token.grantRole(minter, bridge.address);
      await token.grantRole(burner, bridge.address);

      await expect(token.connect(bridge).mint(alice.address, amount))
        .to.emit(token, "BridgeMint")
        .withArgs(alice.address, amount, bridge.address);

      await expect(token.connect(bridge).adminBurn(alice.address, amount))
        .to.emit(token, "BridgeBurn")
        .withArgs(alice.address, amount, bridge.address);
    });

    it("emits one BridgeMint per recipient in a batch", async () => {
      const { token, admin, alice, bob } = await deployUSDT();
      const amounts = [ethers.parseUnits("1", 18), ethers.parseUnits("2", 18)];

      await expect(token.mintBatch([alice.address, bob.address], amounts))
        .to.emit(token, "BridgeMint")
        .withArgs(alice.address, amounts[0], admin.address)
        .and.to.emit(token, "BridgeMint")
        .withArgs(bob.address, amounts[1], admin.address);

      expect(await token.totalSupply()).to.equal(amounts[0] + amounts[1]);
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
