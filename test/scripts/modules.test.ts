import { expect } from "chai";
import { network } from "hardhat";

import airdropModule from "../../ignition/modules/airdrop.ts";
import profileModule from "../../ignition/modules/profile.ts";
import tokenModule from "../../ignition/modules/token.ts";
import univ3Module from "../../ignition/modules/univ3.ts";
import vaultModule from "../../ignition/modules/vault.ts";

const { ethers, ignition } = await network.getOrCreate();

/**
 * Deployment smoke tests: every Ignition module is actually deployed to the in-process
 * chain and the result inspected.
 *
 * These are the only tests that exercise ignition/modules/**. Everything else in the suite
 * deploys contracts directly with `ethers.deployContract`, which means a module could name a
 * contract that no longer exists, pass constructor arguments in the wrong order, or lose a
 * parameter, and the whole suite would still be green — the mistake would surface on a real
 * network, after gas had been spent.
 *
 * @dev These deploy for real, so they are slower than the unit tests. Deliberately so: a
 *      module is a deployment plan, and the only honest way to test a plan is to run it.
 */

/**
 * Asserts a deployment rejects, and that it rejects for the stated reason.
 *
 * Written out rather than using chai-as-promised's `rejectedWith`: that matcher works at
 * runtime but is not in the chai types this repo loads, so `npm run typecheck` fails on it.
 */
async function expectDeployToFail(promise: Promise<unknown>, reason: RegExp) {
  let message: string | undefined;

  try {
    await promise;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message, "expected the deployment to be rejected, but it succeeded").to.not.equal(
    undefined,
  );
  expect(message).to.match(reason);
}

describe("ignition modules", () => {
  describe("token", () => {
    it("deploys both bridged tokens with the deployer as admin", async () => {
      const [deployer] = await ethers.getSigners();
      const { bridgeUSDT, bridgeBNB } = await ignition.deploy(tokenModule);

      expect(await bridgeUSDT.name()).to.equal("Bridge USDT");
      expect(await bridgeUSDT.symbol()).to.equal("USDT");
      expect(await bridgeUSDT.decimals()).to.equal(18n);

      expect(await bridgeBNB.name()).to.equal("Bridge BNB");
      expect(await bridgeBNB.symbol()).to.equal("BNB");
      expect(await bridgeBNB.decimals()).to.equal(18n);

      // Every role lands on one address, which is what the module's docs promise.
      for (const token of [bridgeUSDT, bridgeBNB]) {
        for (const role of [
          await token.DEFAULT_ADMIN_ROLE(),
          await token.MINTER_ROLE(),
          await token.BURNER_ROLE(),
          await token.PAUSER_ROLE(),
        ]) {
          expect(await token.hasRole(role, deployer.address)).to.equal(true);
        }
      }
    });

    it("routes the admin parameter through to the roles", async () => {
      const [, other] = await ethers.getSigners();
      const { bridgeUSDT } = await ignition.deploy(tokenModule, {
        parameters: { token: { admin: other.address } },
      });

      const adminRole = await bridgeUSDT.DEFAULT_ADMIN_ROLE();
      expect(await bridgeUSDT.hasRole(adminRole, other.address)).to.equal(true);
    });
  });

  describe("airdrop", () => {
    it("deploys with the cap and reward it is given", async () => {
      const [deployer, signer] = await ethers.getSigners();
      const maxClaims = 50_000n;
      const rewardAmount = 200n * 10n ** 18n;

      const { airdrop } = await ignition.deploy(airdropModule, {
        parameters: { airdrop: { maxClaims, rewardAmount, signer: signer.address } },
      });

      expect(await airdrop.maxClaims()).to.equal(maxClaims);
      expect(await airdrop.rewardAmount()).to.equal(rewardAmount);
      expect(await airdrop.hasRole(await airdrop.SIGNER_ROLE(), signer.address)).to.equal(true);
      expect(
        await airdrop.hasRole(await airdrop.DEFAULT_ADMIN_ROLE(), deployer.address),
      ).to.equal(true);

      // The module deploys but deliberately does not fund; the pool starts empty.
      expect(await ethers.provider.getBalance(await airdrop.getAddress())).to.equal(0n);
    });

    it("refuses to deploy without the cap and reward, rather than inventing them", async () => {
      // Both are immutable or money-shaped, so the module gives them no defaults. Going
      // straight through `ignition deploy` has to fail here instead of guessing. Asserting
      // on the message keeps this from passing on any unrelated error.
      await expectDeployToFail(ignition.deploy(airdropModule), /validation error/i);
    });
  });

  describe("univ3", () => {
    it("deploys the whole periphery pointing at one factory and one WNURA", async () => {
      const [deployer] = await ethers.getSigners();
      const wnura = await ethers.deployContract("WNURA", deployer);
      const wnuraAddress = await wnura.getAddress();

      const { factory, positionManager, swapRouter, quoter, tickLens, descriptor } =
        await ignition.deploy(univ3Module, {
          parameters: { univ3: { wnura: wnuraAddress } },
        });

      const factoryAddress = await factory.getAddress();

      expect(await positionManager.factory()).to.equal(factoryAddress);
      expect(await swapRouter.factory()).to.equal(factoryAddress);
      expect(await quoter.factory()).to.equal(factoryAddress);

      expect(await positionManager.WETH9()).to.equal(wnuraAddress);
      expect(await swapRouter.WETH9()).to.equal(wnuraAddress);

      expect(await factory.owner()).to.equal(deployer.address);
      expect(await tickLens.getAddress()).to.properAddress;
      expect(await descriptor.WETH9()).to.equal(wnuraAddress);
    });

    it("enables the canonical fee tiers and their tick spacings", async () => {
      const { factory } = await ignition.deploy(univ3Module);

      for (const [fee, spacing] of [
        [100n, 1n],
        [500n, 10n],
        [3000n, 60n],
        [10000n, 200n],
      ]) {
        expect(await factory.feeAmountTickSpacing(fee), `fee ${fee}`).to.equal(spacing);
      }
    });
  });

  describe("vault", () => {
    /** The vault module needs a token address; every case here supplies one. */
    async function backingToken() {
      const [deployer] = await ethers.getSigners();
      const token = await ethers.deployContract("BridgeUSDT", [deployer.address], deployer);

      return { token, address: await token.getAddress(), deployer };
    }

    it("deploys against the supplied token with the default 250e18 lock", async () => {
      const { address, deployer } = await backingToken();

      const { vault } = await ignition.deploy(vaultModule, {
        parameters: { vault: { token: address } },
      });

      expect(await vault.backingToken()).to.equal(address);
      expect(await vault.lockAmount()).to.equal(250n * 10n ** 18n);
      expect(await vault.name()).to.equal("Backed Position");
      expect(await vault.symbol()).to.equal("BPOS");

      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(true);
      expect(await vault.hasRole(await vault.MINTER_ROLE(), deployer.address)).to.equal(true);

      // Public minting starts off, and the module does not fund: no capacity yet.
      expect(await vault.publicMintEnabled()).to.equal(false);
      expect(await vault.tokenBalance()).to.equal(0n);
      expect(await vault.remainingMintCapacity()).to.equal(0n);
      expect(await vault.totalReserved()).to.equal(0n);
    });

    it("refuses to deploy without a token address, rather than picking one", async () => {
      // The address is immutable after construction and a wrong one can never pay anybody,
      // which is why the module gives it no default.
      await expectDeployToFail(ignition.deploy(vaultModule), /validation error/i);
    });

    it("carries every override through to the constructor", async () => {
      const { address } = await backingToken();
      const [, other] = await ethers.getSigners();
      const lockAmount = 500n * 10n ** 18n;

      const { vault } = await ignition.deploy(vaultModule, {
        parameters: {
          vault: {
            token: address,
            admin: other.address,
            lockAmount,
            name: "Custom Position",
            symbol: "CPOS",
            baseURI: "ipfs://bafy/",
          },
        },
      });

      expect(await vault.lockAmount()).to.equal(lockAmount);
      expect(await vault.name()).to.equal("Custom Position");
      expect(await vault.symbol()).to.equal("CPOS");
      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), other.address)).to.equal(true);
    });

    it("produces a vault that funds and mints, end to end from the module", async () => {
      const { token, address, deployer } = await backingToken();
      const { vault } = await ignition.deploy(vaultModule, {
        parameters: { vault: { token: address } },
      });

      // The flow README documents: deploy the module, then run scripts/vault-setup.ts.
      const reserve = 2_500_000n * 10n ** 18n;
      const vaultAddress = await vault.getAddress();

      await token.mint(deployer.address, reserve);
      await token.approve(vaultAddress, reserve);
      await vault.deposit(reserve);

      expect(await vault.remainingMintCapacity()).to.equal(10_000n);

      await vault.mint(deployer.address);
      expect(await vault.lockedAmount(1n)).to.equal(250n * 10n ** 18n);

      await vault.redeem(1n);
      expect(await vault.totalReserved()).to.equal(0n);
    });
  });

  describe("profile", () => {
    it("deploys implementation, initialized proxy, lens and verifier, all pointing at the proxy", async () => {
      const [deployer] = await ethers.getSigners();
      const { profile, implementation, proxy, lens, verifier } = await ignition.deploy(profileModule);

      const proxyAddress = await proxy.getAddress();
      expect(await profile.getAddress()).to.equal(proxyAddress);
      expect(await profile.owner()).to.equal(deployer.address);
      expect(await profile.VERSION()).to.equal("1.0.0");
      expect(await profile.profilesCreated()).to.equal(0n);

      // ERC-1967 implementation slot points at the bare implementation, which is locked.
      const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      const stored = await ethers.provider.getStorage(proxyAddress, implSlot);
      expect("0x" + stored.slice(-40)).to.equal((await implementation.getAddress()).toLowerCase());
      await expect(implementation.initialize(deployer.address)).to.be.revertedWithCustomError(
        implementation,
        "InvalidInitialization",
      );

      expect(await lens.core()).to.equal(proxyAddress);
      expect(await verifier.profileRegistry()).to.equal(proxyAddress);
      expect(await verifier.hasRole(await verifier.VERIFIER_ROLE(), deployer.address)).to.equal(true);
      expect(await verifier.hasRole(await verifier.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(true);

      // The module deliberately does not register the extension (owner action; see profile-setup.ts).
      expect(await profile.getExtension("social-verifier")).to.equal(ethers.ZeroAddress);
    });

    it("routes owner, verifierAdmin and verifierSigner through, and the result works end to end", async () => {
      const [deployer, owner, verifierAdmin, signer] = await ethers.getSigners();
      const { profile, lens, verifier } = await ignition.deploy(profileModule, {
        parameters: {
          profile: { owner: owner.address, verifierAdmin: verifierAdmin.address, verifierSigner: signer.address },
        },
      });

      expect(await profile.owner()).to.equal(owner.address);
      expect(await verifier.hasRole(await verifier.DEFAULT_ADMIN_ROLE(), verifierAdmin.address)).to.equal(true);
      expect(await verifier.hasRole(await verifier.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
      expect(await verifier.hasRole(await verifier.VERIFIER_ROLE(), signer.address)).to.equal(true);

      // The owner registers the verifier (what scripts/profile-setup.ts does), a user opts in and gets verified.
      // Ignition hands back BaseContracts; re-attach the typed ABIs to use them from other signers.
      const core = await ethers.getContractAt("NuraProfile", await profile.getAddress(), owner);
      const verifierAs = await ethers.getContractAt("SocialVerifier", await verifier.getAddress(), deployer);
      await core.registerExtension("social-verifier", await verifier.getAddress());
      await core.connect(deployer).createProfile("deployer", "Deployer", "", "");
      await core.connect(deployer).approveExtension(1n, "social-verifier", true);

      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
      const sig = await signer.signTypedData(
        {
          name: "NuraSocialVerifier",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await verifier.getAddress(),
        },
        {
          VerifyHandle: [
            { name: "profileId", type: "uint256" },
            { name: "platform", type: "string" },
            { name: "handle", type: "string" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { profileId: 1n, platform: "github", handle: "nura-deployer", nonce: 0n, deadline },
      );
      await verifierAs.verifyHandle(1n, "github", "nura-deployer", deadline, sig);

      expect(await verifier.verifiedHandle(1n, "github")).to.equal("nura-deployer");
      expect((await lens.getProfile(deployer.address, "")).displayName).to.equal("Deployer");
    });
  });
});
