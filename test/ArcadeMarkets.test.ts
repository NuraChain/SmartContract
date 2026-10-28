import { expect } from "chai";
import hre, { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture, time } = networkHelpers;

/** Coverage instruments the bytecode, so gas measured under it says nothing about the deployed contract. */
const measuring = hre.globalOptions.coverage !== true;

const NURA = 10n ** 18n;
const STAKE = 5n * NURA;
const WINDOW = 90n;
const HOUR = 3600n;
const DAY = 24n * HOUR;
const WEEK = 7n * DAY;

const OPEN = 1n;
const SETTLED = 2n;
const REFUNDED = 3n;
const CANCELLED = 4n;
const EXPIRED = 5n;

const TERMS_TYPES = {
  Terms: [
    { name: "market", type: "bytes32" },
    { name: "game", type: "bytes32" },
    { name: "outcomes", type: "uint8" },
    { name: "closesAt", type: "uint64" },
    { name: "feeBps", type: "uint16" },
    { name: "maxStake", type: "uint256" },
    { name: "maxPerBettor", type: "uint256" },
    { name: "maxPool", type: "uint256" },
    { name: "minBettors", type: "uint32" },
    { name: "minOutcomes", type: "uint8" },
  ],
};

const TICKET_TYPES = {
  Ticket: [
    { name: "id", type: "bytes32" },
    { name: "market", type: "bytes32" },
    { name: "terms", type: "bytes32" },
    { name: "bettor", type: "address" },
    { name: "outcome", type: "uint8" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

const marketOf = (label: string) => ethers.id(`market:${label}`);
const ticketOf = (label: string) => ethers.id(`ticket:${label}`);
const gameOf = (label: string) => ethers.id(`game:${label}`);

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

type Terms = {
  market: string;
  game: string;
  outcomes: number;
  closesAt: bigint;
  feeBps: number;
  maxStake: bigint;
  maxPerBettor: bigint;
  maxPool: bigint;
  minBettors: number;
  minOutcomes: number;
};

type Ticket = {
  id: string;
  market: string;
  terms: string;
  bettor: string;
  outcome: number;
  amount: bigint;
  deadline: bigint;
};

type Domain = { name: string; version: string; chainId: bigint; verifyingContract: string };

type Change = Partial<Ticket> & { by?: Signer; domain?: Domain };

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow would re-run the setup every time instead of
// reverting to a snapshot.

async function deploy() {
  const [admin, operator, alice, bob, carol, dave, erin, outsider] = await ethers.getSigners();
  const markets = await ethers.deployContract("ArcadeMarkets", [admin.address, operator.address, 0], admin);

  return { markets, admin, operator, alice, bob, carol, dave, erin, outsider };
}

const DISPUTE = 15n * 60n;

/** The markets with a dispute window, as a real deployment has. */
async function deployWithWindow() {
  const [admin, operator, alice, bob, carol, dave, erin, outsider] = await ethers.getSigners();
  const markets = await ethers.deployContract("ArcadeMarkets", [admin.address, operator.address, DISPUTE], admin);

  return { markets, admin, operator, alice, bob, carol, dave, erin, outsider };
}

/** The markets, and a contract wallet that bets and misbehaves when it is paid. */
async function deployActor() {
  const ctx = await deploy();
  const actor = await ethers.deployContract("MarketsActor", [await ctx.markets.getAddress()], ctx.admin);

  return { ...ctx, actor };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;
type Markets = Ctx["markets"];

async function latest() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function domainOf(markets: Markets, chainId?: bigint): Promise<Domain> {
  return {
    name: "ArcadeMarkets",
    version: "1",
    chainId: chainId ?? (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await markets.getAddress(),
  };
}

/** A market's terms as the Arcade server writes them: a game of two outcomes, open for its window. */
async function termsOf(label: string, change: Partial<Terms> = {}): Promise<Terms> {
  return {
    market: marketOf(label),
    game: gameOf(label),
    outcomes: 2,
    closesAt: (await latest()) + WINDOW,
    feeBps: 0,
    maxStake: 500n * NURA,
    maxPerBettor: 1_000n * NURA,
    maxPool: 100_000n * NURA,
    minBettors: 2,
    minOutcomes: 2,
    ...change,
  };
}

const hashOf = (terms: Terms) => ethers.TypedDataEncoder.hashStruct("Terms", TERMS_TYPES, terms);

/** One position as the server allows it, signed with the operator's key unless `by` says otherwise. */
async function ticketFor(ctx: Ctx, terms: Terms, label: string, bettor: string, outcome: number, amount: bigint, change: Change = {}) {
  const ticket: Ticket = {
    id: change.id ?? ticketOf(label),
    market: change.market ?? terms.market,
    terms: change.terms ?? hashOf(terms),
    bettor: change.bettor ?? bettor,
    outcome: change.outcome ?? outcome,
    amount: change.amount ?? amount,
    deadline: change.deadline ?? (await latest()) + 120n,
  };
  const signature = await (change.by ?? ctx.operator).signTypedData(change.domain ?? (await domainOf(ctx.markets)), TICKET_TYPES, ticket);

  return { ticket, signature };
}

/** `from` places one position at its ticket's amount. */
async function bet(ctx: Ctx, terms: Terms, label: string, from: Signer, outcome: number, amount: bigint, change: Change = {}) {
  const { ticket, signature } = await ticketFor(ctx, terms, label, from.address, outcome, amount, change);
  const tx = await ctx.markets.connect(from).place(terms, ticket, signature, { value: ticket.amount });

  return { ticket, signature, tx };
}

async function closed(terms: Terms) {
  await time.increaseTo(terms.closesAt);
}

async function gasCostOf(tx: { wait(): Promise<{ gasUsed: bigint; gasPrice: bigint } | null> }) {
  const receipt = await tx.wait();
  return receipt!.gasUsed * receipt!.gasPrice;
}

async function balanceOf(address: string | { getAddress(): Promise<string> }) {
  return ethers.provider.getBalance(typeof address === "string" ? address : await address.getAddress());
}

/** What one claim paid its bettor, the gas left out. */
async function claimed(ctx: Ctx, from: Signer, tickets: string[]) {
  const before = await balanceOf(from.address);
  const tx = await ctx.markets.connect(from).claim(tickets);
  const cost = await gasCostOf(tx);

  return (await balanceOf(from.address)) - before + cost;
}

/** The contract holds every stake, share and refund it owes and its fees, to the wei. */
async function books(markets: Markets) {
  expect(await balanceOf(markets)).to.equal((await markets.owed()) + (await markets.fees()));
  expect(await markets.solvent()).to.equal(true);
}

describe("ArcadeMarkets", () => {
  describe("deployment", () => {
    it("stores the operator and the roles, and owes nothing", async () => {
      const { markets, admin, operator } = await loadFixture(deploy);

      expect(await markets.operator()).to.equal(operator.address);
      expect(await markets.defaultAdmin()).to.equal(admin.address);
      expect(await markets.hasRole(await markets.PAUSER_ROLE(), admin.address)).to.equal(true);
      expect(await markets.hasRole(await markets.OPERATOR_ROLE(), operator.address)).to.equal(true);
      expect(await markets.hasRole(await markets.OPERATOR_ROLE(), admin.address)).to.equal(false);
      expect(await markets.owed()).to.equal(0n);
      expect(await markets.fees()).to.equal(0n);
      expect(await markets.disputeWindow()).to.equal(0n);
      expect(await markets.solvent()).to.equal(true);

      await expect(markets.deploymentTransaction()!).to.emit(markets, "OperatorChanged").withArgs(ethers.ZeroAddress, operator.address);
      await expect(markets.deploymentTransaction()!).to.emit(markets, "DisputeWindowChanged").withArgs(0, 0);
    });

    it("refuses a zero owner or operator and a dispute window over a day, and takes a day", async () => {
      const { admin, operator } = await loadFixture(deploy);
      const factory = await ethers.getContractFactory("ArcadeMarkets");

      await expect(factory.deploy(ethers.ZeroAddress, operator.address, 0))
        .to.be.revertedWithCustomError(factory, "AccessControlInvalidDefaultAdmin")
        .withArgs(ethers.ZeroAddress);
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, operator.address, DAY + 1n))
        .to.be.revertedWithCustomError(factory, "DisputeWindowTooLong")
        .withArgs(DAY + 1n);

      expect(await (await factory.deploy(admin.address, operator.address, DAY)).disputeWindow()).to.equal(DAY);
    });
  });

  describe("placing", () => {
    it("opens a market at its first ticket, with its terms, and records the position", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, alice } = ctx;
      const terms = await termsOf("first");
      const before = await balanceOf(alice.address);

      const { ticket, tx } = await bet(ctx, terms, "first", alice, 0, STAKE);
      const cost = await gasCostOf(tx);

      await expect(tx).to.emit(markets, "MarketOpened").withArgs(terms.market, terms.game, hashOf(terms), 2, terms.closesAt, 0);
      await expect(tx).to.emit(markets, "Placed").withArgs(ticket.id, terms.market, alice.address, 0, STAKE);

      const market = await markets.marketOf(terms.market);
      expect(market.terms).to.equal(hashOf(terms));
      expect(market.state).to.equal(OPEN);
      expect(market.outcomes).to.equal(2n);
      expect(market.feeBps).to.equal(0n);
      expect(market.closesAt).to.equal(terms.closesAt);
      expect(market.pool).to.equal(STAKE);
      expect(market.bettors).to.equal(1n);
      expect(market.backedOutcomes).to.equal(1n);
      expect(market.minBettors).to.equal(2n);
      expect(market.minOutcomes).to.equal(2n);

      expect(await markets.positionOf(ticket.id)).to.deep.equal([terms.market, alice.address, 0n, STAKE, false]);
      expect(await markets.backingOf(terms.market, 0)).to.equal(STAKE);
      expect(await markets.stakedOf(terms.market, alice.address)).to.equal(STAKE);
      expect(await markets.owed()).to.equal(STAKE);
      expect(await balanceOf(alice.address)).to.equal(before - STAKE - cost);
      await books(markets);
    });

    it("takes many bettors on many outcomes with stakes of their own, and counts each bettor and outcome once", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, alice, bob, carol, dave, erin } = ctx;
      const terms = await termsOf("many", { outcomes: 4 });
      const positions: [Signer, number, bigint][] = [
        [alice, 0, 1n * NURA],
        [bob, 1, 2n * NURA],
        [carol, 2, 3n * NURA],
        [alice, 1, 4n * NURA],
        [dave, 0, 5n * NURA],
        [erin, 0, 6n * NURA + 7n],
      ];

      for (const [i, [from, outcome, amount]] of positions.entries()) {
        const { tx } = await bet(ctx, terms, `many ${i}`, from, outcome, amount);
        if (i > 0) {
          await expect(tx).to.not.emit(markets, "MarketOpened");
        }
      }

      const market = await markets.marketOf(terms.market);
      expect(market.pool).to.equal(21n * NURA + 7n);
      expect(market.bettors).to.equal(5n);
      expect(market.backedOutcomes).to.equal(3n);
      expect(await markets.backingOf(terms.market, 0)).to.equal(12n * NURA + 7n);
      expect(await markets.backingOf(terms.market, 1)).to.equal(6n * NURA);
      expect(await markets.backingOf(terms.market, 2)).to.equal(3n * NURA);
      expect(await markets.backingOf(terms.market, 3)).to.equal(0n);
      expect(await markets.stakedOf(terms.market, alice.address)).to.equal(5n * NURA);
      expect(await markets.owed()).to.equal(21n * NURA + 7n);
      await books(markets);
    });

    it("refuses a ticket that names other terms, or brings terms other than the ones it names", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, alice, bob } = ctx;
      const terms = await termsOf("named");
      const other = { ...terms, feeBps: 500 };

      const unnamed = await ticketFor(ctx, terms, "not these terms", alice.address, 0, STAKE, { terms: hashOf(other) });
      await expect(markets.connect(alice).place(terms, unnamed.ticket, unnamed.signature, { value: STAKE }))
        .to.be.revertedWithCustomError(markets, "TermsMismatch")
        .withArgs(terms.market, hashOf(other));

      const elsewhere = { ...terms, market: marketOf("elsewhere") };
      const misfiled = await ticketFor(ctx, elsewhere, "terms of another market", alice.address, 0, STAKE, { market: terms.market });
      await expect(markets.connect(alice).place(elsewhere, misfiled.ticket, misfiled.signature, { value: STAKE }))
        .to.be.revertedWithCustomError(markets, "TermsMismatch")
        .withArgs(terms.market, hashOf(elsewhere));

      await bet(ctx, terms, "named", alice, 0, STAKE);

      const changed = await ticketFor(ctx, other, "other terms later", bob.address, 1, STAKE, { market: terms.market });
      await expect(markets.connect(bob).place(other, changed.ticket, changed.signature, { value: STAKE }))
        .to.be.revertedWithCustomError(markets, "TermsMismatch")
        .withArgs(terms.market, hashOf(other));

      // A later ticket brings the terms it names, as the first did: the limits are read from them.
      const later = await ticketFor(ctx, terms, "the same terms later", bob.address, 1, STAKE);
      await expect(markets.connect(bob).place(other, later.ticket, later.signature, { value: STAKE }))
        .to.be.revertedWithCustomError(markets, "TermsMismatch")
        .withArgs(terms.market, hashOf(terms));
      await expect(markets.connect(bob).place(terms, later.ticket, later.signature, { value: STAKE })).to.emit(markets, "Placed");
    });

    describe("input validation", () => {
      it("refuses a stake of nothing, and any amount but the ticket's", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const terms = await termsOf("amounts");

        const nothing = await ticketFor(ctx, terms, "nothing", alice.address, 0, 0n);
        await expect(markets.connect(alice).place(terms, nothing.ticket, nothing.signature)).to.be.revertedWithCustomError(markets, "ZeroAmount");

        const { ticket, signature } = await ticketFor(ctx, terms, "amount", alice.address, 0, STAKE);
        for (const sent of [0n, STAKE - 1n, STAKE + 1n]) {
          await expect(markets.connect(alice).place(terms, ticket, signature, { value: sent }))
            .to.be.revertedWithCustomError(markets, "WrongAmount")
            .withArgs(ticket.id, STAKE, sent);
        }

        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE })).to.emit(markets, "Placed");
      });

      it("refuses anybody but the bettor the ticket names", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice, bob } = ctx;
        const terms = await termsOf("bettor");
        const { ticket, signature } = await ticketFor(ctx, terms, "alice's", alice.address, 0, STAKE);

        await expect(markets.connect(bob).place(terms, ticket, signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "NotBettor")
          .withArgs(ticket.id, alice.address);
      });

      it("accepts a ticket in the same second it expires, and not one second after", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const terms = await termsOf("deadline", { closesAt: (await latest()) + HOUR });
        const deadline = (await latest()) + 30n;

        const late = await ticketFor(ctx, terms, "a second late", alice.address, 0, STAKE, { deadline });
        const onTime = await ticketFor(ctx, terms, "on the second", alice.address, 0, STAKE, { deadline: deadline + 1n });

        await time.setNextBlockTimestamp(deadline + 1n);
        await expect(markets.connect(alice).place(terms, late.ticket, late.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "TicketExpired")
          .withArgs(late.ticket.id, deadline);

        await time.setNextBlockTimestamp(deadline + 1n);
        await expect(markets.connect(alice).place(terms, onTime.ticket, onTime.signature, { value: STAKE })).to.emit(markets, "Placed");
      });

      it("refuses a ticket that would still be good for more than an hour", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const terms = await termsOf("long", { closesAt: (await latest()) + DAY });
        const at = (await latest()) + 10n;

        const tooLong = await ticketFor(ctx, terms, "an hour and a second", alice.address, 0, STAKE, { deadline: at + HOUR + 1n });
        await time.setNextBlockTimestamp(at);
        await expect(markets.connect(alice).place(terms, tooLong.ticket, tooLong.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "TicketTooLong")
          .withArgs(tooLong.ticket.id, at + HOUR + 1n);

        const hour = await ticketFor(ctx, terms, "an hour", alice.address, 0, STAKE, { deadline: at + 1n + HOUR });
        await time.setNextBlockTimestamp(at + 1n);
        await expect(markets.connect(alice).place(terms, hour.ticket, hour.signature, { value: STAKE })).to.emit(markets, "Placed");
      });

      it("places a ticket once, whatever became of its market", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, operator, alice } = ctx;
        const terms = await termsOf("once");
        const { ticket, signature } = await bet(ctx, terms, "once", alice, 0, STAKE);

        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "TicketUsed")
          .withArgs(ticket.id);

        await markets.connect(operator).cancel(terms.market);
        await markets.connect(alice).claim([ticket.id]);
        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "TicketUsed")
          .withArgs(ticket.id);
      });

      it("refuses terms out of their bounds, and takes them at their bounds", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const wrong: [string, Partial<Terms>][] = [
          ["one outcome", { outcomes: 1, minOutcomes: 1 }],
          ["seventeen outcomes", { outcomes: 17 }],
          ["one backed outcome is enough", { minOutcomes: 1 }],
          ["more backed outcomes than there are", { minOutcomes: 3 }],
          ["one bettor is enough", { minBettors: 1 }],
          ["a fee over 5%", { feeBps: 501 }],
          ["no stake", { maxStake: 0n }],
          ["nothing for a bettor", { maxPerBettor: 0n }],
          ["no pool", { maxPool: 0n }],
        ];

        for (const [i, [what, change]] of wrong.entries()) {
          const terms = await termsOf(`bounds ${i}`, change);
          const { ticket, signature } = await ticketFor(ctx, terms, `bounds ${i}`, alice.address, 0, STAKE);
          await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE }), what)
            .to.be.revertedWithCustomError(markets, "InvalidTerms")
            .withArgs(terms.market);
        }

        const at = (await latest()) + 10n;
        const far = await termsOf("a day and a second", { closesAt: at + DAY + 1n });
        const farTicket = await ticketFor(ctx, far, "a day and a second", alice.address, 0, STAKE);
        await time.setNextBlockTimestamp(at);
        await expect(markets.connect(alice).place(far, farTicket.ticket, farTicket.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidTerms")
          .withArgs(far.market);

        const widest = await termsOf("at every bound", { outcomes: 16, minOutcomes: 16, feeBps: 500, closesAt: at + 1n + DAY });
        const widestTicket = await ticketFor(ctx, widest, "at every bound", alice.address, 15, STAKE);
        await time.setNextBlockTimestamp(at + 1n);
        await expect(markets.connect(alice).place(widest, widestTicket.ticket, widestTicket.signature, { value: STAKE })).to.emit(markets, "MarketOpened");
      });

      it("takes no position from the second it closes, nor in a market resolved", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, operator, alice, bob } = ctx;
        const terms = await termsOf("closing");
        await bet(ctx, terms, "before the close", alice, 0, STAKE);

        const last = await ticketFor(ctx, terms, "the last second", bob.address, 1, STAKE);
        await time.setNextBlockTimestamp(terms.closesAt - 1n);
        await expect(markets.connect(bob).place(terms, last.ticket, last.signature, { value: STAKE })).to.emit(markets, "Placed");

        const after = await ticketFor(ctx, terms, "at the close", bob.address, 1, STAKE);
        await expect(markets.connect(bob).place(terms, after.ticket, after.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "MarketClosed")
          .withArgs(terms.market);

        const fresh = await termsOf("cancelled before its close", { closesAt: (await latest()) + HOUR });
        await bet(ctx, fresh, "in a market that is cancelled", alice, 0, STAKE);
        await markets.connect(operator).cancel(fresh.market);
        const resolved = await ticketFor(ctx, fresh, "after the cancel", bob.address, 1, STAKE);
        await expect(markets.connect(bob).place(fresh, resolved.ticket, resolved.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "MarketClosed")
          .withArgs(fresh.market);

        const late = await termsOf("opened late");
        const lateTicket = await ticketFor(ctx, late, "a first ticket after its close", alice.address, 0, STAKE);
        await time.setNextBlockTimestamp(late.closesAt);
        await expect(markets.connect(alice).place(late, lateTicket.ticket, lateTicket.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "MarketClosed")
          .withArgs(late.market);
        expect((await markets.marketOf(late.market)).state).to.equal(0n);
      });

      it("refuses an outcome the market does not have", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const terms = await termsOf("outcomes", { outcomes: 3 });
        const { ticket, signature } = await ticketFor(ctx, terms, "outcome 3", alice.address, 3, STAKE);

        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "OutcomeOutOfRange")
          .withArgs(terms.market, 3);
        await bet(ctx, terms, "outcome 2", alice, 2, STAKE);
      });

      it("holds a position, a bettor and the pool to the limits of the terms, and takes each at its limit", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice, bob, carol } = ctx;
        const terms = await termsOf("limits", { maxStake: 3n * NURA, maxPerBettor: 5n * NURA, maxPool: 8n * NURA });

        const large = await ticketFor(ctx, terms, "over a position", alice.address, 0, 3n * NURA + 1n);
        await expect(markets.connect(alice).place(terms, large.ticket, large.signature, { value: large.ticket.amount }))
          .to.be.revertedWithCustomError(markets, "StakeTooLarge")
          .withArgs(large.ticket.id, 3n * NURA + 1n, 3n * NURA);

        await bet(ctx, terms, "a position's most", alice, 0, 3n * NURA);
        await bet(ctx, terms, "a bettor's most", alice, 1, 2n * NURA);
        const more = await ticketFor(ctx, terms, "over a bettor", alice.address, 0, 1n);
        await expect(markets.connect(alice).place(terms, more.ticket, more.signature, { value: 1n }))
          .to.be.revertedWithCustomError(markets, "BettorLimit")
          .withArgs(more.ticket.id, 5n * NURA + 1n, 5n * NURA);

        await bet(ctx, terms, "the pool's most", bob, 1, 3n * NURA);
        const over = await ticketFor(ctx, terms, "over the pool", carol.address, 0, 1n);
        await expect(markets.connect(carol).place(terms, over.ticket, over.signature, { value: 1n }))
          .to.be.revertedWithCustomError(markets, "PoolLimit")
          .withArgs(terms.market, 8n * NURA + 1n, 8n * NURA);
      });
    });

    describe("domain binding", () => {
      it("refuses a ticket signed by anybody but an operator", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, admin, alice, outsider } = ctx;
        const terms = await termsOf("signers");

        for (const by of [outsider, admin, alice]) {
          const { ticket, signature } = await ticketFor(ctx, terms, `signed by ${by.address}`, alice.address, 0, STAKE, { by });
          await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE }))
            .to.be.revertedWithCustomError(markets, "InvalidSignature")
            .withArgs(ticket.id);
        }
      });

      it("refuses a signature over any other id, market, terms, bettor, outcome, amount or deadline", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice, bob } = ctx;
        const terms = await termsOf("signed");
        const { ticket, signature } = await ticketFor(ctx, terms, "signed", alice.address, 0, STAKE);
        const changes: [string, Partial<Ticket>, Signer][] = [
          ["id", { id: ticketOf("other") }, alice],
          ["market", { market: marketOf("other") }, alice],
          ["terms", { terms: hashOf({ ...terms, feeBps: 1 }) }, alice],
          ["bettor", { bettor: bob.address }, bob],
          ["outcome", { outcome: 1 }, alice],
          ["amount", { amount: STAKE - 1n }, alice],
          ["deadline", { deadline: ticket.deadline + 1n }, alice],
        ];

        for (const [field, change, from] of changes) {
          const forged = { ...ticket, ...change };
          await expect(markets.connect(from).place(terms, forged, signature, { value: forged.amount }), field)
            .to.be.revertedWithCustomError(markets, "InvalidSignature")
            .withArgs(forged.id);
        }

        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE })).to.emit(markets, "Placed");
      });

      it("refuses a ticket signed for another contract or another chain", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, admin, operator, alice } = ctx;
        const terms = await termsOf("domains");
        const other = await ethers.deployContract("ArcadeMarkets", [admin.address, operator.address, 0], admin);

        const forOther = await ticketFor(ctx, terms, "for the other", alice.address, 0, STAKE, { domain: await domainOf(other) });
        await expect(markets.connect(alice).place(terms, forOther.ticket, forOther.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");
        await expect(other.connect(alice).place(terms, forOther.ticket, forOther.signature, { value: STAKE })).to.emit(other, "Placed");

        const chainId = (await ethers.provider.getNetwork()).chainId;
        const forChain = await ticketFor(ctx, terms, "another chain", alice.address, 0, STAKE, { domain: await domainOf(markets, chainId + 1n) });
        await expect(markets.connect(alice).place(terms, forChain.ticket, forChain.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");
      });

      it("computes the digest an operator signs and the hash a ticket names its terms by", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, operator, alice } = ctx;
        const terms = await termsOf("digest", { outcomes: 9, feeBps: 250, minBettors: 3, minOutcomes: 3 });
        const { ticket, signature } = await ticketFor(ctx, terms, "digest", alice.address, 7, STAKE);

        expect(await markets.termsHash(terms)).to.equal(hashOf(terms));

        const digest = await markets.ticketDigest(ticket);
        expect(digest).to.equal(ethers.TypedDataEncoder.hash(await domainOf(markets), TICKET_TYPES, ticket));
        expect(ethers.recoverAddress(digest, signature)).to.equal(operator.address);
      });

      it("refuses a signature that is malformed or flipped to its other half", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, alice } = ctx;
        const terms = await termsOf("malformed");
        const { ticket, signature } = await ticketFor(ctx, terms, "malformed", alice.address, 0, STAKE);

        await expect(markets.connect(alice).place(terms, ticket, signature.slice(0, -2), { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");
        await expect(markets.connect(alice).place(terms, ticket, "0x", { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");

        // The same signature with s mirrored round the curve order recovers the same key, and
        // ECDSA refuses it so that a ticket cannot be placed under two signatures.
        const split = ethers.Signature.from(signature);
        const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
        const flipped = ethers.concat([split.r, ethers.toBeHex(n - BigInt(split.s), 32), split.v === 27 ? "0x1c" : "0x1b"]);
        await expect(markets.connect(alice).place(terms, ticket, flipped, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");

        await expect(markets.connect(alice).place(terms, ticket, signature, { value: STAKE })).to.emit(markets, "Placed");
      });

      it("stops an operator's tickets once it is replaced or its role taken, and takes any operator's", async () => {
        const ctx = await loadFixture(deploy);
        const { markets, admin, operator, alice, outsider } = ctx;
        const role = await markets.OPERATOR_ROLE();
        const terms = await termsOf("operators", { closesAt: (await latest()) + HOUR });
        const old = await ticketFor(ctx, terms, "old operator", alice.address, 0, STAKE);

        await markets.connect(admin).setOperator(outsider.address);
        await expect(markets.connect(alice).place(terms, old.ticket, old.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");
        await bet(ctx, terms, "new operator", alice, 0, STAKE, { by: outsider });

        await markets.connect(admin).grantRole(role, operator.address);
        await expect(markets.connect(alice).place(terms, old.ticket, old.signature, { value: STAKE })).to.emit(markets, "Placed");

        await markets.connect(admin).revokeRole(role, outsider.address);
        const revoked = await ticketFor(ctx, terms, "revoked", alice.address, 1, STAKE, { by: outsider });
        await expect(markets.connect(alice).place(terms, revoked.ticket, revoked.signature, { value: STAKE }))
          .to.be.revertedWithCustomError(markets, "InvalidSignature");
      });
    });
  });

  describe("settling", () => {
    it("pays the backers of the outcome that happened by their stakes, and the fee to the owner", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob, carol, dave, erin } = ctx;
      const terms = await termsOf("paid", { feeBps: 200 });
      const a = await bet(ctx, terms, "alice on 0", alice, 0, 1n * NURA);
      const b = await bet(ctx, terms, "bob on 0", bob, 0, 2n * NURA);
      const c = await bet(ctx, terms, "carol on 0", carol, 0, 3n * NURA);
      const d = await bet(ctx, terms, "dave on 1", dave, 1, 4n * NURA);
      const e = await bet(ctx, terms, "erin on 1", erin, 1, 5n * NURA);
      await closed(terms);

      const pool = 15n * NURA;
      const fee = (pool * 200n) / 10_000n;
      const settling = await markets.connect(operator).settle(terms.market, 0);
      const settledAt = await latest();
      await expect(settling).to.emit(markets, "Settled").withArgs(terms.market, 0, pool, fee, settledAt);

      const market = await markets.marketOf(terms.market);
      expect(market.state).to.equal(SETTLED);
      expect(market.winner).to.equal(0n);
      expect(market.claimableAt).to.equal(settledAt);
      expect(market.left).to.equal(pool - fee);
      expect(market.backingLeft).to.equal(6n * NURA);
      expect(await markets.fees()).to.equal(fee);
      expect(await markets.owed()).to.equal(pool - fee);
      await books(markets);

      const left = pool - fee;
      expect(await markets.payoutOf(a.ticket.id)).to.equal((left * 1n) / 6n);
      expect(await markets.payoutOf(d.ticket.id)).to.equal(0n);

      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal((left * 1n) / 6n);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal((left * 2n) / 6n);
      expect(await claimed(ctx, carol, [c.ticket.id])).to.equal((left * 3n) / 6n);

      for (const [loser, position] of [[dave, d], [erin, e]] as const) {
        await expect(markets.connect(loser).claim([position.ticket.id]))
          .to.be.revertedWithCustomError(markets, "NothingOwed")
          .withArgs(position.ticket.id);
      }

      const after = await markets.marketOf(terms.market);
      expect(after.left).to.equal(0n);
      expect(after.backingLeft).to.equal(0n);
      expect(await markets.owed()).to.equal(0n);
      expect(await balanceOf(markets)).to.equal(fee);
      await books(markets);
    });

    it("pays the last winner the exact remainder, so no unit is left, whatever order they claim in", async () => {
      for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
        const ctx = await loadFixture(deploy);
        const { markets, operator, alice, bob, carol, dave } = ctx;
        const terms = await termsOf("remainder");
        const winners = [
          await bet(ctx, terms, "one wei, alice", alice, 0, 1n),
          await bet(ctx, terms, "one wei, bob", bob, 0, 1n),
          await bet(ctx, terms, "one wei, carol", carol, 0, 1n),
        ];
        await bet(ctx, terms, "seven wei, dave", dave, 1, 7n);
        await closed(terms);
        await markets.connect(operator).settle(terms.market, 0);

        const bettors = [alice, bob, carol];
        const paid: bigint[] = [];
        for (const i of order) {
          paid.push(await claimed(ctx, bettors[i], [winners[i].ticket.id]));
        }

        expect(paid, order.join()).to.deep.equal([3n, 3n, 4n]);
        expect(await balanceOf(markets)).to.equal(0n);
        expect(await markets.owed()).to.equal(0n);
      }
    });

    it("refunds every stake, with no fee, when nobody backed the outcome that happened", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("nobody backed it", { outcomes: 3, feeBps: 500 });
      const a = await bet(ctx, terms, "alice on 0", alice, 0, 2n * NURA);
      const b = await bet(ctx, terms, "bob on 1", bob, 1, 3n * NURA);
      await closed(terms);

      await expect(markets.connect(operator).settle(terms.market, 2)).to.emit(markets, "Refunded").withArgs(terms.market, 2);
      expect((await markets.marketOf(terms.market)).state).to.equal(REFUNDED);
      expect(await markets.fees()).to.equal(0n);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(2n * NURA);

      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(2n * NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(3n * NURA);
      expect(await balanceOf(markets)).to.equal(0n);
      await books(markets);
    });

    it("refunds every stake when fewer people bet than the terms ask for", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("too few people", { minBettors: 3, feeBps: 100 });
      const a = await bet(ctx, terms, "alice on 0", alice, 0, 2n * NURA);
      await bet(ctx, terms, "alice on 1", alice, 1, 1n * NURA);
      const b = await bet(ctx, terms, "bob on 1", bob, 1, 3n * NURA);
      await closed(terms);

      await expect(markets.connect(operator).settle(terms.market, 0)).to.emit(markets, "Refunded");
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(3n * NURA);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(2n * NURA);
      expect(await markets.fees()).to.equal(0n);
    });

    it("refunds every stake when fewer outcomes were backed than the terms ask for", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("one outcome backed", { outcomes: 4, minOutcomes: 2 });
      const a = await bet(ctx, terms, "alice on 3", alice, 3, 2n * NURA);
      const b = await bet(ctx, terms, "bob on 3", bob, 3, 3n * NURA);
      await closed(terms);

      await expect(markets.connect(operator).settle(terms.market, 3)).to.emit(markets, "Refunded").withArgs(terms.market, 3);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(2n * NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(3n * NURA);
    });

    it("settles only after the close, for the operator alone, once, with an outcome the market has", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob, outsider } = ctx;
      const terms = await termsOf("settle rules");
      await bet(ctx, terms, "alice on 0", alice, 0, STAKE);
      await bet(ctx, terms, "bob on 1", bob, 1, STAKE);

      await time.setNextBlockTimestamp(terms.closesAt - 1n);
      await expect(markets.connect(operator).settle(terms.market, 0))
        .to.be.revertedWithCustomError(markets, "MarketOpen")
        .withArgs(terms.market);

      await closed(terms);
      await expect(markets.connect(outsider).settle(terms.market, 0)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(operator).settle(terms.market, 2))
        .to.be.revertedWithCustomError(markets, "OutcomeOutOfRange")
        .withArgs(terms.market, 2);
      await expect(markets.connect(operator).settle(marketOf("never"), 0))
        .to.be.revertedWithCustomError(markets, "UnknownMarket")
        .withArgs(marketOf("never"));

      await markets.connect(operator).settle(terms.market, 1);
      await expect(markets.connect(operator).settle(terms.market, 0))
        .to.be.revertedWithCustomError(markets, "MarketResolved")
        .withArgs(terms.market, SETTLED);
      await expect(markets.connect(operator).cancel(terms.market))
        .to.be.revertedWithCustomError(markets, "MarketResolved")
        .withArgs(terms.market, SETTLED);
      await time.increase(WEEK);
      await expect(markets.connect(outsider).expire(terms.market))
        .to.be.revertedWithCustomError(markets, "MarketResolved")
        .withArgs(terms.market, SETTLED);
    });
  });

  describe("cancelling and expiring", () => {
    it("cancels an open market for the operator alone, before or after its close, and gives every stake back", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob, outsider } = ctx;
      const early = await termsOf("cancelled early", { closesAt: (await latest()) + HOUR, feeBps: 500 });
      const a = await bet(ctx, early, "alice early", alice, 0, 2n * NURA);
      const b = await bet(ctx, early, "bob early", bob, 1, 3n * NURA);

      await expect(markets.connect(outsider).cancel(early.market)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(operator).cancel(early.market)).to.emit(markets, "Cancelled").withArgs(early.market);
      expect((await markets.marketOf(early.market)).state).to.equal(CANCELLED);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(2n * NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(3n * NURA);

      const late = await termsOf("cancelled after its close");
      const c = await bet(ctx, late, "alice late", alice, 0, STAKE);
      await closed(late);
      await markets.connect(operator).cancel(late.market);
      expect(await claimed(ctx, alice, [c.ticket.id])).to.equal(STAKE);
      expect(await markets.fees()).to.equal(0n);
      await books(markets);
    });

    it("lets anybody expire a market nobody settled a week after its close, and not a second before", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, alice, bob, outsider } = ctx;
      const terms = await termsOf("forgotten");
      const a = await bet(ctx, terms, "alice on 0", alice, 0, 2n * NURA);
      const b = await bet(ctx, terms, "bob on 1", bob, 1, 3n * NURA);
      const at = terms.closesAt + WEEK;

      // Sent with its gas named, so the refusal is mined at that second rather than refused in the estimate.
      await time.setNextBlockTimestamp(at - 1n);
      await expect(markets.connect(outsider).expire(terms.market, { gasLimit: 200_000n }))
        .to.be.revertedWithCustomError(markets, "TooEarly")
        .withArgs(terms.market, at);
      await expect(markets.connect(outsider).expire(marketOf("never placed")))
        .to.be.revertedWithCustomError(markets, "UnknownMarket");

      await expect(markets.connect(outsider).expire(terms.market)).to.emit(markets, "Expired").withArgs(terms.market);
      expect((await markets.marketOf(terms.market)).state).to.equal(EXPIRED);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(2n * NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(3n * NURA);
      await books(markets);
    });
  });

  describe("claims", () => {
    it("pays several positions, in several markets, in one call, and marks each", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const won = await termsOf("won");
      const off = await termsOf("called off");
      const w1 = await bet(ctx, won, "alice won once", alice, 0, 1n * NURA);
      const w2 = await bet(ctx, won, "alice won twice", alice, 0, 2n * NURA);
      await bet(ctx, won, "bob lost", bob, 1, 3n * NURA);
      const r1 = await bet(ctx, off, "alice called off", alice, 0, 4n * NURA);
      await bet(ctx, off, "bob called off", bob, 1, 4n * NURA);
      await closed(won);
      await markets.connect(operator).settle(won.market, 0);
      await markets.connect(operator).cancel(off.market);

      const ids = [w1.ticket.id, w2.ticket.id, r1.ticket.id];
      const tx = markets.connect(alice).claim(ids);
      await expect(tx).to.emit(markets, "Claimed").withArgs(w1.ticket.id, alice.address, 2n * NURA);
      await expect(tx).to.emit(markets, "Claimed").withArgs(w2.ticket.id, alice.address, 4n * NURA);
      await expect(tx).to.emit(markets, "Claimed").withArgs(r1.ticket.id, alice.address, 4n * NURA);

      for (const id of ids) {
        expect((await markets.positionOf(id)).claimed).to.equal(true);
        expect(await markets.payoutOf(id)).to.equal(0n);
      }
      await books(markets);
    });

    it("refuses an empty list, a ticket never placed, somebody else's, one claimed, and one whose market is open", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("refused claims");
      const a = await bet(ctx, terms, "alice", alice, 0, STAKE);
      await bet(ctx, terms, "bob", bob, 1, STAKE);

      await expect(markets.connect(alice).claim([])).to.be.revertedWithCustomError(markets, "NoTickets");
      await expect(markets.connect(alice).claim([ticketOf("never")]))
        .to.be.revertedWithCustomError(markets, "UnknownTicket")
        .withArgs(ticketOf("never"));
      await expect(markets.connect(alice).claim([a.ticket.id]))
        .to.be.revertedWithCustomError(markets, "MarketOpen")
        .withArgs(terms.market);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(0n);

      await markets.connect(operator).cancel(terms.market);
      await expect(markets.connect(bob).claim([a.ticket.id]))
        .to.be.revertedWithCustomError(markets, "NotBettor")
        .withArgs(a.ticket.id, alice.address);
      await markets.connect(alice).claim([a.ticket.id]);
      await expect(markets.connect(alice).claim([a.ticket.id]))
        .to.be.revertedWithCustomError(markets, "AlreadyClaimed")
        .withArgs(a.ticket.id);
    });

    it("pays nothing for a list that holds a losing position or a position twice", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("mixed list");
      const won = await bet(ctx, terms, "alice won", alice, 0, STAKE);
      const lost = await bet(ctx, terms, "alice lost", alice, 1, STAKE);
      await bet(ctx, terms, "bob", bob, 1, STAKE);
      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);

      await expect(markets.connect(alice).claim([won.ticket.id, lost.ticket.id]))
        .to.be.revertedWithCustomError(markets, "NothingOwed")
        .withArgs(lost.ticket.id);
      await expect(markets.connect(alice).claim([won.ticket.id, won.ticket.id]))
        .to.be.revertedWithCustomError(markets, "AlreadyClaimed")
        .withArgs(won.ticket.id);

      expect((await markets.positionOf(won.ticket.id)).claimed).to.equal(false);
      expect(await claimed(ctx, alice, [won.ticket.id])).to.equal(3n * STAKE);
    });

    it("says what claiming each position would pay, and nothing once it is claimed", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob, carol } = ctx;
      const terms = await termsOf("payouts", { feeBps: 500 });
      const a = await bet(ctx, terms, "alice", alice, 0, 1n * NURA);
      const b = await bet(ctx, terms, "bob", bob, 0, 2n * NURA);
      const c = await bet(ctx, terms, "carol", carol, 1, 7n * NURA);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(0n);
      expect(await markets.payoutOf(ticketOf("never"))).to.equal(0n);

      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);
      const left = 10n * NURA - (10n * NURA * 500n) / 10_000n;

      expect(await markets.payoutOf(a.ticket.id)).to.equal(left / 3n);
      expect(await markets.payoutOf(c.ticket.id)).to.equal(0n);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(left / 3n);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(0n);
      expect(await markets.payoutOf(b.ticket.id)).to.equal(left - left / 3n);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(left - left / 3n);
    });
  });

  describe("disputes", () => {
    /** Two bettors on two outcomes with a 5% fee, settled for outcome 0 under the dispute window. */
    async function settledUnderWindow(ctx: Ctx) {
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("disputed", { feeBps: 500 });
      const a = await bet(ctx, terms, "alice on 0", alice, 0, 10n * NURA);
      const b = await bet(ctx, terms, "bob on 1", bob, 1, 10n * NURA);
      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);

      return { terms, a, b, claimableAt: (await markets.marketOf(terms.market)).claimableAt };
    }

    it("holds a settled market's winners until its window has passed, and says what they will be paid", async () => {
      const ctx = await loadFixture(deployWithWindow);
      const { markets, alice } = ctx;
      const { terms, a, claimableAt } = await settledUnderWindow(ctx);

      expect(claimableAt).to.equal((await latest()) + DISPUTE);
      expect(await markets.payoutOf(a.ticket.id)).to.equal(19n * NURA);

      // Sent with its gas named, so the refusal is mined at that second rather than refused in the estimate.
      await time.setNextBlockTimestamp(claimableAt - 1n);
      await expect(markets.connect(alice).claim([a.ticket.id], { gasLimit: 200_000n }))
        .to.be.revertedWithCustomError(markets, "NotYetClaimable")
        .withArgs(terms.market, claimableAt);

      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(19n * NURA);
    });

    it("gives every stake back at once from a market that refunds, whatever the window", async () => {
      const ctx = await loadFixture(deployWithWindow);
      const { markets, operator, alice, bob } = ctx;
      const cancelled = await termsOf("cancelled under a window");
      const a = await bet(ctx, cancelled, "alice cancelled", alice, 0, NURA);
      await markets.connect(operator).cancel(cancelled.market);
      const unbacked = await termsOf("nobody backed it under a window", { outcomes: 3 });
      const b = await bet(ctx, unbacked, "bob on 0", bob, 0, NURA);
      await bet(ctx, unbacked, "alice on 1", alice, 1, NURA);
      await closed(unbacked);
      await markets.connect(operator).settle(unbacked.market, 2);

      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(NURA);
    });

    it("lets the owner alone overturn a settlement in its window, giving every stake and the fee back", async () => {
      const ctx = await loadFixture(deployWithWindow);
      const { markets, admin, operator, alice, bob, outsider } = ctx;
      const { terms, a, b } = await settledUnderWindow(ctx);
      expect(await markets.fees()).to.equal(NURA);

      for (const by of [operator, outsider]) {
        await expect(markets.connect(by).overturn(terms.market)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      }
      await expect(markets.connect(admin).overturn(terms.market)).to.emit(markets, "Overturned").withArgs(terms.market);

      expect((await markets.marketOf(terms.market)).state).to.equal(CANCELLED);
      expect(await markets.fees()).to.equal(0n);
      expect(await markets.owed()).to.equal(20n * NURA);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(10n * NURA);
      expect(await claimed(ctx, bob, [b.ticket.id])).to.equal(10n * NURA);
      await books(markets);
    });

    it("overturns nothing after its window or not settled, and a market whose fee was withdrawn once it is put back", async () => {
      const ctx = await loadFixture(deployWithWindow);
      const { markets, admin, operator, alice, bob } = ctx;
      const { terms } = await settledUnderWindow(ctx);

      await markets.connect(admin).withdrawFees(admin.address, NURA);
      await expect(markets.connect(admin).overturn(terms.market))
        .to.be.revertedWithCustomError(markets, "InsufficientFees")
        .withArgs(0n, NURA);
      await expect(markets.connect(admin).fund()).to.be.revertedWithCustomError(markets, "ZeroAmount");
      await expect(markets.connect(alice).fund({ value: NURA })).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(admin).fund({ value: NURA })).to.emit(markets, "Funded").withArgs(admin.address, NURA);
      await expect(markets.connect(admin).overturn(terms.market)).to.emit(markets, "Overturned");
      await expect(markets.connect(admin).overturn(terms.market))
        .to.be.revertedWithCustomError(markets, "NotSettled")
        .withArgs(terms.market, CANCELLED);

      const later = await termsOf("past its window");
      await bet(ctx, later, "alice later", alice, 0, NURA);
      await bet(ctx, later, "bob later", bob, 1, NURA);
      await closed(later);
      await markets.connect(operator).settle(later.market, 0);
      const at = (await markets.marketOf(later.market)).claimableAt;
      await time.setNextBlockTimestamp(at);
      await expect(markets.connect(admin).overturn(later.market, { gasLimit: 200_000n }))
        .to.be.revertedWithCustomError(markets, "DisputeClosed")
        .withArgs(later.market, at);

      const open = await termsOf("still open", { closesAt: (await latest()) + HOUR });
      await bet(ctx, open, "alice open", alice, 0, NURA);
      await expect(markets.connect(admin).overturn(open.market))
        .to.be.revertedWithCustomError(markets, "NotSettled")
        .withArgs(open.market, OPEN);
      await books(markets);
    });

    it("lets the owner alone set the window, for markets settled from then on", async () => {
      const ctx = await loadFixture(deployWithWindow);
      const { markets, admin, operator, alice, bob } = ctx;
      const terms = await termsOf("window moved");
      const a = await bet(ctx, terms, "alice on 0", alice, 0, NURA);
      await bet(ctx, terms, "bob on 1", bob, 1, NURA);

      await expect(markets.connect(operator).setDisputeWindow(0)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(admin).setDisputeWindow(DAY + 1n))
        .to.be.revertedWithCustomError(markets, "DisputeWindowTooLong")
        .withArgs(DAY + 1n);
      await expect(markets.connect(admin).setDisputeWindow(0)).to.emit(markets, "DisputeWindowChanged").withArgs(DISPUTE, 0);

      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);
      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(2n * NURA);
    });
  });

  describe("the owner", () => {
    it("sends fees to the owner's choice, and never a stake, a share or a refund", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, admin, operator, alice, bob, outsider } = ctx;
      const terms = await termsOf("fees", { feeBps: 500 });
      const a = await bet(ctx, terms, "alice", alice, 0, 10n * NURA);
      await bet(ctx, terms, "bob", bob, 1, 10n * NURA);
      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);
      const fee = NURA;

      await expect(markets.connect(admin).withdrawFees(outsider.address, fee + 1n))
        .to.be.revertedWithCustomError(markets, "InsufficientFees")
        .withArgs(fee, fee + 1n);

      const before = await balanceOf(outsider.address);
      await expect(markets.connect(admin).withdrawFees(outsider.address, fee)).to.emit(markets, "FeesWithdrawn").withArgs(outsider.address, fee);
      expect(await balanceOf(outsider.address)).to.equal(before + fee);
      expect(await markets.fees()).to.equal(0n);

      expect(await claimed(ctx, alice, [a.ticket.id])).to.equal(19n * NURA);
      expect(await balanceOf(markets)).to.equal(0n);
    });

    it("refuses a withdrawal of nothing, to nobody, or by anybody but the owner", async () => {
      const { markets, admin, operator, outsider } = await loadFixture(deploy);

      await expect(markets.connect(admin).withdrawFees(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(markets, "ZeroAddress");
      await expect(markets.connect(admin).withdrawFees(outsider.address, 0n)).to.be.revertedWithCustomError(markets, "ZeroAmount");
      await expect(markets.connect(operator).withdrawFees(operator.address, 1n)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
    });

    it("moves the operator in one call, for the owner alone, and the old one settles nothing more", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, admin, operator, alice, bob, outsider } = ctx;
      const role = await markets.OPERATOR_ROLE();
      const terms = await termsOf("handed over");
      await bet(ctx, terms, "alice", alice, 0, STAKE);
      await bet(ctx, terms, "bob", bob, 1, STAKE);
      await closed(terms);

      await expect(markets.connect(outsider).setOperator(outsider.address)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(admin).setOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(markets, "ZeroAddress");
      await expect(markets.connect(admin).setOperator(outsider.address)).to.emit(markets, "OperatorChanged").withArgs(operator.address, outsider.address);

      expect(await markets.operator()).to.equal(outsider.address);
      expect(await markets.hasRole(role, operator.address)).to.equal(false);
      await expect(markets.connect(operator).settle(terms.market, 0)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(operator).cancel(terms.market)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(outsider).settle(terms.market, 0)).to.emit(markets, "Settled");
    });

    it("stops new positions while paused, and nothing else", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, admin, operator, alice, bob, outsider } = ctx;
      const settled = await termsOf("settled while paused");
      const won = await bet(ctx, settled, "alice", alice, 0, STAKE);
      await bet(ctx, settled, "bob", bob, 1, STAKE);
      const cancelled = await termsOf("cancelled while paused", { closesAt: (await latest()) + HOUR });
      const back = await bet(ctx, cancelled, "alice cancelled", alice, 0, STAKE);
      const expired = await termsOf("expired while paused");
      const old = await bet(ctx, expired, "alice expired", alice, 0, STAKE);
      const { ticket, signature } = await ticketFor(ctx, cancelled, "during the pause", bob.address, 1, STAKE);

      await expect(markets.connect(outsider).pause()).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await markets.connect(admin).pause();
      await expect(markets.connect(bob).place(cancelled, ticket, signature, { value: STAKE })).to.be.revertedWithCustomError(markets, "EnforcedPause");

      await closed(settled);
      await markets.connect(operator).settle(settled.market, 0);
      await markets.connect(operator).cancel(cancelled.market);
      await time.increase(WEEK);
      await markets.connect(outsider).expire(expired.market);
      expect(await claimed(ctx, alice, [won.ticket.id, back.ticket.id, old.ticket.id])).to.equal(4n * STAKE);

      await markets.connect(admin).unpause();
      const fresh = await termsOf("after the pause");
      await bet(ctx, fresh, "after the pause", alice, 0, STAKE);
    });

    it("hands the contract to a new owner only once they accept, with the pauser role", async () => {
      const { markets, admin, alice, outsider } = await loadFixture(deploy);
      const ownerRole = await markets.DEFAULT_ADMIN_ROLE();
      const pauser = await markets.PAUSER_ROLE();

      await expect(markets.connect(alice).beginDefaultAdminTransfer(alice.address)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(admin).grantRole(ownerRole, outsider.address)).to.be.revertedWithCustomError(markets, "AccessControlEnforcedDefaultAdminRules");

      await markets.connect(admin).beginDefaultAdminTransfer(outsider.address);
      await markets.connect(outsider).acceptDefaultAdminTransfer();

      expect(await markets.owner()).to.equal(outsider.address);
      expect(await markets.hasRole(pauser, admin.address)).to.equal(false);
      expect(await markets.hasRole(pauser, outsider.address)).to.equal(true);
      await expect(markets.connect(admin).pause()).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(admin).withdrawFees(admin.address, 1n)).to.be.revertedWithCustomError(markets, "AccessControlUnauthorizedAccount");
      await expect(markets.connect(outsider).pause()).to.emit(markets, "Paused");
    });

    it("refuses a plain transfer, so no coin arrives that is nobody's", async () => {
      const { markets, alice } = await loadFixture(deploy);

      await expect(alice.sendTransaction({ to: await markets.getAddress(), value: STAKE })).to.be.revert(ethers);
      expect(await balanceOf(markets)).to.equal(0n);
    });
  });

  describe("reentrancy", () => {
    /** A cancelled market in which the actor holds two positions and alice one. */
    async function actorWithTwo(ctx: Awaited<ReturnType<typeof deployActor>>) {
      const { markets, operator, alice, actor } = ctx;
      const address = await actor.getAddress();
      const terms = await termsOf("the actor's");
      const positions: string[] = [];

      for (const label of ["actor one", "actor two"]) {
        const { ticket, signature } = await ticketFor(ctx, terms, label, address, 0, STAKE);
        await actor.place(terms, ticket, signature, { value: STAKE });
        positions.push(ticket.id);
      }
      await bet(ctx, terms, "alice beside the actor", alice, 1, STAKE);
      await markets.connect(operator).cancel(terms.market);

      return { address, positions };
    }

    it("pays a claim re-entered from its receiver exactly once", async () => {
      const ctx = await loadFixture(deployActor);
      const { markets, actor } = ctx;
      const { address, positions } = await actorWithTwo(ctx);

      await actor.prepareClaim([positions[1]]);
      await actor.setMode(2);
      await actor.claim([positions[0]]);

      expect(await actor.innerCallFailed()).to.equal(true);
      expect(await actor.receiveCount()).to.equal(1n);
      expect(await balanceOf(address)).to.equal(STAKE);
      expect((await markets.positionOf(positions[1])).claimed).to.equal(false);
      await books(markets);

      await actor.claim([positions[1]]);
      expect(await balanceOf(address)).to.equal(2n * STAKE);
      await books(markets);
    });

    it("keeps a position unclaimed when its receiver refuses the payment", async () => {
      const ctx = await loadFixture(deployActor);
      const { markets, actor } = ctx;
      const { positions } = await actorWithTwo(ctx);

      await actor.setMode(1);
      await expect(actor.claim(positions)).to.be.revertedWith("no thanks");
      expect((await markets.positionOf(positions[0])).claimed).to.equal(false);
      expect(await markets.owed()).to.equal(3n * STAKE);

      await actor.setMode(0);
      await actor.claim(positions);
      expect(await markets.owed()).to.equal(STAKE);
    });

    it("takes a position placed from inside a claim as a position of its own", async () => {
      const ctx = await loadFixture(deployActor);
      const { markets, actor } = ctx;
      const { address, positions } = await actorWithTwo(ctx);
      const next = await termsOf("placed inside a claim", { closesAt: (await latest()) + HOUR });
      const { ticket, signature } = await ticketFor(ctx, next, "inside the claim", address, 0, STAKE);
      await actor.preparePlace(next, ticket, signature);

      await actor.setMode(3);
      await actor.claim(positions);

      expect(await actor.innerCallFailed()).to.equal(false);
      expect((await markets.positionOf(ticket.id)).bettor).to.equal(address);
      expect(await balanceOf(address)).to.equal(STAKE);
      expect(await markets.owed()).to.equal(2n * STAKE);
      await books(markets);
    });

    it("keeps the fees when their receiver refuses a withdrawal", async () => {
      const ctx = await loadFixture(deployActor);
      const { markets, admin, operator, alice, bob, actor } = ctx;
      const terms = await termsOf("refused fees", { feeBps: 500 });
      await bet(ctx, terms, "alice", alice, 0, 10n * NURA);
      await bet(ctx, terms, "bob", bob, 1, 10n * NURA);
      await closed(terms);
      await markets.connect(operator).settle(terms.market, 0);

      await actor.setMode(1);
      await expect(markets.connect(admin).withdrawFees(await actor.getAddress(), NURA)).to.be.revertedWith("no thanks");
      expect(await markets.fees()).to.equal(NURA);
    });
  });

  describe("accounting", () => {
    it("stays solvent to the wei across markets, outcomes, fees, refunds and claims in any order", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob, carol, dave, erin } = ctx;
      const people = [alice, bob, carol, dave, erin];
      const stakes = [1n, 7n, 333n, ethers.parseEther("0.123456789"), ethers.parseEther("50") + 13n, ethers.parseEther("499.999999999999999")];
      const fees = [0, 1, 99, 250, 499, 500];
      const placed: { id: string; from: Signer; market: number; outcome: number }[] = [];
      const terms: Terms[] = [];

      for (let m = 0; m < fees.length; ++m) {
        terms.push(await termsOf(`books ${m}`, { outcomes: 2 + (m % 3), feeBps: fees[m], closesAt: (await latest()) + HOUR }));
      }
      for (let i = 0; i < 36; ++i) {
        const m = i % terms.length;
        const outcome = (i * 7) % terms[m].outcomes;
        const from = people[(i * 3) % people.length];
        const { ticket } = await bet(ctx, terms[m], `books position ${i}`, from, outcome, stakes[(i * 5) % stakes.length]);
        placed.push({ id: ticket.id, from, market: m, outcome });
        await books(markets);
      }

      await time.increase(HOUR);
      const resolved = await Promise.all(terms.map(async (t, m) => {
        if (m === 4) {
          await markets.connect(operator).cancel(t.market);
        } else {
          await markets.connect(operator).settle(t.market, m % t.outcomes);
        }
        await books(markets);
        return (await markets.marketOf(t.market)).state;
      }));
      expect(resolved).to.include(SETTLED);

      for (const position of [...placed].reverse()) {
        if ((await markets.payoutOf(position.id)) === 0n) {
          continue;
        }
        await markets.connect(position.from).claim([position.id]);
        await books(markets);
      }

      expect(await markets.owed()).to.equal(0n);
      expect(await balanceOf(markets)).to.equal(await markets.fees());
    });
  });

  (measuring ? describe : describe.skip)("gas", () => {
    it("places, settles and claims within bounds", async () => {
      const ctx = await loadFixture(deploy);
      const { markets, operator, alice, bob } = ctx;
      const terms = await termsOf("gas", { feeBps: 100 });

      const first = await (await bet(ctx, terms, "gas first", alice, 0, STAKE)).tx.wait();
      const later = await (await bet(ctx, terms, "gas later", bob, 1, STAKE)).tx.wait();
      const a2 = await bet(ctx, terms, "gas alice again", alice, 0, STAKE);
      const a3 = await bet(ctx, terms, "gas alice third", alice, 0, STAKE);
      await closed(terms);
      const settle = await (await markets.connect(operator).settle(terms.market, 0)).wait();
      const one = await (await markets.connect(alice).claim([ticketOf("gas first")])).wait();
      const two = await (await markets.connect(alice).claim([a2.ticket.id, a3.ticket.id])).wait();

      console.log(`      place ${first!.gasUsed} (opening its market), ${later!.gasUsed} after; settle ${settle!.gasUsed}; claim one ${one!.gasUsed}, two ${two!.gasUsed}`);
      expect(first!.gasUsed).to.be.lessThan(320_000n);
      expect(later!.gasUsed).to.be.lessThan(220_000n);
      expect(settle!.gasUsed).to.be.lessThan(140_000n);
      expect(one!.gasUsed).to.be.lessThan(80_000n);
      expect(two!.gasUsed).to.be.lessThan(90_000n);
    });
  });
});
