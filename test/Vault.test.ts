import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/** The reserve the deployment funds: 2,500,000 tokens at 18 decimals. */
const RESERVE = ethers.parseEther("2500000");

/** Default reservation per NFT: 250 tokens. 2,500,000 / 250 = 10,000 backed NFTs. */
const LOCK = ethers.parseEther("250");

const NAME = "Backed Position";
const SYMBOL = "BPOS";
const BASE_URI = "https://meta.example/vault/";

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow re-runs the setup instead of reverting to a
// snapshot. That matters here because the funded fixture moves 2,500,000 tokens per run.

/** Deploys the real contracts/token BridgeUSDT as the backing token, plus an unfunded vault. */
async function deployUnfunded() {
  const [admin, alice, bob, carol] = await ethers.getSigners();

  const token = await ethers.deployContract("BridgeUSDT", [admin.address], admin);
  const vault = await ethers.deployContract(
    "CollateralizedNFT",
    [admin.address, await token.getAddress(), LOCK, NAME, SYMBOL, BASE_URI],
    admin,
  );

  await token.mint(admin.address, RESERVE);

  return { token, vault, admin, alice, bob, carol };
}

/** The intended production state: 2,500,000 tokens deposited, nothing minted yet. */
async function deployFunded() {
  const ctx = await deployUnfunded();

  await ctx.token.approve(await ctx.vault.getAddress(), RESERVE);
  await ctx.vault.deposit(RESERVE);

  return ctx;
}

/** Funded for exactly four NFTs, so the reserve can be driven to empty cheaply. */
async function deployTinyReserve() {
  const ctx = await deployUnfunded();
  const amount = LOCK * 4n;

  await ctx.token.approve(await ctx.vault.getAddress(), amount);
  await ctx.vault.deposit(amount);

  return { ...ctx, funded: amount };
}

/** Funded, with minting open to everyone rather than gated behind MINTER_ROLE. */
async function deployPublic() {
  const ctx = await deployFunded();
  await ctx.vault.setPublicMintEnabled(true);

  return ctx;
}

/** Asserts the two solvency invariants the contract is built around. */
async function expectSolvent(
  vault: { totalReserved(): Promise<bigint>; tokenBalance(): Promise<bigint> },
  outstandingIds: bigint[],
  lockedOf: (id: bigint) => Promise<bigint>,
) {
  const reserved = await vault.totalReserved();
  const balance = await vault.tokenBalance();

  let sum = 0n;
  for (const id of outstandingIds) {
    sum += await lockedOf(id);
  }

  expect(reserved).to.equal(sum, "totalReserved drifted from the sum of outstanding locks");
  expect(reserved).to.be.lessThanOrEqual(balance, "reserved more than the contract holds");
}

describe("CollateralizedNFT", () => {
  describe("deployment", () => {
    it("stores the token, lock amount, metadata and roles", async () => {
      const { vault, token, admin } = await loadFixture(deployUnfunded);

      expect(await vault.backingToken()).to.equal(await token.getAddress());
      expect(await vault.lockAmount()).to.equal(LOCK);
      expect(await vault.name()).to.equal(NAME);
      expect(await vault.symbol()).to.equal(SYMBOL);
      expect(await vault.publicMintEnabled()).to.equal(false);
      expect(await vault.totalReserved()).to.equal(0n);
      expect(await vault.totalMinted()).to.equal(0n);
      expect(await vault.totalRedeemed()).to.equal(0n);

      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await vault.hasRole(await vault.MINTER_ROLE(), admin.address)).to.equal(true);
    });

    it("rejects a zero admin, a zero token and a zero lock amount", async () => {
      const { token, admin } = await loadFixture(deployUnfunded);
      const factory = await ethers.getContractFactory("CollateralizedNFT");
      const tokenAddress = await token.getAddress();

      await expect(
        factory.deploy(ethers.ZeroAddress, tokenAddress, LOCK, NAME, SYMBOL, BASE_URI),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        factory.deploy(admin.address, ethers.ZeroAddress, LOCK, NAME, SYMBOL, BASE_URI),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        factory.deploy(admin.address, tokenAddress, 0n, NAME, SYMBOL, BASE_URI),
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");
    });

    it("advertises ERC721, ERC721Metadata and AccessControl", async () => {
      const { vault } = await loadFixture(deployUnfunded);

      expect(await vault.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
      expect(await vault.supportsInterface("0x5b5e139f")).to.equal(true); // ERC721Metadata
      expect(await vault.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
      expect(await vault.supportsInterface("0x780e9d63")).to.equal(false); // not Enumerable
    });

    it("has no capacity before it is funded", async () => {
      const { vault } = await loadFixture(deployUnfunded);

      expect(await vault.tokenBalance()).to.equal(0n);
      expect(await vault.availableBacking()).to.equal(0n);
      expect(await vault.remainingMintCapacity()).to.equal(0n);
    });
  });

  describe("funding", () => {
    it("takes the 2,500,000 token reserve and reports 10,000 of capacity", async () => {
      const { vault, token, admin } = await loadFixture(deployUnfunded);
      const vaultAddress = await vault.getAddress();

      await token.approve(vaultAddress, RESERVE);

      await expect(vault.deposit(RESERVE))
        .to.emit(vault, "Deposited")
        .withArgs(admin.address, RESERVE, RESERVE);

      expect(await vault.tokenBalance()).to.equal(RESERVE);
      expect(await vault.availableBacking()).to.equal(RESERVE);
      expect(await vault.remainingMintCapacity()).to.equal(10_000n);
      expect(await token.balanceOf(vaultAddress)).to.equal(RESERVE);
    });

    it("rejects a zero deposit", async () => {
      const { vault } = await loadFixture(deployUnfunded);

      await expect(vault.deposit(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("accepts a deposit from anyone, since a plain transfer would do the same", async () => {
      const { vault, token, admin, alice } = await loadFixture(deployUnfunded);
      const vaultAddress = await vault.getAddress();

      await token.transfer(alice.address, LOCK);
      await token.connect(alice).approve(vaultAddress, LOCK);

      await expect(vault.connect(alice).deposit(LOCK))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, LOCK, LOCK);
    });

    it("counts a raw transfer as backing too", async () => {
      const { vault, token } = await loadFixture(deployUnfunded);

      await token.transfer(await vault.getAddress(), LOCK * 3n);

      expect(await vault.availableBacking()).to.equal(LOCK * 3n);
      expect(await vault.remainingMintCapacity()).to.equal(3n);
    });

    it("reverts the deposit when the token has no allowance", async () => {
      const { vault, token } = await loadFixture(deployUnfunded);

      await expect(vault.deposit(LOCK)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientAllowance",
      );
    });
  });

  describe("minting", () => {
    it("mints NFT #1 to the recipient and reserves the lock amount", async () => {
      const { vault, alice, admin } = await loadFixture(deployFunded);

      await expect(vault.mint(alice.address))
        .to.emit(vault, "NFTMinted")
        .withArgs(alice.address, 1n, LOCK)
        .and.to.emit(vault, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, 1n);

      expect(await vault.ownerOf(1n)).to.equal(alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(1n);
      expect(await vault.lockedAmount(1n)).to.equal(LOCK);
      expect(await vault.totalReserved()).to.equal(LOCK);
      expect(await vault.totalMinted()).to.equal(1n);
      expect(await vault.totalSupply()).to.equal(1n);
      expect(await vault.availableBacking()).to.equal(RESERVE - LOCK);
      expect(await vault.remainingMintCapacity()).to.equal(9_999n);

      // The reserve is booked, not moved: the tokens never leave until redemption.
      expect(await vault.tokenBalance()).to.equal(RESERVE);
      expect(admin).to.not.equal(undefined);
    });

    it("returns the new token id to a contract caller", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      expect(await vault.mint.staticCall(alice.address)).to.equal(1n);
    });

    it("hands out sequential ids starting at 1", async () => {
      const { vault, alice, bob, carol } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.mint(bob.address);
      await vault.mint(carol.address);

      expect(await vault.ownerOf(1n)).to.equal(alice.address);
      expect(await vault.ownerOf(2n)).to.equal(bob.address);
      expect(await vault.ownerOf(3n)).to.equal(carol.address);
      expect(await vault.totalReserved()).to.equal(LOCK * 3n);
      expect(await vault.remainingMintCapacity()).to.equal(9_997n);
    });

    it("rejects the zero address", async () => {
      const { vault } = await loadFixture(deployFunded);

      await expect(vault.mint(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
    });

    it("refuses a non-minter while public minting is off", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.connect(alice).mint(alice.address))
        .to.be.revertedWithCustomError(vault, "MintNotPermitted")
        .withArgs(alice.address);
    });

    it("lets anyone mint once public minting is on", async () => {
      const { vault, alice } = await loadFixture(deployPublic);

      await expect(vault.connect(alice).mint(alice.address)).to.emit(vault, "NFTMinted");
      expect(await vault.ownerOf(1n)).to.equal(alice.address);
    });

    it("lets a granted minter mint without being an admin", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.grantRole(await vault.MINTER_ROLE(), alice.address);
      await vault.connect(alice).mint(bob.address);

      expect(await vault.ownerOf(1n)).to.equal(bob.address);
      await expect(
        vault.connect(alice).setLockAmount(LOCK),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("stops at the last backed NFT and reverts on the one after", async () => {
      const { vault, alice, funded } = await loadFixture(deployTinyReserve);

      for (let i = 0; i < 4; i++) {
        await vault.mint(alice.address);
      }

      expect(await vault.totalReserved()).to.equal(funded);
      expect(await vault.availableBacking()).to.equal(0n);
      expect(await vault.remainingMintCapacity()).to.equal(0n);

      await expect(vault.mint(alice.address))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(0n, LOCK);
    });

    it("reverts when the reserve is short of a full lock", async () => {
      // Balance 1000, reserved 750, lock 250: exactly one more NFT, then nothing.
      const { vault, token, alice } = await loadFixture(deployUnfunded);
      const vaultAddress = await vault.getAddress();

      await token.approve(vaultAddress, LOCK * 4n);
      await vault.deposit(LOCK * 3n);
      for (let i = 0; i < 3; i++) {
        await vault.mint(alice.address);
      }

      await vault.deposit(LOCK);
      expect(await vault.remainingMintCapacity()).to.equal(1n);

      await vault.mint(alice.address);
      await expect(vault.mint(alice.address))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(0n, LOCK);
    });

    it("reverts rather than minting an NFT the reserve only partly covers", async () => {
      const { vault, token, alice } = await loadFixture(deployUnfunded);

      await token.transfer(await vault.getAddress(), LOCK - 1n);

      expect(await vault.remainingMintCapacity()).to.equal(0n);
      await expect(vault.mint(alice.address))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(LOCK - 1n, LOCK);
    });

    it("mints to a contract that implements onERC721Received", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      const receiver = await ethers.deployContract("MockReentrantReceiver", [
        await vault.getAddress(),
      ]);
      const receiverAddress = await receiver.getAddress();

      await vault.mint(receiverAddress);

      expect(await vault.ownerOf(1n)).to.equal(receiverAddress);
      expect(alice).to.not.equal(undefined);
    });

    it("refuses to strand an NFT in a contract that cannot receive one", async () => {
      const { vault, token } = await loadFixture(deployFunded);

      // BridgeUSDT has no onERC721Received, so _safeMint rejects it.
      await expect(vault.mint(await token.getAddress()))
        .to.be.revertedWithCustomError(vault, "ERC721InvalidReceiver")
        .withArgs(await token.getAddress());
    });
  });

  describe("batch minting", () => {
    it("mints a batch and reserves quantity * lockAmount", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.mintBatch(alice.address, 5n))
        .to.emit(vault, "NFTMinted")
        .withArgs(alice.address, 1n, LOCK)
        .and.to.emit(vault, "NFTMinted")
        .withArgs(alice.address, 5n, LOCK);

      expect(await vault.balanceOf(alice.address)).to.equal(5n);
      expect(await vault.totalMinted()).to.equal(5n);
      expect(await vault.totalReserved()).to.equal(LOCK * 5n);
      expect(await vault.remainingMintCapacity()).to.equal(9_995n);

      for (let id = 1n; id <= 5n; id++) {
        expect(await vault.ownerOf(id)).to.equal(alice.address);
        expect(await vault.lockedAmount(id)).to.equal(LOCK);
      }
    });

    it("returns the first id of the batch", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      expect(await vault.mintBatch.staticCall(alice.address, 3n)).to.equal(2n);
    });

    it("continues the id sequence after single mints", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.mintBatch(bob.address, 2n);
      await vault.mint(alice.address);

      expect(await vault.ownerOf(1n)).to.equal(alice.address);
      expect(await vault.ownerOf(2n)).to.equal(bob.address);
      expect(await vault.ownerOf(3n)).to.equal(bob.address);
      expect(await vault.ownerOf(4n)).to.equal(alice.address);
    });

    it("rejects a zero quantity and the zero address", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.mintBatch(alice.address, 0n)).to.be.revertedWithCustomError(
        vault,
        "ZeroQuantity",
      );
      await expect(vault.mintBatch(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
    });

    it("mints nothing at all when the batch is one NFT too large", async () => {
      const { vault, alice, funded } = await loadFixture(deployTinyReserve);

      await expect(vault.mintBatch(alice.address, 5n))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(funded, LOCK * 5n);

      expect(await vault.totalMinted()).to.equal(0n);
      expect(await vault.totalReserved()).to.equal(0n);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
    });

    it("fills the reserve exactly with a full batch", async () => {
      const { vault, alice, funded } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 4n);

      expect(await vault.totalReserved()).to.equal(funded);
      expect(await vault.remainingMintCapacity()).to.equal(0n);
    });

    it("reverts on a quantity that would overflow the reservation", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      // lockAmount * quantity overflows uint256 well before any backing check could pass.
      const huge = 2n ** 250n;
      await expect(vault.mintBatch(alice.address, huge)).to.be.revertedWithPanic(0x11);
    });

    it("reverts on a large but non-overflowing quantity through the backing check", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.mintBatch(alice.address, 10_001n))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(RESERVE, LOCK * 10_001n);
    });
  });

  describe("redemption", () => {
    it("burns the NFT and pays the owner exactly what was locked", async () => {
      const { vault, token, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.connect(alice).redeem(1n)).to.changeTokenBalances(
        ethers,
        token,
        [alice, vault],
        [LOCK, -LOCK],
      );

      expect(await vault.totalReserved()).to.equal(0n);
      expect(await vault.totalRedeemed()).to.equal(1n);
      expect(await vault.totalSupply()).to.equal(0n);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.tokenBalance()).to.equal(RESERVE - LOCK);
    });

    it("emits NFTRedeemed with the id, owner and amount", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.connect(alice).redeem(1n))
        .to.emit(vault, "NFTRedeemed")
        .withArgs(alice.address, 1n, LOCK)
        .and.to.emit(vault, "Transfer")
        .withArgs(alice.address, ethers.ZeroAddress, 1n);
    });

    it("actually burns the NFT", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.connect(alice).redeem(1n);

      await expect(vault.ownerOf(1n))
        .to.be.revertedWithCustomError(vault, "ERC721NonexistentToken")
        .withArgs(1n);
    });

    it("frees capacity back up", async () => {
      const { vault, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 4n);
      expect(await vault.remainingMintCapacity()).to.equal(0n);

      await vault.connect(alice).redeem(2n);
      expect(await vault.remainingMintCapacity()).to.equal(0n);

      // The refund left the contract, so the freed reservation is not re-mintable —
      // the tokens went to Alice, not back into the unreserved pool.
      expect(await vault.tokenBalance()).to.equal(LOCK * 3n);
      expect(await vault.totalReserved()).to.equal(LOCK * 3n);
      expect(await vault.availableBacking()).to.equal(0n);
    });

    it("rejects a second redemption of the same NFT", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.connect(alice).redeem(1n);

      await expect(vault.connect(alice).redeem(1n))
        .to.be.revertedWithCustomError(vault, "ERC721NonexistentToken")
        .withArgs(1n);
    });

    it("rejects a non-owner", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.connect(bob).redeem(1n))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner")
        .withArgs(1n, alice.address, bob.address);
    });

    it("rejects the admin, who owns nothing", async () => {
      const { vault, alice, admin } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.redeem(1n))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner")
        .withArgs(1n, alice.address, admin.address);
    });

    it("rejects an approved operator, so approval is not a licence to cash out", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.connect(alice).approve(bob.address, 1n);
      await vault.connect(alice).setApprovalForAll(bob.address, true);

      await expect(vault.connect(bob).redeem(1n))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner")
        .withArgs(1n, alice.address, bob.address);
    });

    it("rejects an id that was never minted", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.connect(alice).redeem(0n))
        .to.be.revertedWithCustomError(vault, "ERC721NonexistentToken")
        .withArgs(0n);
      await expect(vault.connect(alice).redeem(999n))
        .to.be.revertedWithCustomError(vault, "ERC721NonexistentToken")
        .withArgs(999n);
    });

    it("pays whoever holds the NFT at redemption time, not the original minter", async () => {
      const { vault, token, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.connect(alice).transferFrom(alice.address, bob.address, 1n);

      await expect(vault.connect(bob).redeem(1n)).to.changeTokenBalances(
        ethers,
        token,
        [bob, alice, vault],
        [LOCK, 0n, -LOCK],
      );

      await expect(vault.connect(alice).redeem(1n)).to.be.revertedWithCustomError(
        vault,
        "ERC721NonexistentToken",
      );
    });

    it("carries the original lock across a transfer", async () => {
      const { vault, token, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.setLockAmount(LOCK * 2n);
      await vault.connect(alice).transferFrom(alice.address, bob.address, 1n);

      expect(await vault.lockedAmount(1n)).to.equal(LOCK);
      await expect(vault.connect(bob).redeem(1n)).to.changeTokenBalance(ethers, token, bob, LOCK);
    });

    it("treats burn as an alias for redeem, refund included", async () => {
      const { vault, token, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      // Two async matchers cannot share one chain, so the tx is captured and asserted twice.
      const tx = await vault.connect(alice).burn(1n);

      await expect(tx).to.emit(vault, "NFTRedeemed").withArgs(alice.address, 1n, LOCK);
      await expect(tx).to.changeTokenBalance(ethers, token, alice, LOCK);

      expect(await vault.totalReserved()).to.equal(0n);
    });

    it("applies the same owner check to burn", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(vault.connect(bob).burn(1n))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner")
        .withArgs(1n, alice.address, bob.address);
    });
  });

  describe("lock amount configuration", () => {
    it("changes what future NFTs reserve and leaves existing ones alone", async () => {
      const { vault, token, alice } = await loadFixture(deployFunded);
      const doubled = LOCK * 2n;

      await vault.mint(alice.address);
      await vault.mint(alice.address);

      await expect(vault.setLockAmount(doubled))
        .to.emit(vault, "LockAmountUpdated")
        .withArgs(LOCK, doubled);

      await vault.mint(alice.address);
      await vault.mint(alice.address);

      expect(await vault.lockedAmount(1n)).to.equal(LOCK);
      expect(await vault.lockedAmount(2n)).to.equal(LOCK);
      expect(await vault.lockedAmount(3n)).to.equal(doubled);
      expect(await vault.lockedAmount(4n)).to.equal(doubled);
      expect(await vault.totalReserved()).to.equal(LOCK * 2n + doubled * 2n);

      // NFT #1 and #2 still redeem for 250 each; #3 and #4 for 500.
      await expect(vault.connect(alice).redeem(1n)).to.changeTokenBalance(ethers, token, alice, LOCK);
      await expect(vault.connect(alice).redeem(3n)).to.changeTokenBalance(ethers, token, alice, doubled);
    });

    it("recomputes capacity against the new amount", async () => {
      const { vault } = await loadFixture(deployFunded);

      expect(await vault.remainingMintCapacity()).to.equal(10_000n);

      await vault.setLockAmount(LOCK * 2n);
      expect(await vault.remainingMintCapacity()).to.equal(5_000n);

      await vault.setLockAmount(ethers.parseEther("1000"));
      expect(await vault.remainingMintCapacity()).to.equal(2_500n);
    });

    it("lets a lowered amount stretch the remaining reserve further", async () => {
      const { vault, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 4n);
      await expect(vault.mint(alice.address)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBacking",
      );

      // Halving the lock does not free reserved collateral, so it still cannot mint.
      await vault.setLockAmount(LOCK / 2n);
      await expect(vault.mint(alice.address)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBacking",
      );
    });

    it("rejects zero and non-admins", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.setLockAmount(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(
        vault.connect(alice).setLockAmount(LOCK),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("metadata", () => {
    it("appends the token id to the base URI", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mintBatch(alice.address, 2n);

      expect(await vault.tokenURI(1n)).to.equal(`${BASE_URI}1`);
      expect(await vault.tokenURI(2n)).to.equal(`${BASE_URI}2`);
    });

    it("reverts tokenURI for an id that does not exist", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.tokenURI(1n))
        .to.be.revertedWithCustomError(vault, "ERC721NonexistentToken")
        .withArgs(1n);

      await vault.mint(alice.address);
      await vault.connect(alice).redeem(1n);

      await expect(vault.tokenURI(1n)).to.be.revertedWithCustomError(
        vault,
        "ERC721NonexistentToken",
      );
    });

    it("lets the admin change the base URI", async () => {
      const { vault, alice } = await loadFixture(deployFunded);
      const updated = "ipfs://bafy/";

      await vault.mint(alice.address);

      await expect(vault.setBaseURI(updated)).to.emit(vault, "BaseURIUpdated").withArgs(updated);
      expect(await vault.tokenURI(1n)).to.equal(`${updated}1`);
    });

    it("returns an empty tokenURI when the base URI is cleared", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.setBaseURI("");

      expect(await vault.tokenURI(1n)).to.equal("");
    });

    it("refuses a non-admin", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(
        vault.connect(alice).setBaseURI("ipfs://nope/"),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("admin withdrawal", () => {
    it("cannot touch collateral reserved for outstanding NFTs", async () => {
      const { vault, admin, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 4n);
      expect(await vault.availableBacking()).to.equal(0n);

      await expect(vault.withdrawExcessTokens(admin.address, 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(0n, 1n);
    });

    it("withdraws only the unreserved part", async () => {
      const { vault, token, admin, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 3n);
      const excess = LOCK; // one NFT worth is still unreserved

      const tx = await vault.withdrawExcessTokens(admin.address, excess);

      await expect(tx).to.emit(vault, "ExcessTokensWithdrawn").withArgs(admin.address, excess);
      await expect(tx).to.changeTokenBalances(ethers, token, [admin, vault], [excess, -excess]);

      expect(await vault.availableBacking()).to.equal(0n);
      expect(await vault.tokenBalance()).to.equal(LOCK * 3n);
      expect(await vault.totalReserved()).to.equal(LOCK * 3n);
    });

    it("rejects one wei more than the unreserved balance", async () => {
      const { vault, admin, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 3n);

      await expect(vault.withdrawExcessTokens(admin.address, LOCK + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(LOCK, LOCK + 1n);
    });

    it("leaves every outstanding NFT redeemable after a full excess sweep", async () => {
      const { vault, token, admin, alice } = await loadFixture(deployFunded);

      await vault.mintBatch(alice.address, 10n);
      await vault.withdrawExcessTokens(admin.address, await vault.availableBacking());

      expect(await vault.tokenBalance()).to.equal(LOCK * 10n);

      for (let id = 1n; id <= 10n; id++) {
        await expect(vault.connect(alice).redeem(id)).to.changeTokenBalance(ethers, token, alice, LOCK);
      }

      expect(await vault.tokenBalance()).to.equal(0n);
      expect(await vault.totalReserved()).to.equal(0n);
    });

    it("rejects zero address, zero amount and non-admins", async () => {
      const { vault, admin, alice } = await loadFixture(deployFunded);

      await expect(
        vault.withdrawExcessTokens(ethers.ZeroAddress, LOCK),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.withdrawExcessTokens(admin.address, 0n)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount",
      );
      await expect(
        vault.connect(alice).withdrawExcessTokens(alice.address, LOCK),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("refuses to route the backing token through rescueERC20", async () => {
      const { vault, token, admin } = await loadFixture(deployFunded);

      await expect(
        vault.rescueERC20(await token.getAddress(), admin.address, LOCK),
      ).to.be.revertedWithCustomError(vault, "BackingTokenNotRescuable");
    });

    it("sweeps an unrelated token that was sent here by mistake", async () => {
      const { vault, admin } = await loadFixture(deployFunded);

      const stray = await ethers.deployContract("MockConfigurableERC20", []);
      await stray.mint(await vault.getAddress(), 1_000n);

      await expect(vault.rescueERC20(await stray.getAddress(), admin.address, 1_000n))
        .to.emit(vault, "TokensRescued")
        .withArgs(await stray.getAddress(), admin.address, 1_000n);

      expect(await stray.balanceOf(admin.address)).to.equal(1_000n);
    });
  });

  describe("public mint toggle", () => {
    it("emits on both edges and gates minting accordingly", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(vault.setPublicMintEnabled(true))
        .to.emit(vault, "PublicMintUpdated")
        .withArgs(true);
      await vault.connect(alice).mint(alice.address);

      await expect(vault.setPublicMintEnabled(false))
        .to.emit(vault, "PublicMintUpdated")
        .withArgs(false);
      await expect(vault.connect(alice).mint(alice.address)).to.be.revertedWithCustomError(
        vault,
        "MintNotPermitted",
      );
    });

    it("refuses a non-admin", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await expect(
        vault.connect(alice).setPublicMintEnabled(true),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("closing minting still leaves outstanding NFTs redeemable", async () => {
      const { vault, token, admin, alice } = await loadFixture(deployPublic);

      await vault.connect(alice).mint(alice.address);
      await vault.setPublicMintEnabled(false);
      await vault.revokeRole(await vault.MINTER_ROLE(), admin.address);

      await expect(vault.connect(alice).mint(alice.address)).to.be.revertedWithCustomError(
        vault,
        "MintNotPermitted",
      );
      await expect(vault.connect(alice).redeem(1n)).to.changeTokenBalance(ethers, token, alice, LOCK);
    });
  });

  describe("reentrancy", () => {
    it("blocks a mint re-entered from onERC721Received", async () => {
      const { vault } = await loadFixture(deployFunded);

      const receiver = await ethers.deployContract("MockReentrantReceiver", [
        await vault.getAddress(),
      ]);
      await receiver.armMint();

      await expect(vault.mint(await receiver.getAddress())).to.be.revertedWithCustomError(
        vault,
        "ReentrancyGuardReentrantCall",
      );

      expect(await vault.totalMinted()).to.equal(0n);
      expect(await vault.totalReserved()).to.equal(0n);
    });

    it("blocks a redeem re-entered from onERC721Received", async () => {
      const { vault } = await loadFixture(deployFunded);

      const receiver = await ethers.deployContract("MockReentrantReceiver", [
        await vault.getAddress(),
      ]);
      const receiverAddress = await receiver.getAddress();

      await vault.mint(receiverAddress);
      await receiver.armRedeem(1n);

      await expect(vault.mint(receiverAddress)).to.be.revertedWithCustomError(
        vault,
        "ReentrancyGuardReentrantCall",
      );

      // The first NFT is untouched and still fully backed.
      expect(await vault.ownerOf(1n)).to.equal(receiverAddress);
      expect(await vault.totalReserved()).to.equal(LOCK);
    });

    it("blocks a redeem re-entered from the backing token transfer hook", async () => {
      const { admin, alice } = await loadFixture(deployUnfunded);

      const token = await ethers.deployContract("MockReentrantERC20", []);
      const vault = await ethers.deployContract(
        "CollateralizedNFT",
        [admin.address, await token.getAddress(), LOCK, NAME, SYMBOL, BASE_URI],
        admin,
      );

      await token.mint(await vault.getAddress(), LOCK * 4n);
      await vault.mintBatch(alice.address, 2n);

      // Paying out #1 makes the token call back into redeem(#2) mid-transfer.
      await token.arm(await vault.getAddress(), 2n);

      await expect(vault.connect(alice).redeem(1n)).to.be.revertedWithCustomError(
        vault,
        "ReentrancyGuardReentrantCall",
      );

      // Nothing was paid out and both NFTs survive.
      expect(await vault.totalReserved()).to.equal(LOCK * 2n);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.ownerOf(1n)).to.equal(alice.address);
      expect(await vault.ownerOf(2n)).to.equal(alice.address);
    });
  });

  describe("ERC20 edge cases", () => {
    it("reverts the redemption when the token returns false instead of transferring", async () => {
      const { admin, alice } = await loadFixture(deployUnfunded);

      const token = await ethers.deployContract("MockConfigurableERC20", []);
      const vault = await ethers.deployContract(
        "CollateralizedNFT",
        [admin.address, await token.getAddress(), LOCK, NAME, SYMBOL, BASE_URI],
        admin,
      );

      await token.mint(await vault.getAddress(), LOCK * 2n);
      await vault.mint(alice.address);

      await token.setFailTransfers(true);
      await expect(vault.connect(alice).redeem(1n)).to.be.revertedWithCustomError(
        vault,
        "SafeERC20FailedOperation",
      );

      // The whole call reverted, so the NFT and its reservation are intact.
      expect(await vault.ownerOf(1n)).to.equal(alice.address);
      expect(await vault.lockedAmount(1n)).to.equal(LOCK);
      expect(await vault.totalReserved()).to.equal(LOCK);

      await token.setFailTransfers(false);
      await vault.connect(alice).redeem(1n);
      expect(await token.balanceOf(alice.address)).to.equal(LOCK);
    });

    it("reverts the deposit when the token returns false", async () => {
      const { admin } = await loadFixture(deployUnfunded);

      const token = await ethers.deployContract("MockConfigurableERC20", []);
      const vault = await ethers.deployContract(
        "CollateralizedNFT",
        [admin.address, await token.getAddress(), LOCK, NAME, SYMBOL, BASE_URI],
        admin,
      );

      await token.mint(admin.address, LOCK);
      await token.approve(await vault.getAddress(), LOCK);
      await token.setFailTransfers(true);

      await expect(vault.deposit(LOCK)).to.be.revertedWithCustomError(
        vault,
        "SafeERC20FailedOperation",
      );
      expect(await vault.tokenBalance()).to.equal(0n);
    });

    it("records what actually arrived from a fee-on-transfer token", async () => {
      const { admin } = await loadFixture(deployUnfunded);

      const token = await ethers.deployContract("MockConfigurableERC20", []);
      const vault = await ethers.deployContract(
        "CollateralizedNFT",
        [admin.address, await token.getAddress(), LOCK, NAME, SYMBOL, BASE_URI],
        admin,
      );

      await token.mint(admin.address, LOCK * 10n);
      await token.approve(await vault.getAddress(), LOCK * 10n);
      await token.setFeeBps(1_000n); // 10%

      const sent = LOCK * 10n;
      const received = (sent * 9_000n) / 10_000n;

      await expect(vault.deposit(sent))
        .to.emit(vault, "Deposited")
        .withArgs(admin.address, received, received);

      // Capacity follows the real balance, not the requested amount.
      expect(await vault.tokenBalance()).to.equal(received);
      expect(await vault.remainingMintCapacity()).to.equal(9n);
    });
  });

  describe("solvency invariant", () => {
    it("holds across a randomised mint, transfer, redeem and reconfigure sequence", async () => {
      const { vault, token, admin, alice, bob, carol } = await loadFixture(deployTinyReserve);

      // Top the reserve up so the sequence has room to run.
      const extra = ethers.parseEther("50000");
      await token.mint(admin.address, extra);
      await token.approve(await vault.getAddress(), extra);
      await vault.deposit(extra);

      const holders = [alice, bob, carol];
      const outstanding = new Map<bigint, { owner: typeof alice; locked: bigint }>();

      // Deterministic pseudo-random walk: a fixed seed keeps a failure reproducible.
      let seed = 42n;
      const next = (n: number) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return Number((seed >> 33n) % BigInt(n));
      };

      for (let step = 0; step < 120; step++) {
        const action = next(10);
        const holder = holders[next(holders.length)];

        if (action < 4) {
          const capacity = await vault.remainingMintCapacity();
          if (capacity === 0n) continue;

          const lock = await vault.lockAmount();
          const id = await vault.mint.staticCall(holder.address);
          await vault.mint(holder.address);
          outstanding.set(id, { owner: holder, locked: lock });
        } else if (action < 7) {
          const ids = [...outstanding.keys()];
          if (ids.length === 0) continue;

          const id = ids[next(ids.length)];
          const entry = outstanding.get(id)!;

          const before = await token.balanceOf(entry.owner.address);
          await vault.connect(entry.owner).redeem(id);
          const after = await token.balanceOf(entry.owner.address);

          expect(after - before).to.equal(entry.locked, `NFT #${id} refunded the wrong amount`);
          outstanding.delete(id);
        } else if (action < 9) {
          const ids = [...outstanding.keys()];
          if (ids.length === 0) continue;

          const id = ids[next(ids.length)];
          const entry = outstanding.get(id)!;
          const to = holders[next(holders.length)];
          if (to.address === entry.owner.address) continue;

          await vault.connect(entry.owner).transferFrom(entry.owner.address, to.address, id);
          outstanding.set(id, { owner: to, locked: entry.locked });
        } else {
          const multiplier = BigInt(next(4) + 1);
          await vault.setLockAmount(LOCK * multiplier);
        }

        await expectSolvent(vault, [...outstanding.keys()], (id) => vault.lockedAmount(id));
      }

      expect(outstanding.size).to.be.greaterThan(0, "the walk redeemed everything, weakening it");

      // Every survivor still redeems for exactly what it was minted with.
      for (const [id, entry] of outstanding) {
        expect(await vault.lockedAmount(id)).to.equal(entry.locked);
        await expect(vault.connect(entry.owner).redeem(id)).to.changeTokenBalance(
          ethers,
          token,
          entry.owner,
          entry.locked,
        );
      }

      expect(await vault.totalReserved()).to.equal(0n);
      expect(await vault.totalSupply()).to.equal(0n);
    });

    it("never pays out more than was deposited, across the full reserve", async () => {
      const { vault, token, alice } = await loadFixture(deployTinyReserve);

      await vault.mintBatch(alice.address, 4n);
      await expect(vault.mint(alice.address)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBacking",
      );

      for (let id = 1n; id <= 4n; id++) {
        await vault.connect(alice).redeem(id);
      }

      expect(await token.balanceOf(alice.address)).to.equal(LOCK * 4n);
      expect(await vault.tokenBalance()).to.equal(0n);
      expect(await vault.totalReserved()).to.equal(0n);
      expect(await vault.totalMinted()).to.equal(4n);
      expect(await vault.totalRedeemed()).to.equal(4n);
    });

    it("leaves a holder whole against an admin using every extraction path it has", async () => {
      const { vault, token, admin, alice } = await loadFixture(deployTinyReserve);

      // Alice buys in; 250 of the 1000 is now hers.
      await vault.mint(alice.address);

      // The admin now tries everything the contract offers, in the worst order for Alice:
      // mint to itself and redeem, sweeping the proceeds, then sweep whatever is left.
      await vault.mintBatch(admin.address, 3n);
      for (let id = 2n; id <= 4n; id++) {
        await vault.redeem(id);
      }
      await vault.setLockAmount(1n);
      await vault.setPublicMintEnabled(true);

      const remaining = await vault.availableBacking();
      if (remaining > 0n) {
        await vault.withdrawExcessTokens(admin.address, remaining);
      }

      // One wei more is out of reach, however it is asked for.
      await expect(vault.withdrawExcessTokens(admin.address, 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(0n, 1n);
      await expect(
        vault.rescueERC20(await token.getAddress(), admin.address, 1n),
      ).to.be.revertedWithCustomError(vault, "BackingTokenNotRescuable");
      await expect(vault.redeem(1n))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner")
        .withArgs(1n, alice.address, admin.address);

      // Alice's collateral is exactly what it was, and it is all that is left.
      expect(await vault.totalReserved()).to.equal(LOCK);
      expect(await vault.tokenBalance()).to.equal(LOCK);
      expect(await vault.lockedAmount(1n)).to.equal(LOCK);

      await expect(vault.connect(alice).redeem(1n)).to.changeTokenBalance(
        ethers,
        token,
        alice,
        LOCK,
      );
      expect(await vault.tokenBalance()).to.equal(0n);
    });

    it("reports a consistent picture through vaultState", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mintBatch(alice.address, 7n);
      await vault.connect(alice).redeem(3n);

      const state = await vault.vaultState();

      expect(state.balance).to.equal(RESERVE - LOCK);
      expect(state.reserved).to.equal(LOCK * 6n);
      expect(state.available).to.equal(RESERVE - LOCK - LOCK * 6n);
      expect(state.minted).to.equal(7n);
      expect(state.redeemed).to.equal(1n);
      expect(state.outstanding).to.equal(6n);
      expect(state.currentLockAmount).to.equal(LOCK);
      expect(state.mintCapacity).to.equal(state.available / LOCK);
      expect(state.mintCapacity).to.equal(await vault.remainingMintCapacity());
    });
  });

  describe("fuzz", () => {
    const lockAmounts = [1n, 2n, ethers.parseEther("0.000001"), LOCK, ethers.parseEther("1000000")];

    for (const lock of lockAmounts) {
      it(`mints and redeems cleanly at a lock of ${ethers.formatEther(lock)}`, async () => {
        const { token, admin, alice } = await loadFixture(deployUnfunded);

        const vault = await ethers.deployContract(
          "CollateralizedNFT",
          [admin.address, await token.getAddress(), lock, NAME, SYMBOL, BASE_URI],
          admin,
        );

        const funding = lock * 3n;
        await token.mint(admin.address, funding);
        await token.approve(await vault.getAddress(), funding);
        await vault.deposit(funding);

        expect(await vault.remainingMintCapacity()).to.equal(3n);

        await vault.mintBatch(alice.address, 3n);
        expect(await vault.totalReserved()).to.equal(funding);
        await expect(vault.mint(alice.address)).to.be.revertedWithCustomError(
          vault,
          "InsufficientBacking",
        );

        for (let id = 1n; id <= 3n; id++) {
          await expect(vault.connect(alice).redeem(id)).to.changeTokenBalance(ethers, token, alice, lock);
        }

        expect(await vault.tokenBalance()).to.equal(0n);
        expect(await vault.totalReserved()).to.equal(0n);
      });
    }

    it("handles a lock amount at the edge of uint256", async () => {
      const { token, admin, alice } = await loadFixture(deployUnfunded);
      const huge = 2n ** 200n;

      const vault = await ethers.deployContract(
        "CollateralizedNFT",
        [admin.address, await token.getAddress(), huge, NAME, SYMBOL, BASE_URI],
        admin,
      );

      // Nothing can back a lock that large, so minting fails rather than over-issuing.
      expect(await vault.remainingMintCapacity()).to.equal(0n);
      await expect(vault.mint(alice.address))
        .to.be.revertedWithCustomError(vault, "InsufficientBacking")
        .withArgs(0n, huge);
    });

    it("keeps capacity honest for arbitrary balances", async () => {
      const { vault, token } = await loadFixture(deployUnfunded);
      const vaultAddress = await vault.getAddress();

      for (const balance of [0n, 1n, LOCK - 1n, LOCK, LOCK + 1n, LOCK * 3n - 1n, LOCK * 3n]) {
        const current = await vault.tokenBalance();
        if (balance > current) {
          await token.transfer(vaultAddress, balance - current);
        }

        expect(await vault.tokenBalance()).to.equal(balance);
        expect(await vault.remainingMintCapacity()).to.equal(balance / LOCK);
      }
    });
  });

  // ---------------------------------------------------------------------------------
  // An NFT here is a bearer claim on collateral, so the standard's transfer and approval
  // rules are part of what decides who can take the money — not just metadata plumbing.
  // ---------------------------------------------------------------------------------
  describe("ERC721 semantics", () => {
    it("moves the position with the token through safeTransferFrom", async () => {
      const { vault, token, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1n);

      expect(await vault.ownerOf(1n)).to.equal(bob.address);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.balanceOf(bob.address)).to.equal(1n);

      // The lock followed the token, and only the new owner can cash it.
      expect(await vault.lockedAmount(1n)).to.equal(LOCK);
      await expect(vault.connect(bob).redeem(1n)).to.changeTokenBalance(ethers, token, bob, LOCK);
    });

    it("refuses safeTransferFrom into a contract that cannot receive one", async () => {
      const { vault, token, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(
        vault
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](
            alice.address,
            await token.getAddress(),
            1n,
          ),
      ).to.be.revertedWithCustomError(vault, "ERC721InvalidReceiver");

      expect(await vault.ownerOf(1n)).to.equal(alice.address);
    });

    it("lets an approved operator move the NFT but never redeem it", async () => {
      const { vault, alice, bob, carol } = await loadFixture(deployFunded);

      await vault.mint(alice.address);
      await vault.connect(alice).approve(bob.address, 1n);
      expect(await vault.getApproved(1n)).to.equal(bob.address);

      // Moving is delegated; cashing out is not.
      await expect(vault.connect(bob).redeem(1n)).to.be.revertedWithCustomError(
        vault,
        "NotTokenOwner",
      );
      await vault.connect(bob).transferFrom(alice.address, carol.address, 1n);

      expect(await vault.ownerOf(1n)).to.equal(carol.address);
      expect(await vault.getApproved(1n)).to.equal(ethers.ZeroAddress);
    });

    it("honours setApprovalForAll across every NFT the owner holds", async () => {
      const { vault, alice, bob, carol } = await loadFixture(deployFunded);

      await vault.mintBatch(alice.address, 3n);
      await vault.connect(alice).setApprovalForAll(bob.address, true);
      expect(await vault.isApprovedForAll(alice.address, bob.address)).to.equal(true);

      for (let id = 1n; id <= 3n; id++) {
        await vault.connect(bob).transferFrom(alice.address, carol.address, id);
      }
      expect(await vault.balanceOf(carol.address)).to.equal(3n);

      await vault.connect(alice).setApprovalForAll(bob.address, false);
      expect(await vault.isApprovedForAll(alice.address, bob.address)).to.equal(false);
    });

    it("refuses a transfer from an account that is not the owner", async () => {
      const { vault, alice, bob } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      await expect(
        vault.connect(bob).transferFrom(alice.address, bob.address, 1n),
      ).to.be.revertedWithCustomError(vault, "ERC721InsufficientApproval");
    });

    it("refuses a transfer to the zero address", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mint(alice.address);

      // Burning by transfer would destroy the NFT without releasing its collateral.
      await expect(
        vault.connect(alice).transferFrom(alice.address, ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(vault, "ERC721InvalidReceiver");

      expect(await vault.totalReserved()).to.equal(LOCK);
    });

    it("reports balanceOf and reverts ownerOf for a burned id", async () => {
      const { vault, alice } = await loadFixture(deployFunded);

      await vault.mintBatch(alice.address, 2n);
      expect(await vault.balanceOf(alice.address)).to.equal(2n);

      await vault.connect(alice).redeem(1n);

      expect(await vault.balanceOf(alice.address)).to.equal(1n);
      await expect(vault.ownerOf(1n)).to.be.revertedWithCustomError(
        vault,
        "ERC721NonexistentToken",
      );
      expect(await vault.ownerOf(2n)).to.equal(alice.address);
    });

    it("refuses balanceOf for the zero address", async () => {
      const { vault } = await loadFixture(deployFunded);

      await expect(vault.balanceOf(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "ERC721InvalidOwner",
      );
    });
  });

  describe("rescue validation", () => {
    it("rejects a rescue to the zero address", async () => {
      const { vault } = await loadFixture(deployFunded);
      const stray = await ethers.deployContract("MockConfigurableERC20", []);

      await expect(
        vault.rescueERC20(await stray.getAddress(), ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("refuses a non-admin", async () => {
      const { vault, alice } = await loadFixture(deployFunded);
      const stray = await ethers.deployContract("MockConfigurableERC20", []);

      await expect(
        vault.connect(alice).rescueERC20(await stray.getAddress(), alice.address, 1n),
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });
});
