import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

const URI = "https://baziche.example/api/nft/looks/{id}.json";

/** Arcade's own look ids, shaped `<kind>.<collection>`. */
const DICE = "dice.shiraz";
const BACK = "back.neon";
const THEME = "theme.gold";

/** The id the server computes off-chain for an item. */
const idOf = (item: string) => BigInt(ethers.id(item));

// Named module-scope fixtures: loadFixture keys its snapshot on the function reference.

/** Deployed with `admin` as owner, and `server` granted MINTER_ROLE separately. */
async function deploy() {
  const [admin, server, alice, bob] = await ethers.getSigners();
  const looks = await ethers.deployContract("ArcadeLooks", [admin.address, URI], admin);
  await looks.grantRole(await looks.MINTER_ROLE(), server.address);

  return { looks, admin, server, alice, bob };
}

/** Alice holds the dice. */
async function deployHeld() {
  const ctx = await deploy();
  await ctx.looks.connect(ctx.server).mint(ctx.alice.address, idOf(DICE));

  return ctx;
}

describe("ArcadeLooks", () => {
  describe("deployment", () => {
    it("makes the admin the owner and no minter, and serves the uri template", async () => {
      const { looks, admin } = await loadFixture(deploy);

      expect(await looks.hasRole(await looks.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await looks.hasRole(await looks.MINTER_ROLE(), admin.address), "the admin key need not mint").to.equal(false);
      expect(await looks.owner()).to.equal(admin.address);
      expect(await looks.uri(idOf(DICE))).to.equal(URI);
      expect(await looks.name()).to.equal("Baziche Looks");
      expect(await looks.symbol()).to.equal("BZLOOK");
    });

    it("reports ERC-1155 and AccessControl support", async () => {
      const { looks } = await loadFixture(deploy);

      expect(await looks.supportsInterface("0xd9b67a26")).to.equal(true); // IERC1155
      expect(await looks.supportsInterface("0x0e89341c")).to.equal(true); // IERC1155MetadataURI
      expect(await looks.supportsInterface("0x7965db0b")).to.equal(true); // IAccessControl
    });

    it("rejects a zero admin", async () => {
      const factory = await ethers.getContractFactory("ArcadeLooks");
      await expect(factory.deploy(ethers.ZeroAddress, URI)).to.be.revertedWithCustomError(factory, "AccessControlInvalidDefaultAdmin");
    });
  });

  describe("mint", () => {
    it("gives the owner one, and counts its holder", async () => {
      const { looks, server, alice } = await loadFixture(deploy);
      const id = idOf(DICE);

      await expect(looks.connect(server).mint(alice.address, id))
        .to.emit(looks, "TransferSingle")
        .withArgs(server.address, ethers.ZeroAddress, alice.address, id, 1n);

      expect(await looks.balanceOf(alice.address, id)).to.equal(1n);
      expect(await looks.holders(id)).to.equal(1n);
    });

    it("refuses a look the owner already holds, so a retry mints nothing twice", async () => {
      const { looks, server, alice } = await loadFixture(deployHeld);
      const id = idOf(DICE);

      await expect(looks.connect(server).mint(alice.address, id))
        .to.be.revertedWithCustomError(looks, "AlreadyHeld")
        .withArgs(alice.address, id);
      expect(await looks.holders(id)).to.equal(1n);
    });

    it("gives a look back once it was burned: a refunded look bought again", async () => {
      const { looks, server, alice } = await loadFixture(deployHeld);
      const id = idOf(DICE);

      await looks.connect(server).burn(alice.address, id);
      await looks.connect(server).mint(alice.address, id);

      expect(await looks.balanceOf(alice.address, id)).to.equal(1n);
      expect(await looks.holders(id)).to.equal(1n);
    });

    it("refuses a non-minter, the zero address, and a contract that takes no ERC-1155", async () => {
      const { looks, server, alice } = await loadFixture(deploy);
      const id = idOf(DICE);

      await expect(looks.connect(alice).mint(alice.address, id))
        .to.be.revertedWithCustomError(looks, "AccessControlUnauthorizedAccount");
      await expect(looks.connect(server).mint(ethers.ZeroAddress, id))
        .to.be.revertedWithCustomError(looks, "ZeroAddress");
      await expect(looks.connect(server).mint(await looks.getAddress(), id))
        .to.be.revertedWithCustomError(looks, "ERC1155InvalidReceiver");
    });
  });

  describe("mintBatch", () => {
    it("gives several looks in one transaction", async () => {
      const { looks, server, alice } = await loadFixture(deploy);
      const ids = [idOf(DICE), idOf(BACK), idOf(THEME)];

      await expect(looks.connect(server).mintBatch(alice.address, ids))
        .to.emit(looks, "TransferBatch")
        .withArgs(server.address, ethers.ZeroAddress, alice.address, ids, [1n, 1n, 1n]);

      expect(await looks.balanceOfBatch([alice.address, alice.address, alice.address], ids)).to.deep.equal([1n, 1n, 1n]);
    });

    it("refuses the whole batch when one look is already held, giving none of the rest", async () => {
      const { looks, server, alice } = await loadFixture(deployHeld);

      await expect(looks.connect(server).mintBatch(alice.address, [idOf(BACK), idOf(DICE)]))
        .to.be.revertedWithCustomError(looks, "AlreadyHeld")
        .withArgs(alice.address, idOf(DICE));
      expect(await looks.balanceOf(alice.address, idOf(BACK))).to.equal(0n);
    });

    it("refuses a batch naming one look twice, which would otherwise give two", async () => {
      const { looks, server, alice } = await loadFixture(deploy);

      await expect(looks.connect(server).mintBatch(alice.address, [idOf(DICE), idOf(BACK), idOf(DICE)]))
        .to.be.revertedWithCustomError(looks, "AlreadyHeld")
        .withArgs(alice.address, idOf(DICE));
      expect(await looks.balanceOf(alice.address, idOf(DICE))).to.equal(0n);
      expect(await looks.holders(idOf(DICE))).to.equal(0n);
    });

    it("refuses a non-minter", async () => {
      const { looks, alice } = await loadFixture(deploy);

      await expect(looks.connect(alice).mintBatch(alice.address, [idOf(DICE)]))
        .to.be.revertedWithCustomError(looks, "AccessControlUnauthorizedAccount");
    });
  });

  describe("burn", () => {
    it("takes a look back and uncounts its holder", async () => {
      const { looks, server, alice } = await loadFixture(deployHeld);
      const id = idOf(DICE);

      await expect(looks.connect(server).burn(alice.address, id))
        .to.emit(looks, "TransferSingle")
        .withArgs(server.address, alice.address, ethers.ZeroAddress, id, 1n);

      expect(await looks.balanceOf(alice.address, id)).to.equal(0n);
      expect(await looks.holders(id)).to.equal(0n);
    });

    it("refuses a look the owner does not hold, and a non-minter, the holder included", async () => {
      const { looks, server, alice, bob } = await loadFixture(deployHeld);
      const id = idOf(DICE);

      await expect(looks.connect(server).burn(bob.address, id))
        .to.be.revertedWithCustomError(looks, "NotHeld")
        .withArgs(bob.address, id);
      await expect(looks.connect(alice).burn(alice.address, id))
        .to.be.revertedWithCustomError(looks, "AccessControlUnauthorizedAccount");
    });
  });

  describe("transfers", () => {
    it("refuses every move between wallets, by the owner or anybody approved", async () => {
      const { looks, alice, bob } = await loadFixture(deployHeld);
      const id = idOf(DICE);

      await expect(looks.connect(alice).safeTransferFrom(alice.address, bob.address, id, 1n, "0x"))
        .to.be.revertedWithCustomError(looks, "Soulbound")
        .withArgs(id);

      await looks.connect(alice).setApprovalForAll(bob.address, true);
      await expect(looks.connect(bob).safeTransferFrom(alice.address, bob.address, id, 1n, "0x"))
        .to.be.revertedWithCustomError(looks, "Soulbound");
    });

    it("refuses a batched move", async () => {
      const { looks, server, alice, bob } = await loadFixture(deployHeld);
      await looks.connect(server).mint(alice.address, idOf(BACK));

      await expect(
        looks.connect(alice).safeBatchTransferFrom(alice.address, bob.address, [idOf(BACK), idOf(DICE)], [1n, 1n], "0x"),
      ).to.be.revertedWithCustomError(looks, "Soulbound");
    });
  });

  describe("setURI", () => {
    it("is the owner's alone", async () => {
      const { looks, server } = await loadFixture(deploy);
      const next = "https://cdn.example/looks/{id}.json";

      await expect(looks.connect(server).setURI(next))
        .to.be.revertedWithCustomError(looks, "AccessControlUnauthorizedAccount");

      await looks.setURI(next);
      expect(await looks.uri(0n)).to.equal(next);
    });
  });

  describe("ownership", () => {
    it("is handed on in two steps", async () => {
      const { looks, alice } = await loadFixture(deploy);

      await looks.beginDefaultAdminTransfer(alice.address);
      await looks.connect(alice).acceptDefaultAdminTransfer();

      expect(await looks.owner()).to.equal(alice.address);
    });
  });
});
