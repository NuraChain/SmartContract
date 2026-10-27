import { expect } from "chai";
import type { FunctionFragment } from "ethers";
import hre, { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/** Coverage instruments the bytecode, so gas measured under it says nothing about the deployed contract. */
const measuring = hre.globalOptions.coverage !== true;

const FEE = 500;
const REFERRAL = 2_000;
const MAX_STAKE = ethers.parseEther("1000");
const RECLAIM_AFTER = 3n * 24n * 3600n;
const DEPOSIT = ethers.parseEther("100");
const STAKE = ethers.parseEther("10");

const coder = ethers.AbiCoder.defaultAbiCoder();

const STAKE_TYPES = {
  Stake: [
    { name: "player", type: "address" },
    { name: "game", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "commit", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
};

/** Arcade's own secret for one seat of one game, and the commit the player signs over it. */
const secretFor = (label: string) => ethers.id(`secret:${label}`);
const commitOf = (secret: string) => ethers.keccak256(coder.encode(["bytes32"], [secret]));
const idOf = (label: string) => ethers.id(`game:${label}`);

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];
type Vault = Awaited<ReturnType<typeof deploy>>["vault"];

type Terms = {
  game?: string;
  amount?: bigint;
  feeBps?: number;
  commit?: string;
  nonce?: string;
  deadline?: bigint;
};

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow would re-run the setup every time instead of
// reverting to a snapshot.

async function deploy() {
  const [admin, referee, outsider, ...rest] = await ethers.getSigners();
  const players = rest.slice(0, 9);
  const vault = await ethers.deployContract(
    "ArcadeVault",
    [admin.address, referee.address, FEE, REFERRAL, MAX_STAKE, RECLAIM_AFTER],
    admin,
  );

  return { vault, admin, referee, outsider, players };
}

/** Every player holds DEPOSIT in the vault. */
async function deployFunded() {
  const ctx = await deploy();
  for (const player of ctx.players) {
    await ctx.vault.connect(player)["deposit()"]({ value: DEPOSIT });
  }
  return ctx;
}

/** Every player holds DEPOSIT, and every one but the last was brought in by `outsider`. */
async function deployReferred() {
  const ctx = await deploy();
  for (const [i, player] of ctx.players.entries()) {
    const referrer = i < ctx.players.length - 1 ? ctx.outsider.address : ethers.ZeroAddress;
    await ctx.vault.connect(player)["deposit(address)"](referrer, { value: DEPOSIT });
  }
  return ctx;
}

async function soon() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp) + 1800n;
}

async function domainOf(vault: Vault, chainId?: bigint) {
  return {
    name: "ArcadeVault",
    version: "1",
    chainId: chainId ?? (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await vault.getAddress(),
  };
}

/** One player's signed stake for the seat named `label`, the way Arcade's browser asks a wallet for it. */
async function seatOf(vault: Vault, player: Signer, label: string, terms: Terms = {}) {
  const value = {
    player: player.address,
    game: terms.game ?? "ludo",
    amount: terms.amount ?? STAKE,
    feeBps: terms.feeBps ?? FEE,
    commit: terms.commit ?? commitOf(secretFor(label)),
    nonce: terms.nonce ?? ethers.id(`nonce:${label}`),
    deadline: terms.deadline ?? (await soon()),
  };
  const signature = await player.signTypedData(await domainOf(vault), STAKE_TYPES, value);

  return { player: value.player, commit: value.commit, nonce: value.nonce, deadline: value.deadline, signature };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;

/** Opens a game of the first `count` players, every one signing the same terms. */
async function openGame(ctx: Ctx, label: string, count: number, terms: Terms = {}) {
  const seats = [];
  for (let i = 0; i < count; i++) {
    seats.push(await seatOf(ctx.vault, ctx.players[i], `${label}:${i}`, terms));
  }

  const id = idOf(label);
  await ctx.vault.connect(ctx.referee).open(id, terms.game ?? "ludo", terms.amount ?? STAKE, terms.feeBps ?? FEE, seats);

  return { id, seats, secrets: seats.map((_, i) => secretFor(`${label}:${i}`)) };
}

async function gasCostOf(tx: { wait(): Promise<{ gasUsed: bigint; gasPrice: bigint } | null> }) {
  const receipt = await tx.wait();
  return receipt!.gasUsed * receipt!.gasPrice;
}

describe("ArcadeVault", () => {
  describe("deployment", () => {
    it("stores the fee, the ceiling, the reclaim delay and the roles", async () => {
      const { vault, admin, referee } = await loadFixture(deploy);

      expect(await vault.fee()).to.equal(BigInt(FEE));
      expect(await vault.maxStake()).to.equal(MAX_STAKE);
      expect(await vault.reclaimAfter()).to.equal(RECLAIM_AFTER);
      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await vault.owner()).to.equal(admin.address);
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), admin.address)).to.equal(true);
      expect(await vault.hasRole(await vault.REFEREE_ROLE(), referee.address)).to.equal(true);
      expect(await vault.hasRole(await vault.REFEREE_ROLE(), admin.address)).to.equal(false);
      expect(await vault.referee()).to.equal(referee.address);
      expect(await vault.feeOf("ludo")).to.equal(BigInt(FEE));
      expect(await vault.solvent()).to.equal(true);
    });

    it("refuses a zero admin or referee, a fee under 1% or over 15%, a referral share under 1% or over 75% of the fee, a zero ceiling and a reclaim delay out of bounds", async () => {
      const { admin, referee } = await loadFixture(deploy);
      const factory = await ethers.getContractFactory("ArcadeVault");
      const day = 24n * 3600n;

      await expect(factory.deploy(ethers.ZeroAddress, referee.address, FEE, REFERRAL, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "AccessControlInvalidDefaultAdmin")
        .withArgs(ethers.ZeroAddress);
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, FEE, REFERRAL, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, referee.address, 1501, REFERRAL, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "FeeOutOfRange")
        .withArgs(1501);
      await expect(factory.deploy(admin.address, referee.address, 99, REFERRAL, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "FeeOutOfRange")
        .withArgs(99);
      await expect(factory.deploy(admin.address, referee.address, FEE, REFERRAL, 0n, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "ZeroAmount");
      await expect(factory.deploy(admin.address, referee.address, FEE, REFERRAL, MAX_STAKE, day - 1n))
        .to.be.revertedWithCustomError(factory, "BadReclaimDelay")
        .withArgs(day - 1n);
      await expect(factory.deploy(admin.address, referee.address, FEE, REFERRAL, MAX_STAKE, 30n * day + 1n))
        .to.be.revertedWithCustomError(factory, "BadReclaimDelay")
        .withArgs(30n * day + 1n);

      await expect(factory.deploy(admin.address, referee.address, FEE, 7501, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "ReferralShareOutOfRange")
        .withArgs(7501);
      await expect(factory.deploy(admin.address, referee.address, FEE, 99, MAX_STAKE, RECLAIM_AFTER))
        .to.be.revertedWithCustomError(factory, "ReferralShareOutOfRange")
        .withArgs(99);

      await factory.deploy(admin.address, referee.address, 1500, 7500, 1n, day);
      await factory.deploy(admin.address, referee.address, 100, 100, MAX_STAKE, 30n * day);
    });
  });

  describe("deposits and withdrawals", () => {
    it("credits a deposit and a plain transfer to the sender", async () => {
      const { vault, players } = await loadFixture(deploy);
      const [alice, bob] = players;

      await expect(vault.connect(alice)["deposit()"]({ value: DEPOSIT }))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, DEPOSIT);
      await expect(bob.sendTransaction({ to: await vault.getAddress(), value: STAKE }))
        .to.emit(vault, "Deposited")
        .withArgs(bob.address, STAKE);

      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);
      expect(await vault.balanceOf(bob.address)).to.equal(STAKE);
      expect(await vault.totalBalances()).to.equal(DEPOSIT + STAKE);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(DEPOSIT + STAKE);
    });

    it("refuses an empty deposit", async () => {
      const { vault, players } = await loadFixture(deploy);

      await expect(vault.connect(players[0])["deposit()"]({ value: 0n })).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(players[0].sendTransaction({ to: await vault.getAddress(), value: 0n }))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("pays a withdrawal to its owner and to nobody else", async () => {
      const { vault, players } = await loadFixture(deployFunded);
      const [alice] = players;
      const before = await ethers.provider.getBalance(alice.address);

      const tx = await vault.connect(alice).withdraw(STAKE);
      const gasCost = await gasCostOf(tx);

      await expect(tx).to.emit(vault, "Withdrawn").withArgs(alice.address, STAKE);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + STAKE - gasCost);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT - STAKE);
      expect(await vault.totalBalances()).to.equal(DEPOSIT * 9n - STAKE);
    });

    it("refuses a withdrawal of nothing, or of more than is free", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, players } = ctx;
      const [alice, bob] = players;

      await expect(vault.connect(alice).withdraw(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(alice).withdraw(DEPOSIT + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientBalance")
        .withArgs(DEPOSIT, DEPOSIT + 1n);

      await openGame(ctx, "free", 2);
      await expect(vault.connect(bob).withdraw(DEPOSIT))
        .to.be.revertedWithCustomError(vault, "InsufficientBalance")
        .withArgs(DEPOSIT - STAKE, DEPOSIT);
    });
  });

  describe("opening a game", () => {
    it("locks every stake, uses every signature and records who plays", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, players } = ctx;
      const seats = [];
      for (let i = 0; i < 3; i++) {
        seats.push(await seatOf(vault, players[i], `open:${i}`));
      }
      const id = idOf("open");

      const tx = await vault.connect(referee).open(id, "ludo", STAKE, FEE, seats);

      await expect(tx)
        .to.emit(vault, "Opened")
        .withArgs(id, "ludo", STAKE, FEE, seats.map((seat) => seat.player), seats.map((seat) => seat.commit));
      await expect(tx).to.emit(vault, "Staked").withArgs(id, players[1].address, STAKE);

      for (let i = 0; i < 3; i++) {
        expect(await vault.balanceOf(players[i].address)).to.equal(DEPOSIT - STAKE);
        expect(await vault.lockedOf(players[i].address)).to.equal(STAKE);
        expect(await vault.nonceUsed(players[i].address, seats[i].nonce)).to.equal(true);
      }
      expect(await vault.balanceOf(players[3].address)).to.equal(DEPOSIT);
      expect(await vault.totalLocked()).to.equal(STAKE * 3n);
      expect(await vault.totalBalances()).to.equal(DEPOSIT * 9n - STAKE * 3n);

      const game = await vault.gameOf(id);
      expect(game.status).to.equal(1n);
      expect(game.feeBps).to.equal(BigInt(FEE));
      expect(game.amount).to.equal(STAKE);
      expect(game.players).to.deep.equal(seats.map((seat) => seat.player));
      expect(await vault.solvent()).to.equal(true);
    });

    it("opens nine players, and no fewer than two or more than nine", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, players } = ctx;

      await openGame(ctx, "nine", 9);
      expect(await vault.totalLocked()).to.equal(STAKE * 9n);

      const one = [await seatOf(vault, players[0], "one:0")];
      await expect(vault.connect(referee).open(idOf("one"), "ludo", STAKE, FEE, one))
        .to.be.revertedWithCustomError(vault, "BadSeatCount")
        .withArgs(1n);

      const [, , outsider, ...rest] = await ethers.getSigners();
      const ten = [];
      for (let i = 0; i < 10; i++) {
        ten.push(await seatOf(vault, [outsider, ...rest][i], `ten:${i}`));
      }
      await expect(vault.connect(referee).open(idOf("ten"), "ludo", STAKE, FEE, ten))
        .to.be.revertedWithCustomError(vault, "BadSeatCount")
        .withArgs(10n);
    });

    it("refuses anybody but the referee, and refuses while paused", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, players } = ctx;
      const seats = [await seatOf(vault, players[0], "who:0"), await seatOf(vault, players[1], "who:1")];

      await expect(vault.connect(admin).open(idOf("who"), "ludo", STAKE, FEE, seats))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(players[0]).open(idOf("who"), "ludo", STAKE, FEE, seats))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      await vault.connect(admin).pause();
      await expect(vault.connect(referee).open(idOf("who"), "ludo", STAKE, FEE, seats))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");

      await vault.connect(admin).unpause();
      await vault.connect(referee).open(idOf("who"), "ludo", STAKE, FEE, seats);
    });

    it("never uses an id twice, whatever became of the game", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, players } = ctx;
      const { id, secrets } = await openGame(ctx, "twice", 2);

      const again = [await seatOf(vault, players[2], "again:0"), await seatOf(vault, players[3], "again:1")];
      await expect(vault.connect(referee).open(id, "ludo", STAKE, FEE, again))
        .to.be.revertedWithCustomError(vault, "GameExists")
        .withArgs(id);

      await vault.connect(referee).settle(id, 1n, secrets);
      await expect(vault.connect(referee).open(id, "ludo", STAKE, FEE, again))
        .to.be.revertedWithCustomError(vault, "GameExists")
        .withArgs(id);
    });

    describe("input validation", () => {
      it("refuses an empty stake, one over the ceiling, and a fee that is not the vault's", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const zero = [await seatOf(vault, players[0], "z:0", { amount: 0n }), await seatOf(vault, players[1], "z:1", { amount: 0n })];
        const big = MAX_STAKE + 1n;
        const over = [await seatOf(vault, players[0], "o:0", { amount: big }), await seatOf(vault, players[1], "o:1", { amount: big })];
        const cheap = [await seatOf(vault, players[0], "c:0", { feeBps: 100 }), await seatOf(vault, players[1], "c:1", { feeBps: 100 })];

        await expect(vault.connect(referee).open(idOf("z"), "ludo", 0n, FEE, zero))
          .to.be.revertedWithCustomError(vault, "ZeroAmount");
        await expect(vault.connect(referee).open(idOf("o"), "ludo", big, FEE, over))
          .to.be.revertedWithCustomError(vault, "StakeTooHigh")
          .withArgs(big, MAX_STAKE);
        await expect(vault.connect(referee).open(idOf("c"), "ludo", STAKE, 100, cheap))
          .to.be.revertedWithCustomError(vault, "FeeMismatch")
          .withArgs(100, FEE);
      });

      it("refuses the same player twice, and a seat with no player", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const twice = [await seatOf(vault, players[0], "d:0"), await seatOf(vault, players[0], "d:1")];

        await expect(vault.connect(referee).open(idOf("d"), "ludo", STAKE, FEE, twice))
          .to.be.revertedWithCustomError(vault, "DuplicatePlayer")
          .withArgs(players[0].address);

        const nobody = [{ ...(await seatOf(vault, players[0], "n:0")), player: ethers.ZeroAddress }, await seatOf(vault, players[1], "n:1")];
        await expect(vault.connect(referee).open(idOf("n"), "ludo", STAKE, FEE, nobody))
          .to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("names the player whose stake stops the game", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const [alice, bob] = players;

        const block = await ethers.provider.getBlock("latest");
        const past = BigInt(block!.timestamp) - 1n;
        const expired = [await seatOf(vault, alice, "e:0"), await seatOf(vault, bob, "e:1", { deadline: past })];
        await expect(vault.connect(referee).open(idOf("e"), "ludo", STAKE, FEE, expired))
          .to.be.revertedWithCustomError(vault, "StakeExpired")
          .withArgs(bob.address, past);

        const forged = [await seatOf(vault, alice, "f:0"), { ...(await seatOf(vault, alice, "f:1")), player: bob.address }];
        await expect(vault.connect(referee).open(idOf("f"), "ludo", STAKE, FEE, forged))
          .to.be.revertedWithCustomError(vault, "InvalidSignature")
          .withArgs(bob.address);

        await vault.connect(bob).withdraw(DEPOSIT - STAKE + 1n);
        const short = [await seatOf(vault, alice, "s:0"), await seatOf(vault, bob, "s:1")];
        await expect(vault.connect(referee).open(idOf("s"), "ludo", STAKE, FEE, short))
          .to.be.revertedWithCustomError(vault, "StakeUnfunded")
          .withArgs(bob.address, STAKE - 1n, STAKE);
      });

      it("accepts a stake in the same second it expires, and not one second after", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp) + 60n;

        const edge = [await seatOf(vault, players[0], "edge:0", { deadline }), await seatOf(vault, players[1], "edge:1", { deadline })];
        const late = [await seatOf(vault, players[2], "late:0", { deadline }), await seatOf(vault, players[3], "late:1", { deadline })];

        await networkHelpers.time.setNextBlockTimestamp(deadline);
        await vault.connect(referee).open(idOf("edge"), "ludo", STAKE, FEE, edge);

        await networkHelpers.time.setNextBlockTimestamp(deadline + 1n);
        await expect(vault.connect(referee).open(idOf("late"), "ludo", STAKE, FEE, late))
          .to.be.revertedWithCustomError(vault, "StakeExpired")
          .withArgs(players[2].address, deadline);
      });

      it("refuses a stake that would still be good for more than a day", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const block = await ethers.provider.getBlock("latest");
        const at = BigInt(block!.timestamp) + 10n;
        const day = 24n * 3600n;

        const longest = [await seatOf(vault, players[0], "day:0", { deadline: at + day }), await seatOf(vault, players[1], "day:1", { deadline: at + day })];
        const tooLong = [await seatOf(vault, players[2], "year:0", { deadline: at + day }), await seatOf(vault, players[3], "year:1", { deadline: at + day + 1n })];

        await networkHelpers.time.setNextBlockTimestamp(at);
        await expect(vault.connect(referee).open(idOf("year"), "ludo", STAKE, FEE, tooLong))
          .to.be.revertedWithCustomError(vault, "StakeTooLong")
          .withArgs(players[3].address, at + day + 1n);

        await networkHelpers.time.setNextBlockTimestamp(at);
        await vault.connect(referee).open(idOf("day"), "ludo", STAKE, FEE, longest);
        expect((await vault.gameOf(idOf("day"))).openedAt).to.equal(at);
      });
    });

    describe("domain binding", () => {
      it("refuses a signature used once already", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const seats = [await seatOf(vault, players[0], "r:0"), await seatOf(vault, players[1], "r:1")];

        await vault.connect(referee).open(idOf("r1"), "ludo", STAKE, FEE, seats);
        await expect(vault.connect(referee).open(idOf("r2"), "ludo", STAKE, FEE, seats))
          .to.be.revertedWithCustomError(vault, "NonceUsed")
          .withArgs(players[0].address, seats[0].nonce);
      });

      it("refuses a signature over any other game, stake, fee, commit, nonce or deadline", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const [alice, bob] = players;
        const deadline = await soon();
        const honest = await seatOf(vault, bob, "b:1", { deadline });
        const variants: Array<[string, Terms]> = [
          ["game", { game: "hokm" }],
          ["amount", { amount: STAKE + 1n }],
          ["fee", { feeBps: FEE + 1 }],
          ["commit", { commit: commitOf(secretFor("other")) }],
          ["nonce", { nonce: ethers.id("other nonce") }],
          ["deadline", { deadline: deadline + 1n }],
        ];

        for (const [label, terms] of variants) {
          const signed = await seatOf(vault, alice, `b:0:${label}`, { deadline, ...terms });
          const presented = {
            ...signed,
            commit: commitOf(secretFor(`b:0:${label}`)),
            nonce: ethers.id(`nonce:b:0:${label}`),
            deadline,
          };
          await expect(vault.connect(referee).open(idOf(`b:${label}`), "ludo", STAKE, FEE, [presented, honest]))
            .to.be.revertedWithCustomError(vault, "InvalidSignature")
            .withArgs(alice.address);
        }
      });

      it("refuses a signature made for another vault or another chain", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, admin, referee, players } = ctx;
        const [alice, bob] = players;
        const other = await ethers.deployContract("ArcadeVault", [admin.address, referee.address, FEE, REFERRAL, MAX_STAKE, RECLAIM_AFTER], admin);
        const value = {
          player: alice.address,
          game: "ludo",
          amount: STAKE,
          feeBps: FEE,
          commit: commitOf(secretFor("x:0")),
          nonce: ethers.id("nonce:x:0"),
          deadline: await soon(),
        };
        const honest = await seatOf(vault, bob, "x:1");

        const forOther = await alice.signTypedData(await domainOf(other as unknown as Vault), STAKE_TYPES, value);
        await expect(vault.connect(referee).open(idOf("x1"), "ludo", STAKE, FEE, [{ ...value, signature: forOther }, honest]))
          .to.be.revertedWithCustomError(vault, "InvalidSignature")
          .withArgs(alice.address);

        const forFork = await alice.signTypedData(await domainOf(vault, 1n), STAKE_TYPES, value);
        await expect(vault.connect(referee).open(idOf("x2"), "ludo", STAKE, FEE, [{ ...value, signature: forFork }, honest]))
          .to.be.revertedWithCustomError(vault, "InvalidSignature")
          .withArgs(alice.address);
      });

      it("computes the digest a wallet signs", async () => {
        const { vault, players } = await loadFixture(deployFunded);
        const value = {
          player: players[0].address,
          game: "backgammon",
          amount: STAKE,
          feeBps: FEE,
          commit: commitOf(secretFor("digest")),
          nonce: ethers.id("nonce:digest"),
          deadline: 1_900_000_000n,
        };

        const expected = ethers.TypedDataEncoder.hash(await domainOf(vault), STAKE_TYPES, value);
        expect(
          await vault.stakeDigest(value.player, value.game, value.amount, value.feeBps, value.commit, value.nonce, value.deadline),
        ).to.equal(expected);
      });

      it("takes a stake a contract wallet signs through ERC-1271, and refuses one its owner did not", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, admin, referee, players } = ctx;
        const [alice, bob, carol] = players;
        const wallet = await ethers.deployContract("StakeWallet", [await vault.getAddress(), alice.address], admin);
        const walletAddress = await wallet.getAddress();
        await wallet.deposit({ value: DEPOSIT });

        const value = {
          player: walletAddress,
          game: "ludo",
          amount: STAKE,
          feeBps: FEE,
          commit: commitOf(secretFor("w:0")),
          nonce: ethers.id("nonce:w:0"),
          deadline: await soon(),
        };
        const domain = await domainOf(vault);
        const byOwner = await alice.signTypedData(domain, STAKE_TYPES, value);
        const byStranger = await carol.signTypedData(domain, STAKE_TYPES, { ...value, nonce: ethers.id("nonce:w:1") });

        await expect(
          vault.connect(referee).open(idOf("w1"), "ludo", STAKE, FEE, [
            { ...value, nonce: ethers.id("nonce:w:1"), signature: byStranger },
            await seatOf(vault, bob, "w1:1"),
          ]),
        )
          .to.be.revertedWithCustomError(vault, "InvalidSignature")
          .withArgs(walletAddress);

        await vault.connect(referee).open(idOf("w0"), "ludo", STAKE, FEE, [{ ...value, signature: byOwner }, await seatOf(vault, bob, "w0:1")]);
        expect(await vault.lockedOf(walletAddress)).to.equal(STAKE);
      });

      it("lets a player cancel a stake they signed", async () => {
        const ctx = await loadFixture(deployFunded);
        const { vault, referee, players } = ctx;
        const seats = [await seatOf(vault, players[0], "k:0"), await seatOf(vault, players[1], "k:1")];

        await expect(vault.connect(players[1]).cancel(seats[1].nonce))
          .to.emit(vault, "Cancelled")
          .withArgs(players[1].address, seats[1].nonce);
        await expect(vault.connect(referee).open(idOf("k"), "ludo", STAKE, FEE, seats))
          .to.be.revertedWithCustomError(vault, "NonceUsed")
          .withArgs(players[1].address, seats[1].nonce);
      });
    });
  });

  describe("settling a game", () => {
    it("pays the pot less the fee to a single winner and keeps the fee", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, players } = ctx;
      const { id, secrets } = await openGame(ctx, "single", 4);
      const pot = STAKE * 4n;
      const cut = (pot * BigInt(FEE)) / 10_000n;

      const tx = await vault.connect(referee).settle(id, 1n << 2n, secrets);

      await expect(tx).to.emit(vault, "Settled").withArgs(id, 4n, pot - cut, cut, secrets);
      await expect(tx).to.emit(vault, "Paid").withArgs(id, players[2].address, pot - cut);
      expect(await vault.balanceOf(players[2].address)).to.equal(DEPOSIT - STAKE + pot - cut);
      for (const i of [0, 1, 3]) {
        expect(await vault.balanceOf(players[i].address)).to.equal(DEPOSIT - STAKE);
      }
      for (let i = 0; i < 4; i++) {
        expect(await vault.lockedOf(players[i].address)).to.equal(0n);
      }
      expect(await vault.fees()).to.equal(cut);
      expect(await vault.totalLocked()).to.equal(0n);
      expect((await vault.gameOf(id)).status).to.equal(2n);
      expect(await vault.solvent()).to.equal(true);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(
        (await vault.totalBalances()) + (await vault.totalLocked()) + (await vault.fees()),
      );
    });

    it("splits the pot between a team of two", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, players } = ctx;
      const { id, secrets } = await openGame(ctx, "team", 4, { game: "hokm" });
      const pot = STAKE * 4n;
      const share = (pot - (pot * BigInt(FEE)) / 10_000n) / 2n;

      await vault.connect(referee).settle(id, (1n << 1n) | (1n << 3n), secrets);

      expect(await vault.balanceOf(players[1].address)).to.equal(DEPOSIT - STAKE + share);
      expect(await vault.balanceOf(players[3].address)).to.equal(DEPOSIT - STAKE + share);
      expect(await vault.balanceOf(players[0].address)).to.equal(DEPOSIT - STAKE);
      expect(await vault.balanceOf(players[2].address)).to.equal(DEPOSIT - STAKE);
    });

    it("gives what a split leaves over to the fee, so the pot is paid to the last wei", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee } = ctx;
      const { id, secrets } = await openGame(ctx, "dust", 3, { amount: 7n });

      await vault.connect(referee).settle(id, 0b011n, secrets);

      const pot = 21n;
      const cut = (pot * BigInt(FEE)) / 10_000n;
      const share = (pot - cut) / 2n;
      expect(await vault.fees()).to.equal(pot - share * 2n);
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await vault.solvent()).to.equal(true);
    });

    it("pays a game at the fee it was opened at, whatever the fee is now", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, players } = ctx;
      const { id, secrets } = await openGame(ctx, "kept fee", 2);

      await vault.connect(admin).setFee(1000);
      await vault.connect(referee).settle(id, 1n, secrets);

      const pot = STAKE * 2n;
      expect(await vault.balanceOf(players[0].address)).to.equal(DEPOSIT - STAKE + pot - (pot * BigInt(FEE)) / 10_000n);
    });

    it("refuses no winner, a seat that is not there, and anybody but the referee", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, players } = ctx;
      const { id, secrets } = await openGame(ctx, "who wins", 3);

      await expect(vault.connect(referee).settle(id, 0n, secrets)).to.be.revertedWithCustomError(vault, "BadWinners").withArgs(0n);
      await expect(vault.connect(referee).settle(id, 1n << 3n, secrets))
        .to.be.revertedWithCustomError(vault, "BadWinners")
        .withArgs(8n);
      await expect(vault.connect(admin).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(players[0]).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("refuses secrets that do not open the commits the players signed", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee } = ctx;
      const { id, secrets } = await openGame(ctx, "secrets", 3);

      await expect(vault.connect(referee).settle(id, 1n, secrets.slice(0, 2))).to.be.revertedWithCustomError(vault, "BadSecrets");
      await expect(vault.connect(referee).settle(id, 1n, [secrets[0], secrets[2], secrets[1]])).to.be.revertedWithCustomError(vault, "BadSecrets");
      await expect(vault.connect(referee).settle(id, 1n, [secrets[0], secrets[1], ethers.id("guess")])).to.be.revertedWithCustomError(vault, "BadSecrets");

      await vault.connect(referee).settle(id, 1n, secrets);
    });

    it("pays a game while new games are paused, and never pays one twice", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee } = ctx;
      const { id, secrets } = await openGame(ctx, "paused", 2);

      await vault.connect(admin).pause();
      await vault.connect(referee).settle(id, 1n, secrets);

      await expect(vault.connect(referee).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(id);
      await expect(vault.connect(referee).settle(idOf("never"), 1n, secrets)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(idOf("never"));
    });
  });

  describe("refunds and reclaims", () => {
    it("refunds every stake with no fee, for the referee alone", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, players } = ctx;
      const { id } = await openGame(ctx, "refund", 3);

      await expect(vault.connect(admin).refund(id)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      const tx = await vault.connect(referee).refund(id);
      await expect(tx).to.emit(vault, "Refunded").withArgs(id);
      await expect(tx).to.emit(vault, "Returned").withArgs(id, players[2].address, STAKE);

      for (let i = 0; i < 3; i++) {
        expect(await vault.balanceOf(players[i].address)).to.equal(DEPOSIT);
        expect(await vault.lockedOf(players[i].address)).to.equal(0n);
      }
      expect(await vault.fees()).to.equal(0n);
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await vault.totalBalances()).to.equal(DEPOSIT * 9n);
      expect((await vault.gameOf(id)).status).to.equal(3n);
      await expect(vault.connect(referee).refund(id)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(id);
    });

    it("lets anybody return an unpaid game's stakes once the delay has passed, and not before", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, outsider, players } = ctx;
      const { id, secrets } = await openGame(ctx, "reclaim", 2);
      const openedAt = (await vault.gameOf(id)).openedAt;
      const due = openedAt + RECLAIM_AFTER;

      await networkHelpers.time.setNextBlockTimestamp(due - 1n);
      await expect(vault.connect(outsider).reclaim(id)).to.be.revertedWithCustomError(vault, "TooEarly").withArgs(id, due);

      await vault.connect(admin).pause();
      await networkHelpers.time.setNextBlockTimestamp(due);
      await expect(vault.connect(outsider).reclaim(id)).to.emit(vault, "Reclaimed").withArgs(id, outsider.address);

      expect(await vault.balanceOf(players[0].address)).to.equal(DEPOSIT);
      expect(await vault.balanceOf(players[1].address)).to.equal(DEPOSIT);
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await vault.totalBalances()).to.equal(DEPOSIT * 9n);
      expect((await vault.gameOf(id)).status).to.equal(4n);
      await expect(vault.connect(referee).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(id);
      await expect(vault.connect(outsider).reclaim(id)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(id);
    });

    it("cannot reclaim a game that was paid", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee, outsider } = ctx;
      const { id, secrets } = await openGame(ctx, "paid", 2);

      await vault.connect(referee).settle(id, 1n, secrets);
      await networkHelpers.time.increase(RECLAIM_AFTER + 1n);

      await expect(vault.connect(outsider).reclaim(id)).to.be.revertedWithCustomError(vault, "GameNotOpen").withArgs(id);
    });
  });

  describe("role administration", () => {
    it("lets the admin set the fee from 1% to 15% and the ceiling above nothing", async () => {
      const { vault, admin, players } = await loadFixture(deploy);

      await expect(vault.connect(admin).setFee(1500)).to.emit(vault, "FeeChanged").withArgs(FEE, 1500);
      await expect(vault.connect(admin).setFee(100)).to.emit(vault, "FeeChanged").withArgs(1500, 100);
      await expect(vault.connect(admin).setFee(1501)).to.be.revertedWithCustomError(vault, "FeeOutOfRange").withArgs(1501);
      await expect(vault.connect(admin).setFee(99)).to.be.revertedWithCustomError(vault, "FeeOutOfRange").withArgs(99);
      await expect(vault.connect(admin).setFee(0)).to.be.revertedWithCustomError(vault, "FeeOutOfRange").withArgs(0);
      await expect(vault.connect(admin).setMaxStake(1n)).to.emit(vault, "MaxStakeChanged").withArgs(MAX_STAKE, 1n);
      await expect(vault.connect(admin).setMaxStake(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");

      await expect(vault.connect(players[0]).setFee(0)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(players[0]).setMaxStake(5n)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(players[0]).pause()).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("hands the vault to a new owner only once they accept, with the pauser role", async () => {
      const { vault, admin, players, outsider } = await loadFixture(deploy);
      const ownerRole = await vault.DEFAULT_ADMIN_ROLE();
      const pauser = await vault.PAUSER_ROLE();

      await expect(vault.connect(players[0]).beginDefaultAdminTransfer(players[0].address))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(admin).grantRole(ownerRole, outsider.address))
        .to.be.revertedWithCustomError(vault, "AccessControlEnforcedDefaultAdminRules");

      await vault.connect(admin).beginDefaultAdminTransfer(players[0].address);
      expect(await vault.owner()).to.equal(admin.address);
      await expect(vault.connect(outsider).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(vault, "AccessControlInvalidDefaultAdmin")
        .withArgs(outsider.address);

      await vault.connect(admin).cancelDefaultAdminTransfer();
      await expect(vault.connect(players[0]).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(vault, "AccessControlInvalidDefaultAdmin");

      await vault.connect(admin).beginDefaultAdminTransfer(outsider.address);
      await vault.connect(outsider).acceptDefaultAdminTransfer();

      expect(await vault.owner()).to.equal(outsider.address);
      expect(await vault.hasRole(ownerRole, admin.address)).to.equal(false);
      expect(await vault.hasRole(pauser, admin.address)).to.equal(false);
      expect(await vault.hasRole(pauser, outsider.address)).to.equal(true);
      await expect(vault.connect(admin).setFee(600)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(admin).pause()).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(outsider).setFee(600)).to.emit(vault, "FeeChanged").withArgs(FEE, 600);
      await expect(vault.connect(outsider).pause()).to.emit(vault, "Paused");
    });

    it("lets the admin give one game its own fee from 1% to 15%, and send it back to the shared one", async () => {
      const { vault, admin, players } = await loadFixture(deploy);
      const hokm = ethers.id("hokm");

      await expect(vault.connect(admin).setGameFee("hokm", 1200))
        .to.emit(vault, "GameFeeChanged")
        .withArgs(hokm, "hokm", 0, 1200);
      expect(await vault.gameFee(hokm)).to.equal(1200n);
      expect(await vault.feeOf("hokm")).to.equal(1200n);
      expect(await vault.feeOf("ludo")).to.equal(BigInt(FEE));

      await vault.connect(admin).setFee(700);
      expect(await vault.feeOf("hokm")).to.equal(1200n);
      expect(await vault.feeOf("ludo")).to.equal(700n);

      await expect(vault.connect(admin).setGameFee("hokm", 1501)).to.be.revertedWithCustomError(vault, "FeeOutOfRange").withArgs(1501);
      await expect(vault.connect(admin).setGameFee("hokm", 99)).to.be.revertedWithCustomError(vault, "FeeOutOfRange").withArgs(99);
      await expect(vault.connect(players[0]).setGameFee("hokm", 100)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      await expect(vault.connect(admin).setGameFee("hokm", 0))
        .to.emit(vault, "GameFeeChanged")
        .withArgs(hokm, "hokm", 1200, 0);
      expect(await vault.feeOf("hokm")).to.equal(700n);
    });

    it("opens a game only at its own fee, and pays it at that fee", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, players } = ctx;
      await vault.connect(admin).setGameFee("hokm", 1500);

      const seats = [await seatOf(vault, players[0], "hokm:0", { game: "hokm" }), await seatOf(vault, players[1], "hokm:1", { game: "hokm" })];
      await expect(vault.connect(referee).open(idOf("hokm"), "hokm", STAKE, FEE, seats))
        .to.be.revertedWithCustomError(vault, "FeeMismatch")
        .withArgs(FEE, 1500);

      const { id, secrets } = await openGame(ctx, "hokm at 15%", 2, { game: "hokm", feeBps: 1500 });
      await openGame(ctx, "ludo at the shared fee", 2);
      await vault.connect(referee).settle(id, 1n, secrets);

      const pot = STAKE * 2n;
      expect(await vault.fees()).to.equal((pot * 1500n) / 10_000n);
    });

    it("lets the admin move the referee role in one call, and nobody else", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, outsider, players } = ctx;
      const role = await vault.REFEREE_ROLE();
      const { id, secrets } = await openGame(ctx, "handover", 2);

      await expect(vault.connect(referee).setReferee(referee.address)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(admin).setReferee(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(vault.connect(admin).setReferee(outsider.address))
        .to.emit(vault, "RefereeChanged")
        .withArgs(referee.address, outsider.address);
      expect(await vault.referee()).to.equal(outsider.address);
      expect(await vault.hasRole(role, referee.address)).to.equal(false);
      expect(await vault.hasRole(role, outsider.address)).to.equal(true);

      await expect(vault.connect(referee).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await vault.connect(outsider).settle(id, 1n, secrets);
      expect(await vault.balanceOf(players[0].address)).to.be.greaterThan(DEPOSIT);
    });

    it("pays the fees taken to the admin's choice, and no more than were taken", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, outsider, players } = ctx;
      const { id, secrets } = await openGame(ctx, "fees", 2);
      await vault.connect(referee).settle(id, 1n, secrets);
      const fees = await vault.fees();
      const before = await ethers.provider.getBalance(outsider.address);

      await expect(vault.connect(admin).withdrawFees(outsider.address, fees + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientFees")
        .withArgs(fees, fees + 1n);
      await expect(vault.connect(admin).withdrawFees(ethers.ZeroAddress, fees)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.connect(admin).withdrawFees(outsider.address, 0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(players[0]).withdrawFees(players[0].address, fees))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      await expect(vault.connect(admin).withdrawFees(outsider.address, fees))
        .to.emit(vault, "FeesWithdrawn")
        .withArgs(outsider.address, fees);
      expect(await ethers.provider.getBalance(outsider.address)).to.equal(before + fees);
      expect(await vault.fees()).to.equal(0n);
      expect(await vault.solvent()).to.equal(true);
    });

    it("stops new deposits and games while paused, and never a withdrawal", async () => {
      const { vault, admin, players } = await loadFixture(deployFunded);

      await vault.connect(admin).pause();
      await expect(vault.connect(players[0])["deposit()"]({ value: STAKE })).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(players[0].sendTransaction({ to: await vault.getAddress(), value: STAKE }))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
      await vault.connect(players[0]).withdraw(DEPOSIT);

      await vault.connect(admin).unpause();
      await vault.connect(players[0])["deposit()"]({ value: STAKE });
    });

    it("stops a referee whose role was revoked, and lets a new one pay the game", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee, outsider } = ctx;
      const { id, secrets } = await openGame(ctx, "revoked", 2);
      const role = await vault.REFEREE_ROLE();

      await vault.connect(admin).revokeRole(role, referee.address);
      await expect(vault.connect(referee).settle(id, 1n, secrets)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      await vault.connect(admin).grantRole(role, outsider.address);
      await vault.connect(outsider).settle(id, 1n, secrets);
    });
  });

  describe("reentrancy", () => {
    it("pays a withdrawal re-entered from its receiver exactly once", async () => {
      const { vault, admin } = await loadFixture(deploy);
      const withdrawer = await ethers.deployContract("ReentrantWithdrawer", [await vault.getAddress()], admin);
      const address = await withdrawer.getAddress();
      await withdrawer.deposit({ value: STAKE * 2n });

      await withdrawer.withdraw(STAKE);

      expect(await withdrawer.reenteredCallFailed()).to.equal(true);
      expect(await withdrawer.receiveCount()).to.equal(1n);
      expect(await vault.balanceOf(address)).to.equal(STAKE);
      expect(await ethers.provider.getBalance(address)).to.equal(STAKE);
      expect(await vault.solvent()).to.equal(true);
    });

    it("keeps the balance when the receiver refuses the payment", async () => {
      const { vault, admin } = await loadFixture(deploy);
      const receiver = await ethers.deployContract("RejectingReceiver", [await vault.getAddress()], admin);
      await receiver.deposit({ value: STAKE });

      await expect(receiver.withdraw(STAKE)).to.be.revertedWith("no thanks");
      expect(await vault.balanceOf(await receiver.getAddress())).to.equal(STAKE);
    });

    it("keeps the fees when their receiver refuses them", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, admin, referee } = ctx;
      const receiver = await ethers.deployContract("RejectingReceiver", [await vault.getAddress()], admin);
      const { id, secrets } = await openGame(ctx, "refused fees", 2);
      await vault.connect(referee).settle(id, 1n, secrets);
      const fees = await vault.fees();

      await expect(vault.connect(admin).withdrawFees(await receiver.getAddress(), fees)).to.be.revertedWith("no thanks");
      expect(await vault.fees()).to.equal(fees);
    });
  });

  describe("referrals", () => {
    it("lets a player name their referrer once, with their own deposit, and never themselves", async () => {
      const { vault, admin, outsider, players } = await loadFixture(deploy);
      const [alice, bob, carol] = players;

      await expect(vault.connect(alice)["deposit(address)"](alice.address, { value: STAKE })).to.not.emit(vault, "ReferrerSet");
      await expect(vault.connect(alice)["deposit(address)"](ethers.ZeroAddress, { value: STAKE })).to.not.emit(vault, "ReferrerSet");
      await vault.connect(alice)["deposit()"]({ value: STAKE });
      expect(await vault.referrerOf(alice.address)).to.equal(ethers.ZeroAddress);

      await expect(vault.connect(alice)["deposit(address)"](outsider.address, { value: STAKE }))
        .to.emit(vault, "ReferrerSet")
        .withArgs(alice.address, outsider.address);
      await expect(vault.connect(alice)["deposit(address)"](bob.address, { value: STAKE })).to.not.emit(vault, "ReferrerSet");
      await expect(vault.connect(bob)["deposit(address)"](alice.address, { value: STAKE }))
        .to.emit(vault, "ReferrerSet")
        .withArgs(bob.address, alice.address);

      expect(await vault.referrerOf(alice.address)).to.equal(outsider.address);
      expect(await vault.referrerOf(bob.address)).to.equal(alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(STAKE * 5n);

      // Nothing but a player's own deposit writes referrerOf: the vault has no setter for it.
      const writers = vault.interface.fragments
        .filter((f): f is FunctionFragment => f.type === "function")
        .filter((f) => f.stateMutability !== "view")
        .map((f) => f.name)
        .filter((name) => /referr/i.test(name));
      expect(writers).to.deep.equal(["setReferralShare"]);

      await vault.connect(admin).pause();
      await expect(vault.connect(carol)["deposit(address)"](outsider.address, { value: STAKE }))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("gives each referred seat its cut of the fee, out of the fee alone, as a free balance", async () => {
      const ctx = await loadFixture(deployReferred);
      const { vault, admin, referee, outsider, players } = ctx;
      const count = 9;
      const { id, secrets } = await openGame(ctx, "referred", count);

      const pot = STAKE * BigInt(count);
      const share = pot - (pot * BigInt(FEE)) / 10_000n;
      const cut = (((STAKE * BigInt(FEE)) / 10_000n) * BigInt(REFERRAL)) / 10_000n;
      const referred = cut * BigInt(count - 1);

      const tx = await vault.connect(referee).settle(id, 1n, secrets);
      await expect(tx).to.emit(vault, "ReferralPaid").withArgs(id, players[0].address, outsider.address, cut);
      await expect(tx).to.emit(vault, "ReferralPaid").withArgs(id, players[7].address, outsider.address, cut);
      await expect(tx).to.emit(vault, "Settled").withArgs(id, 1n, share, pot - share - referred, secrets);
      const logs = (await tx.wait())!.logs.filter((l) => vault.interface.parseLog(l)?.name === "ReferralPaid");
      expect(logs.length).to.equal(count - 1);

      expect(await vault.balanceOf(players[0].address)).to.equal(DEPOSIT - STAKE + share);
      expect(await vault.balanceOf(outsider.address)).to.equal(referred);
      expect(await vault.referralEarned(outsider.address)).to.equal(referred);
      expect(await vault.fees()).to.equal(pot - share - referred);
      expect(await vault.solvent()).to.equal(true);

      await vault.connect(admin).pause();
      const before = await ethers.provider.getBalance(outsider.address);
      const gasCost = await gasCostOf(await vault.connect(outsider).withdraw(referred));
      expect(await ethers.provider.getBalance(outsider.address)).to.equal(before + referred - gasCost);
    });

    it("pays a game at the share it was opened at, whatever the share is now", async () => {
      const ctx = await loadFixture(deployReferred);
      const { vault, admin, referee, outsider, players } = ctx;
      const seatFee = (STAKE * BigInt(FEE)) / 10_000n;
      const { id, secrets } = await openGame(ctx, "pinned share", 2);
      expect((await vault.gameOf(id)).referralShare_).to.equal(BigInt(REFERRAL));

      await expect(vault.connect(admin).setReferralShare(7_500)).to.emit(vault, "ReferralShareChanged").withArgs(REFERRAL, 7_500);
      await vault.connect(referee).settle(id, 1n, secrets);
      const cutAt = (share: bigint) => ((seatFee * share) / 10_000n) * 2n;
      expect(await vault.referralEarned(outsider.address)).to.equal(cutAt(BigInt(REFERRAL)));

      const next = await openGame(ctx, "new share", 2);
      expect((await vault.gameOf(next.id)).referralShare_).to.equal(7_500n);
      await expect(vault.connect(admin).setReferralShare(100)).to.emit(vault, "ReferralShareChanged").withArgs(7_500, 100);
      await vault.connect(referee).settle(next.id, 2n, next.secrets);
      expect(await vault.referralEarned(outsider.address)).to.equal(cutAt(BigInt(REFERRAL)) + cutAt(7_500n));

      const least = await openGame(ctx, "least share", 2);
      await vault.connect(referee).settle(least.id, 1n, least.secrets);
      expect(await vault.referralEarned(outsider.address)).to.equal(cutAt(BigInt(REFERRAL)) + cutAt(7_500n) + cutAt(100n));

      await expect(vault.connect(admin).setReferralShare(7_501))
        .to.be.revertedWithCustomError(vault, "ReferralShareOutOfRange")
        .withArgs(7_501);
      await expect(vault.connect(admin).setReferralShare(99))
        .to.be.revertedWithCustomError(vault, "ReferralShareOutOfRange")
        .withArgs(99);
      await expect(vault.connect(admin).setReferralShare(0))
        .to.be.revertedWithCustomError(vault, "ReferralShareOutOfRange")
        .withArgs(0);
      await expect(vault.connect(players[0]).setReferralShare(1)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      await expect(vault.connect(referee).setReferralShare(1)).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("pays no referrer on a refund or a reclaim, which take no fee", async () => {
      const ctx = await loadFixture(deployReferred);
      const { vault, referee, outsider } = ctx;
      const refunded = await openGame(ctx, "refunded", 3);
      const reclaimed = await openGame(ctx, "reclaimed", 3);

      await expect(vault.connect(referee).refund(refunded.id)).to.not.emit(vault, "ReferralPaid");
      await networkHelpers.time.increase(RECLAIM_AFTER);
      await expect(vault.connect(outsider).reclaim(reclaimed.id)).to.not.emit(vault, "ReferralPaid");

      expect(await vault.balanceOf(outsider.address)).to.equal(0n);
      expect(await vault.referralEarned(outsider.address)).to.equal(0n);
      expect(await vault.fees()).to.equal(0n);
    });

    it("stays solvent to the wei with referrers across splits, odd stakes and the largest share", async () => {
      const ctx = await loadFixture(deployReferred);
      const { vault, admin, referee } = ctx;
      await vault.connect(admin).setReferralShare(7_500);
      await vault.connect(admin).setFee(1_500);

      const amounts = [1n, 7n, 9_999n, STAKE + 3n];
      for (const [k, amount] of amounts.entries()) {
        const count = 3 + k * 2;
        const { id, secrets } = await openGame(ctx, `solvent${k}`, count, { amount, feeBps: 1_500 });
        await vault.connect(referee).settle(id, (1n << BigInt(count)) - 2n, secrets);
        const held = await ethers.provider.getBalance(await vault.getAddress());
        expect(held).to.equal((await vault.totalBalances()) + (await vault.totalLocked()) + (await vault.fees()));
      }
      expect(await vault.solvent()).to.equal(true);
    });
  });

  (measuring ? describe : describe.skip)("gas", () => {
    it("opens and settles two, four and nine players within bounds", async () => {
      const ctx = await loadFixture(deployFunded);
      const { vault, referee } = ctx;
      const used: string[] = [];

      for (const count of [2, 4, 9]) {
        const seats = [];
        for (let i = 0; i < count; i++) {
          seats.push(await seatOf(vault, ctx.players[i], `gas${count}:${i}`, { game: "poker" }));
        }
        const id = idOf(`gas${count}`);
        const opened = await (await vault.connect(referee).open(id, "poker", STAKE, FEE, seats)).wait();
        const secrets = seats.map((_, i) => secretFor(`gas${count}:${i}`));
        const settled = await (await vault.connect(referee).settle(id, 1n, secrets)).wait();

        used.push(`${count} seats: open ${opened!.gasUsed}, settle ${settled!.gasUsed}`);
        expect(opened!.gasUsed).to.be.lessThan(BigInt(150_000 + count * 100_000));
        expect(settled!.gasUsed).to.be.lessThan(BigInt(60_000 + count * 20_000));
      }

      console.log(`      ${used.join("; ")}`);
    });

    it("settles nine referred players within bounds", async () => {
      const ctx = await loadFixture(deployReferred);
      const { vault, referee } = ctx;
      const { id, secrets } = await openGame(ctx, "gas referred", 9);
      const settled = await (await vault.connect(referee).settle(id, 1n, secrets)).wait();

      console.log(`      9 seats, 8 referred: settle ${settled!.gasUsed}`);
      expect(settled!.gasUsed).to.be.lessThan(BigInt(60_000 + 9 * 20_000 + 8 * 35_000));
    });
  });
});
