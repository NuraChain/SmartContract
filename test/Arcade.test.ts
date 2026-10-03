import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

const URI = "https://arcade.example/nft/achievements/{id}.json";

/** Arcade's own achievement ids, shaped `<game|all>-<family>-<step>`. */
const SOULBOUND_KEY = "all-won-1000";
const TRADEABLE_KEY = "ludo-captures-500";

/** A per-achievement metadata JSON on IPFS. */
const META = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/all-won-1000.json";

/** The id the backend computes off-chain for a key. */
const idOf = (key: string) => BigInt(ethers.id(key));

// Named module-scope fixtures: loadFixture keys its snapshot on the function reference.

/** Deployed with `admin` as admin and minter, and `backend` granted MINTER_ROLE separately. */
async function deploy() {
  const [admin, backend, alice, bob] = await ethers.getSigners();
  const achievements = await ethers.deployContract("ArcadeAchievements", [admin.address, URI], admin);
  await achievements.grantRole(await achievements.MINTER_ROLE(), backend.address);

  return { achievements, admin, backend, alice, bob };
}

/** One soulbound and one tradeable achievement, both awarded to alice. */
async function deployAwarded() {
  const ctx = await deploy();
  const minter = ctx.achievements.connect(ctx.backend);

  await minter.defineAchievement(SOULBOUND_KEY, true, META);
  await minter.defineAchievement(TRADEABLE_KEY, false, "");
  await minter.award(ctx.alice.address, idOf(SOULBOUND_KEY));
  await minter.award(ctx.alice.address, idOf(TRADEABLE_KEY));

  return ctx;
}

describe("ArcadeAchievements", () => {
  describe("deployment", () => {
    it("grants both roles to the admin and serves the uri template", async () => {
      const { achievements, admin } = await loadFixture(deploy);

      expect(await achievements.hasRole(await achievements.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await achievements.hasRole(await achievements.MINTER_ROLE(), admin.address)).to.equal(true);
      expect(await achievements.uri(idOf(SOULBOUND_KEY))).to.equal(URI);
      expect(await achievements.name()).to.equal("Nura Arcade Achievements");
      expect(await achievements.symbol()).to.equal("ARCADE");
    });

    it("reports ERC-1155 and AccessControl support", async () => {
      const { achievements } = await loadFixture(deploy);

      expect(await achievements.supportsInterface("0xd9b67a26")).to.equal(true); // IERC1155
      expect(await achievements.supportsInterface("0x7965db0b")).to.equal(true); // IAccessControl
    });

    it("rejects a zero admin", async () => {
      const factory = await ethers.getContractFactory("ArcadeAchievements");
      await expect(factory.deploy(ethers.ZeroAddress, URI)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("defineAchievement", () => {
    it("derives the id from the key, stores the rules and emits the key", async () => {
      const { achievements, backend } = await loadFixture(deploy);
      const id = idOf(SOULBOUND_KEY);

      await expect(achievements.connect(backend).defineAchievement(SOULBOUND_KEY, true, ""))
        .to.emit(achievements, "AchievementDefined")
        .withArgs(id, SOULBOUND_KEY, true);

      const [defined, soulbound, awarded] = await achievements.achievements(id);
      expect([defined, soulbound, awarded]).to.deep.equal([true, true, 0n]);
    });

    it("can be redefined until the first award, then locks", async () => {
      const { achievements, backend, alice } = await loadFixture(deploy);
      const minter = achievements.connect(backend);
      const id = idOf(TRADEABLE_KEY);

      await minter.defineAchievement(TRADEABLE_KEY, true, META);
      await minter.defineAchievement(TRADEABLE_KEY, false, "");
      expect((await achievements.achievements(id)).soulbound).to.equal(false);
      expect(await achievements.uri(id)).to.equal(URI);

      await minter.award(alice.address, id);
      await expect(minter.defineAchievement(TRADEABLE_KEY, true, ""))
        .to.be.revertedWithCustomError(achievements, "AchievementLocked")
        .withArgs(id);
    });

    it("rejects non-minters", async () => {
      const { achievements, alice } = await loadFixture(deploy);

      await expect(
        achievements.connect(alice).defineAchievement(SOULBOUND_KEY, true, ""),
      ).to.be.revertedWithCustomError(achievements, "AccessControlUnauthorizedAccount");
    });
  });

  describe("award", () => {
    it("mints one to the player and records it", async () => {
      const { achievements, backend, alice } = await loadFixture(deploy);
      const minter = achievements.connect(backend);
      const id = idOf(SOULBOUND_KEY);
      await minter.defineAchievement(SOULBOUND_KEY, true, "");

      await expect(minter.award(alice.address, id))
        .to.emit(achievements, "TransferSingle")
        .withArgs(backend.address, ethers.ZeroAddress, alice.address, id, 1n);

      expect(await achievements.balanceOf(alice.address, id)).to.equal(1n);
      expect(await achievements.earned(alice.address, id)).to.equal(true);
      expect((await achievements.achievements(id)).awarded).to.equal(1n);
    });

    it("rejects an undefined id, a repeat, and a non-minter", async () => {
      const { achievements, backend, alice } = await loadFixture(deployAwarded);
      const minter = achievements.connect(backend);
      const id = idOf(SOULBOUND_KEY);

      await expect(minter.award(alice.address, idOf("never-defined")))
        .to.be.revertedWithCustomError(achievements, "UnknownAchievement");
      await expect(minter.award(alice.address, id))
        .to.be.revertedWithCustomError(achievements, "AlreadyEarned")
        .withArgs(alice.address, id);
      await expect(achievements.connect(alice).award(alice.address, id))
        .to.be.revertedWithCustomError(achievements, "AccessControlUnauthorizedAccount");
    });

    it("rejects a contract recipient that is not an ERC-1155 receiver", async () => {
      const { achievements, backend } = await loadFixture(deployAwarded);

      await expect(
        achievements.connect(backend).award(await achievements.getAddress(), idOf(SOULBOUND_KEY)),
      ).to.be.revertedWithCustomError(achievements, "ERC1155InvalidReceiver");
    });

    it("does not re-award a tradeable one its earner sold on", async () => {
      const { achievements, backend, alice, bob } = await loadFixture(deployAwarded);
      const id = idOf(TRADEABLE_KEY);

      await achievements.connect(alice).safeTransferFrom(alice.address, bob.address, id, 1n, "0x");
      expect(await achievements.balanceOf(alice.address, id)).to.equal(0n);

      await expect(achievements.connect(backend).award(alice.address, id))
        .to.be.revertedWithCustomError(achievements, "AlreadyEarned");
    });
  });

  describe("transfers", () => {
    it("blocks moving a soulbound one", async () => {
      const { achievements, alice, bob } = await loadFixture(deployAwarded);
      const id = idOf(SOULBOUND_KEY);

      await expect(achievements.connect(alice).safeTransferFrom(alice.address, bob.address, id, 1n, "0x"))
        .to.be.revertedWithCustomError(achievements, "Soulbound")
        .withArgs(id);
    });

    it("blocks a batch that hides a soulbound id behind a tradeable one", async () => {
      const { achievements, alice, bob } = await loadFixture(deployAwarded);

      await expect(
        achievements
          .connect(alice)
          .safeBatchTransferFrom(alice.address, bob.address, [idOf(TRADEABLE_KEY), idOf(SOULBOUND_KEY)], [1n, 1n], "0x"),
      ).to.be.revertedWithCustomError(achievements, "Soulbound");
    });

    it("lets a tradeable one move", async () => {
      const { achievements, alice, bob } = await loadFixture(deployAwarded);
      const id = idOf(TRADEABLE_KEY);

      await achievements.connect(alice).safeTransferFrom(alice.address, bob.address, id, 1n, "0x");
      expect(await achievements.balanceOf(bob.address, id)).to.equal(1n);
    });
  });

  describe("metadata", () => {
    it("serves an achievement's own URI, and the template for one without", async () => {
      const { achievements } = await loadFixture(deployAwarded);

      expect(await achievements.uri(idOf(SOULBOUND_KEY))).to.equal(META);
      expect(await achievements.uri(idOf(TRADEABLE_KEY))).to.equal(URI);
    });

    it("emits URI on define and round-trips a fully on-chain data: document", async () => {
      const { achievements, backend } = await loadFixture(deploy);
      const json = { name: "Ludo Legend", image: "data:image/svg+xml;base64,PHN2Zy8+", attributes: [] };
      const inline = `data:application/json;base64,${Buffer.from(JSON.stringify(json)).toString("base64")}`;
      const id = idOf(TRADEABLE_KEY);

      await expect(achievements.connect(backend).defineAchievement(TRADEABLE_KEY, false, inline))
        .to.emit(achievements, "URI")
        .withArgs(inline, id);
      expect(await achievements.uri(id)).to.equal(inline);
    });

    it("lets the admin repoint or clear it after the first award, and nobody else", async () => {
      const { achievements, backend } = await loadFixture(deployAwarded);
      const id = idOf(SOULBOUND_KEY);
      const moved = "https://cdn.example/all-won-1000.json";

      await expect(achievements.connect(backend).setAchievementURI(id, moved))
        .to.be.revertedWithCustomError(achievements, "AccessControlUnauthorizedAccount");

      await expect(achievements.setAchievementURI(id, moved)).to.emit(achievements, "URI").withArgs(moved, id);
      expect(await achievements.uri(id)).to.equal(moved);

      await achievements.setAchievementURI(id, "");
      expect(await achievements.uri(id)).to.equal(URI);
    });

    it("rejects an undefined achievement", async () => {
      const { achievements } = await loadFixture(deploy);

      await expect(achievements.setAchievementURI(idOf("never-defined"), META))
        .to.be.revertedWithCustomError(achievements, "UnknownAchievement");
    });
  });

  describe("setURI", () => {
    it("is admin-only", async () => {
      const { achievements, backend } = await loadFixture(deploy);
      const next = "https://cdn.example/{id}.json";

      await expect(achievements.connect(backend).setURI(next))
        .to.be.revertedWithCustomError(achievements, "AccessControlUnauthorizedAccount");

      await achievements.setURI(next);
      expect(await achievements.uri(0n)).to.equal(next);
    });
  });
});
