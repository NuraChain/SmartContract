import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

const REFERRAL = 1_000;
const PRICE = ethers.parseEther("12");
const HALF_HOUR = 1800n;
const DAY = 24n * 3600n;
const CUT = (PRICE * BigInt(REFERRAL)) / 10_000n;

const QUOTE_TYPES = {
  Quote: [
    { name: "order", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "item", type: "bytes32" },
    { name: "price", type: "uint256" },
    { name: "referrer", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
};

const orderOf = (label: string) => ethers.id(`order:${label}`);
const itemOf = (name: string) => ethers.id(`item:${name}`);

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

type Quote = {
  order: string;
  buyer: string;
  item: string;
  price: bigint;
  referrer: string;
  deadline: bigint;
};

type Domain = { name: string; version: string; chainId: bigint; verifyingContract: string };

type Terms = Partial<Quote> & { by?: Signer; domain?: Domain };

// Fixtures must be named module-scope functions: loadFixture keys its snapshot on the
// function reference, so an inline arrow would re-run the setup every time instead of
// reverting to a snapshot.

async function deploy() {
  const [admin, seller, buyer, inviter, outsider] = await ethers.getSigners();
  const shop = await ethers.deployContract("ArcadeShop", [admin.address, seller.address, REFERRAL], admin);

  return { shop, admin, seller, buyer, inviter, outsider };
}

/** The shop, and a contract wallet that buys, brings buyers in, and misbehaves when it is paid. */
async function deployActor() {
  const ctx = await deploy();
  const actor = await ethers.deployContract("ShopActor", [await ctx.shop.getAddress()], ctx.admin);

  return { ...ctx, actor };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;
type Shop = Ctx["shop"];

async function latest() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function domainOf(shop: Shop, chainId?: bigint): Promise<Domain> {
  return {
    name: "ArcadeShop",
    version: "1",
    chainId: chainId ?? (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await shop.getAddress(),
  };
}

/** One order as the Arcade server prices it, signed with the seller's key unless `by` says otherwise. */
async function quoteOf(ctx: Ctx, label: string, terms: Terms = {}) {
  const quote: Quote = {
    order: terms.order ?? orderOf(label),
    buyer: terms.buyer ?? ctx.buyer.address,
    item: terms.item ?? itemOf("dice.nura-glow"),
    price: terms.price ?? PRICE,
    referrer: terms.referrer ?? ethers.ZeroAddress,
    deadline: terms.deadline ?? (await latest()) + HALF_HOUR,
  };
  const signature = await (terms.by ?? ctx.seller).signTypedData(terms.domain ?? (await domainOf(ctx.shop)), QUOTE_TYPES, quote);

  return { quote, signature };
}

/** `from`, the buyer unless a test says otherwise, pays one order at its price. */
async function sell(ctx: Ctx, label: string, terms: Terms = {}, from?: Signer) {
  const { quote, signature } = await quoteOf(ctx, label, terms);
  const tx = await ctx.shop.connect(from ?? ctx.buyer).buy(quote, signature, { value: quote.price });

  return { quote, signature, tx };
}

async function gasCostOf(tx: { wait(): Promise<{ gasUsed: bigint; gasPrice: bigint } | null> }) {
  const receipt = await tx.wait();
  return receipt!.gasUsed * receipt!.gasPrice;
}

async function balanceOf(address: string | { getAddress(): Promise<string> }) {
  return ethers.provider.getBalance(typeof address === "string" ? address : await address.getAddress());
}

describe("ArcadeShop", () => {
  describe("deployment", () => {
    it("stores the seller, the inviters' share and the roles", async () => {
      const { shop, admin, seller } = await loadFixture(deploy);

      expect(await shop.seller()).to.equal(seller.address);
      expect(await shop.referralBps()).to.equal(REFERRAL);
      expect(await shop.defaultAdmin()).to.equal(admin.address);
      expect(await shop.hasRole(await shop.PAUSER_ROLE(), admin.address)).to.equal(true);
      expect(await shop.hasRole(await shop.SELLER_ROLE(), seller.address)).to.equal(true);
      expect(await shop.hasRole(await shop.SELLER_ROLE(), admin.address)).to.equal(false);
      expect(await shop.revenue()).to.equal(0n);
      expect(await shop.totalEarnings()).to.equal(0n);

      const deployed = shop.deploymentTransaction()!;
      await expect(deployed).to.emit(shop, "SellerChanged").withArgs(ethers.ZeroAddress, seller.address);
      await expect(deployed).to.emit(shop, "ReferralBpsChanged").withArgs(0, REFERRAL);
    });

    it("refuses a zero admin or seller and a share over 30%, and takes nothing and 30%", async () => {
      const { admin, seller } = await loadFixture(deploy);
      const factory = await ethers.getContractFactory("ArcadeShop");

      await expect(factory.deploy(ethers.ZeroAddress, seller.address, REFERRAL))
        .to.be.revertedWithCustomError(factory, "AccessControlInvalidDefaultAdmin")
        .withArgs(ethers.ZeroAddress);
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, REFERRAL))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, seller.address, 3_001))
        .to.be.revertedWithCustomError(factory, "ReferralBpsOutOfRange")
        .withArgs(3_001);

      expect(await (await factory.deploy(admin.address, seller.address, 0)).referralBps()).to.equal(0);
      expect(await (await factory.deploy(admin.address, seller.address, 3_000)).referralBps()).to.equal(3_000);
    });
  });

  describe("buying", () => {
    it("records a sale, keeps its price as revenue and says what was bought", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, buyer } = ctx;
      const before = await balanceOf(buyer.address);

      const { quote, tx } = await sell(ctx, "plain");
      const cost = await gasCostOf(tx);

      await expect(tx).to.emit(shop, "Bought").withArgs(quote.order, buyer.address, quote.item, PRICE, ethers.ZeroAddress, 0n);
      const sale = await shop.saleOf(quote.order);
      expect(sale.buyer).to.equal(buyer.address);
      expect(sale.paidAt).to.equal(await latest());
      expect(sale.refunded).to.equal(false);
      expect(sale.referrer).to.equal(ethers.ZeroAddress);
      expect(sale.price).to.equal(PRICE);
      expect(sale.cut).to.equal(0n);
      expect(await shop.revenue()).to.equal(PRICE);
      expect(await shop.totalEarnings()).to.equal(0n);
      expect(await balanceOf(shop)).to.equal(PRICE);
      expect(await balanceOf(buyer.address)).to.equal(before - PRICE - cost);
      expect(await shop.solvent()).to.equal(true);
    });

    it("credits the inviter their share and the owner the rest", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, buyer, inviter } = ctx;

      const { quote, tx } = await sell(ctx, "invited", { referrer: inviter.address });

      await expect(tx).to.emit(shop, "Bought").withArgs(quote.order, buyer.address, quote.item, PRICE, inviter.address, CUT);
      expect((await shop.saleOf(quote.order)).cut).to.equal(CUT);
      expect(await shop.earnings(inviter.address)).to.equal(CUT);
      expect(await shop.totalEarnings()).to.equal(CUT);
      expect(await shop.revenue()).to.equal(PRICE - CUT);
      expect(await shop.solvent()).to.equal(true);
    });

    it("gives no share to a buyer who names themselves, and none while the share is nothing", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, inviter } = ctx;

      const self = await sell(ctx, "self", { referrer: buyer.address });
      await expect(self.tx).to.emit(shop, "Bought").withArgs(self.quote.order, buyer.address, self.quote.item, PRICE, ethers.ZeroAddress, 0n);
      expect((await shop.saleOf(self.quote.order)).referrer).to.equal(ethers.ZeroAddress);
      expect(await shop.earnings(buyer.address)).to.equal(0n);

      await shop.connect(admin).setReferralBps(0);
      const unpaid = await sell(ctx, "share of nothing", { referrer: inviter.address });
      expect((await shop.saleOf(unpaid.quote.order)).referrer).to.equal(inviter.address);
      expect((await shop.saleOf(unpaid.quote.order)).cut).to.equal(0n);
      expect(await shop.earnings(inviter.address)).to.equal(0n);
      expect(await shop.revenue()).to.equal(PRICE * 2n);
    });

    it("takes a sale from a contract wallet its quote names as the buyer", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin } = ctx;
      const actor = await ethers.deployContract("ShopActor", [await shop.getAddress()], admin);
      const { quote, signature } = await quoteOf(ctx, "contract wallet", { buyer: await actor.getAddress() });

      await actor.buy(quote, signature, { value: PRICE });

      expect((await shop.saleOf(quote.order)).buyer).to.equal(await actor.getAddress());
    });

    describe("input validation", () => {
      it("refuses a price of nothing, and any amount but the price", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer } = ctx;

        const free = await quoteOf(ctx, "free", { price: 0n });
        await expect(shop.connect(buyer).buy(free.quote, free.signature, { value: 0n }))
          .to.be.revertedWithCustomError(shop, "ZeroAmount");

        const { quote, signature } = await quoteOf(ctx, "priced");
        await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE - 1n }))
          .to.be.revertedWithCustomError(shop, "WrongPrice")
          .withArgs(quote.order, PRICE, PRICE - 1n);
        await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE + 1n }))
          .to.be.revertedWithCustomError(shop, "WrongPrice")
          .withArgs(quote.order, PRICE, PRICE + 1n);
        await expect(shop.connect(buyer).buy(quote, signature))
          .to.be.revertedWithCustomError(shop, "WrongPrice")
          .withArgs(quote.order, PRICE, 0n);
      });

      it("refuses anybody but the buyer the quote names", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer, outsider } = ctx;
        const { quote, signature } = await quoteOf(ctx, "someone else's");

        await expect(shop.connect(outsider).buy(quote, signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "NotBuyer")
          .withArgs(quote.order, buyer.address);
      });

      it("accepts a quote in the same second it expires, and not one second after", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer } = ctx;
        const deadline = (await latest()) + 100n;

        const late = await quoteOf(ctx, "late", { deadline });
        await networkHelpers.time.setNextBlockTimestamp(deadline + 1n);
        await expect(shop.connect(buyer).buy(late.quote, late.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "QuoteExpired")
          .withArgs(late.quote.order, deadline);

        const lastSecond = await quoteOf(ctx, "last second", { deadline: deadline + 10n });
        await networkHelpers.time.setNextBlockTimestamp(deadline + 10n);
        await expect(shop.connect(buyer).buy(lastSecond.quote, lastSecond.signature, { value: PRICE }))
          .to.emit(shop, "Bought");
      });

      it("refuses a quote that would still be good for more than a day", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer } = ctx;
        const at = (await latest()) + 10n;

        const long = await quoteOf(ctx, "too long", { deadline: at + DAY + 1n });
        await networkHelpers.time.setNextBlockTimestamp(at);
        await expect(shop.connect(buyer).buy(long.quote, long.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "QuoteTooLong")
          .withArgs(long.quote.order, at + DAY + 1n);

        const day = await quoteOf(ctx, "a day", { deadline: at + 1n + DAY });
        await networkHelpers.time.setNextBlockTimestamp(at + 1n);
        await expect(shop.connect(buyer).buy(day.quote, day.signature, { value: PRICE })).to.emit(shop, "Bought");
      });

      it("sells an order once, whatever became of it", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, admin, buyer, outsider } = ctx;
        const { quote } = await sell(ctx, "once");

        const again = await quoteOf(ctx, "once", { item: itemOf("pawns.royal-gold") });
        await expect(shop.connect(buyer).buy(again.quote, again.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "OrderSold")
          .withArgs(quote.order);
        const theirs = await quoteOf(ctx, "once", { buyer: outsider.address });
        await expect(shop.connect(outsider).buy(theirs.quote, theirs.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "OrderSold")
          .withArgs(quote.order);

        await shop.connect(admin).refund(quote.order);
        await expect(shop.connect(buyer).buy(again.quote, again.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "OrderSold")
          .withArgs(quote.order);
      });
    });

    describe("domain binding", () => {
      it("refuses a quote signed by anybody but a seller", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, admin, buyer, outsider } = ctx;

        for (const by of [outsider, admin, buyer]) {
          const { quote, signature } = await quoteOf(ctx, `signed by ${by.address}`, { by });
          await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE }))
            .to.be.revertedWithCustomError(shop, "InvalidSignature")
            .withArgs(quote.order);
        }
      });

      it("refuses a signature over any other order, buyer, item, price, inviter or deadline", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer, inviter, outsider } = ctx;
        const { quote, signature } = await quoteOf(ctx, "signed");

        const changes: [string, Partial<Quote>, Signer][] = [
          ["order", { order: orderOf("other") }, buyer],
          ["buyer", { buyer: outsider.address }, outsider],
          ["item", { item: itemOf("other") }, buyer],
          ["price", { price: PRICE - 1n }, buyer],
          ["referrer", { referrer: inviter.address }, buyer],
          ["deadline", { deadline: quote.deadline + 1n }, buyer],
        ];
        for (const [field, change, from] of changes) {
          const forged = { ...quote, ...change };
          await expect(shop.connect(from).buy(forged, signature, { value: forged.price }), field)
            .to.be.revertedWithCustomError(shop, "InvalidSignature")
            .withArgs(forged.order);
        }

        await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE })).to.emit(shop, "Bought");
      });

      it("refuses a quote signed for another shop or another chain", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, admin, seller, buyer } = ctx;
        const other = await ethers.deployContract("ArcadeShop", [admin.address, seller.address, REFERRAL], admin);

        const forOther = await quoteOf(ctx, "other shop", { domain: await domainOf(other) });
        await expect(shop.connect(buyer).buy(forOther.quote, forOther.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");
        await expect(other.connect(buyer).buy(forOther.quote, forOther.signature, { value: PRICE }))
          .to.emit(other, "Bought");

        const chainId = (await ethers.provider.getNetwork()).chainId;
        const forChain = await quoteOf(ctx, "other chain", { domain: await domainOf(shop, chainId + 1n) });
        await expect(shop.connect(buyer).buy(forChain.quote, forChain.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");
      });

      it("computes the digest a seller signs", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, seller } = ctx;
        const { quote, signature } = await quoteOf(ctx, "digest", { referrer: ctx.inviter.address });

        const digest = await shop.quoteDigest(quote);
        expect(digest).to.equal(ethers.TypedDataEncoder.hash(await domainOf(shop), QUOTE_TYPES, quote));
        expect(ethers.recoverAddress(digest, signature)).to.equal(seller.address);
      });

      it("refuses a signature that is malformed or flipped to its other half", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, buyer } = ctx;
        const { quote, signature } = await quoteOf(ctx, "malformed");

        await expect(shop.connect(buyer).buy(quote, signature.slice(0, -2), { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");
        await expect(shop.connect(buyer).buy(quote, "0x", { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");

        // The same signature with s mirrored round the curve order recovers the same key, and
        // ECDSA refuses it so that a quote cannot be sent under two signatures.
        const split = ethers.Signature.from(signature);
        const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
        const flipped = ethers.concat([split.r, ethers.toBeHex(n - BigInt(split.s), 32), split.v === 27 ? "0x1c" : "0x1b"]);
        await expect(shop.connect(buyer).buy(quote, flipped, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");

        await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE })).to.emit(shop, "Bought");
      });

      it("stops a seller's quotes once it is replaced or its role taken, and takes any seller's", async () => {
        const ctx = await loadFixture(deploy);
        const { shop, admin, seller, buyer, outsider } = ctx;
        const role = await shop.SELLER_ROLE();
        const old = await quoteOf(ctx, "old seller");

        await shop.connect(admin).setSeller(outsider.address);
        await expect(shop.connect(buyer).buy(old.quote, old.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");
        await sell(ctx, "new seller", { by: outsider });

        await shop.connect(admin).grantRole(role, seller.address);
        await expect(shop.connect(buyer).buy(old.quote, old.signature, { value: PRICE })).to.emit(shop, "Bought");

        await shop.connect(admin).revokeRole(role, outsider.address);
        const revoked = await quoteOf(ctx, "revoked", { by: outsider });
        await expect(shop.connect(buyer).buy(revoked.quote, revoked.signature, { value: PRICE }))
          .to.be.revertedWithCustomError(shop, "InvalidSignature");
      });
    });
  });

  describe("claims", () => {
    it("pays an inviter everything they were credited, once", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, inviter } = ctx;
      await sell(ctx, "first", { referrer: inviter.address });
      await sell(ctx, "second", { referrer: inviter.address });
      const before = await balanceOf(inviter.address);

      const tx = await shop.connect(inviter).claim();
      const cost = await gasCostOf(tx);

      await expect(tx).to.emit(shop, "Claimed").withArgs(inviter.address, CUT * 2n);
      expect(await balanceOf(inviter.address)).to.equal(before + CUT * 2n - cost);
      expect(await shop.earnings(inviter.address)).to.equal(0n);
      expect(await shop.totalEarnings()).to.equal(0n);
      expect(await balanceOf(shop)).to.equal(await shop.revenue());
      await expect(shop.connect(inviter).claim()).to.be.revertedWithCustomError(shop, "NothingToClaim");
    });

    it("lets an inviter claim while sales are paused", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, inviter } = ctx;
      await sell(ctx, "paused claim", { referrer: inviter.address });

      await shop.connect(admin).pause();
      await expect(shop.connect(inviter).claim()).to.emit(shop, "Claimed").withArgs(inviter.address, CUT);
    });
  });

  describe("refunds", () => {
    it("gives the whole price back to its buyer, once, for the owner alone", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, outsider } = ctx;
      const { quote } = await sell(ctx, "refunded");
      const before = await balanceOf(buyer.address);

      await expect(shop.connect(outsider).refund(quote.order))
        .to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await shop.DEFAULT_ADMIN_ROLE());
      await expect(shop.connect(admin).refund(quote.order)).to.emit(shop, "Refunded").withArgs(quote.order, buyer.address, PRICE, 0n);

      expect(await balanceOf(buyer.address)).to.equal(before + PRICE);
      expect((await shop.saleOf(quote.order)).refunded).to.equal(true);
      expect(await shop.revenue()).to.equal(0n);
      expect(await balanceOf(shop)).to.equal(0n);
      await expect(shop.connect(admin).refund(quote.order)).to.be.revertedWithCustomError(shop, "AlreadyRefunded").withArgs(quote.order);
      await expect(shop.connect(admin).refund(orderOf("never sold"))).to.be.revertedWithCustomError(shop, "NotSold").withArgs(orderOf("never sold"));
    });

    it("takes the inviter's cut back while it is unclaimed", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, inviter } = ctx;
      const { quote } = await sell(ctx, "cut back", { referrer: inviter.address });

      await expect(shop.connect(admin).refund(quote.order)).to.emit(shop, "Refunded").withArgs(quote.order, buyer.address, PRICE, CUT);

      expect(await shop.earnings(inviter.address)).to.equal(0n);
      expect(await shop.totalEarnings()).to.equal(0n);
      expect(await shop.revenue()).to.equal(0n);
      expect(await balanceOf(shop)).to.equal(0n);
    });

    it("pays a cut the inviter already claimed out of revenue, and takes it from their later credit", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, inviter } = ctx;
      const { quote } = await sell(ctx, "claimed cut", { referrer: inviter.address });
      await shop.connect(inviter).claim();
      await sell(ctx, "unrelated");

      await expect(shop.connect(admin).refund(quote.order)).to.emit(shop, "Refunded").withArgs(quote.order, buyer.address, PRICE, 0n);
      expect(await shop.revenue()).to.equal(PRICE - CUT);
      expect(await shop.solvent()).to.equal(true);

      // A cut claimed for a sale that was refunded is taken back from what the inviter earns
      // next, as far as it reaches.
      const { quote: second } = await sell(ctx, "claimed again", { referrer: inviter.address });
      await shop.connect(inviter).claim();
      await sell(ctx, "later credit", { referrer: inviter.address });
      await expect(shop.connect(admin).refund(second.order)).to.emit(shop, "Refunded").withArgs(second.order, buyer.address, PRICE, CUT);
      expect(await shop.earnings(inviter.address)).to.equal(0n);
      expect(await balanceOf(shop)).to.equal((await shop.revenue()) + (await shop.totalEarnings()));
    });

    it("refuses a refund revenue cannot cover, until the owner funds it", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, outsider } = ctx;
      const { quote } = await sell(ctx, "withdrawn");
      await shop.connect(admin).withdraw(admin.address, PRICE);

      await expect(shop.connect(admin).refund(quote.order))
        .to.be.revertedWithCustomError(shop, "InsufficientRevenue")
        .withArgs(0n, PRICE);

      await expect(shop.connect(outsider).fund({ value: PRICE }))
        .to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(admin).fund({ value: 0n })).to.be.revertedWithCustomError(shop, "ZeroAmount");
      await expect(shop.connect(admin).fund({ value: PRICE })).to.emit(shop, "Funded").withArgs(admin.address, PRICE);
      expect(await shop.revenue()).to.equal(PRICE);

      await expect(shop.connect(admin).refund(quote.order)).to.emit(shop, "Refunded").withArgs(quote.order, buyer.address, PRICE, 0n);
      expect(await shop.revenue()).to.equal(0n);
    });

    it("refunds while sales are paused", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin } = ctx;
      const { quote } = await sell(ctx, "paused refund");

      await shop.connect(admin).pause();
      await expect(shop.connect(admin).refund(quote.order)).to.emit(shop, "Refunded");
    });
  });

  describe("role administration", () => {
    it("sends revenue to the owner's choice, and never what inviters have to claim", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, inviter, outsider } = ctx;
      await sell(ctx, "revenue", { referrer: inviter.address });
      const before = await balanceOf(outsider.address);

      await expect(shop.connect(admin).withdraw(outsider.address, PRICE - CUT + 1n))
        .to.be.revertedWithCustomError(shop, "InsufficientRevenue")
        .withArgs(PRICE - CUT, PRICE - CUT + 1n);
      await expect(shop.connect(admin).withdraw(outsider.address, PRICE - CUT))
        .to.emit(shop, "Withdrawn")
        .withArgs(outsider.address, PRICE - CUT);

      expect(await balanceOf(outsider.address)).to.equal(before + PRICE - CUT);
      expect(await shop.revenue()).to.equal(0n);
      expect(await balanceOf(shop)).to.equal(CUT);
      await expect(shop.connect(inviter).claim()).to.emit(shop, "Claimed").withArgs(inviter.address, CUT);
    });

    it("refuses a withdrawal of nothing, to nobody, or by anybody but the owner", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, outsider } = ctx;
      await sell(ctx, "refused withdrawals");

      await expect(shop.connect(admin).withdraw(outsider.address, 0n)).to.be.revertedWithCustomError(shop, "ZeroAmount");
      await expect(shop.connect(admin).withdraw(ethers.ZeroAddress, PRICE)).to.be.revertedWithCustomError(shop, "ZeroAddress");
      await expect(shop.connect(outsider).withdraw(outsider.address, PRICE))
        .to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
    });

    it("moves the seller in one call, for the owner alone", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, seller, outsider } = ctx;
      const role = await shop.SELLER_ROLE();

      await expect(shop.connect(admin).setSeller(ethers.ZeroAddress)).to.be.revertedWithCustomError(shop, "ZeroAddress");
      await expect(shop.connect(outsider).setSeller(outsider.address))
        .to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(admin).setSeller(outsider.address)).to.emit(shop, "SellerChanged").withArgs(seller.address, outsider.address);

      expect(await shop.seller()).to.equal(outsider.address);
      expect(await shop.hasRole(role, seller.address)).to.equal(false);
      expect(await shop.hasRole(role, outsider.address)).to.equal(true);
    });

    it("sets the inviters' share from nothing to 30%, for sales from then on", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, inviter, outsider } = ctx;
      await sell(ctx, "at 10%", { referrer: inviter.address });

      await expect(shop.connect(admin).setReferralBps(3_001)).to.be.revertedWithCustomError(shop, "ReferralBpsOutOfRange").withArgs(3_001);
      await expect(shop.connect(outsider).setReferralBps(2_000)).to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(admin).setReferralBps(3_000)).to.emit(shop, "ReferralBpsChanged").withArgs(REFERRAL, 3_000);

      const { quote } = await sell(ctx, "at 30%", { referrer: inviter.address });
      expect((await shop.saleOf(quote.order)).cut).to.equal((PRICE * 3_000n) / 10_000n);
      expect(await shop.earnings(inviter.address)).to.equal(CUT + (PRICE * 3_000n) / 10_000n);
    });

    it("stops new sales while paused, and nothing else", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, buyer, outsider } = ctx;
      const { quote: sold } = await sell(ctx, "before the pause");
      const { quote, signature } = await quoteOf(ctx, "during the pause");

      await expect(shop.connect(outsider).pause()).to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await shop.connect(admin).pause();
      await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE })).to.be.revertedWithCustomError(shop, "EnforcedPause");
      await shop.connect(admin).refund(sold.order);
      await shop.connect(admin).fund({ value: PRICE });
      await shop.connect(admin).withdraw(admin.address, PRICE);

      await shop.connect(admin).unpause();
      await expect(shop.connect(buyer).buy(quote, signature, { value: PRICE })).to.emit(shop, "Bought");
    });

    it("hands the shop to a new owner only once they accept, with the pauser role", async () => {
      const { shop, admin, buyer, outsider } = await loadFixture(deploy);
      const ownerRole = await shop.DEFAULT_ADMIN_ROLE();
      const pauser = await shop.PAUSER_ROLE();

      await expect(shop.connect(buyer).beginDefaultAdminTransfer(buyer.address))
        .to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(admin).grantRole(ownerRole, outsider.address))
        .to.be.revertedWithCustomError(shop, "AccessControlEnforcedDefaultAdminRules");

      await shop.connect(admin).beginDefaultAdminTransfer(buyer.address);
      expect(await shop.owner()).to.equal(admin.address);
      await expect(shop.connect(outsider).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(shop, "AccessControlInvalidDefaultAdmin")
        .withArgs(outsider.address);

      await shop.connect(admin).cancelDefaultAdminTransfer();
      await expect(shop.connect(buyer).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(shop, "AccessControlInvalidDefaultAdmin");

      await shop.connect(admin).beginDefaultAdminTransfer(outsider.address);
      await shop.connect(outsider).acceptDefaultAdminTransfer();

      expect(await shop.owner()).to.equal(outsider.address);
      expect(await shop.hasRole(ownerRole, admin.address)).to.equal(false);
      expect(await shop.hasRole(pauser, admin.address)).to.equal(false);
      expect(await shop.hasRole(pauser, outsider.address)).to.equal(true);
      await expect(shop.connect(admin).setReferralBps(500)).to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(admin).pause()).to.be.revertedWithCustomError(shop, "AccessControlUnauthorizedAccount");
      await expect(shop.connect(outsider).setReferralBps(500)).to.emit(shop, "ReferralBpsChanged").withArgs(REFERRAL, 500);
      await expect(shop.connect(outsider).pause()).to.emit(shop, "Paused");
    });

    it("refuses a plain transfer, so no coin arrives that is nobody's", async () => {
      const { shop, buyer } = await loadFixture(deploy);

      await expect(buyer.sendTransaction({ to: await shop.getAddress(), value: PRICE })).to.be.revert(ethers);
      expect(await balanceOf(shop)).to.equal(0n);
    });
  });

  describe("reentrancy", () => {
    it("pays a claim re-entered from its receiver exactly once", async () => {
      const ctx = await loadFixture(deployActor);
      const { shop, actor } = ctx;
      const address = await actor.getAddress();
      await sell(ctx, "for the actor", { referrer: address });
      await sell(ctx, "for the actor again", { referrer: address });

      await actor.setMode(3);
      await actor.claim();

      expect(await actor.innerCallFailed()).to.equal(true);
      expect(await actor.receiveCount()).to.equal(1n);
      expect(await balanceOf(address)).to.equal(CUT * 2n);
      expect(await shop.earnings(address)).to.equal(0n);
      expect(await shop.solvent()).to.equal(true);
    });

    it("keeps an inviter's credit when their receiver refuses it", async () => {
      const ctx = await loadFixture(deployActor);
      const { shop, actor } = ctx;
      const address = await actor.getAddress();
      await sell(ctx, "refused credit", { referrer: address });

      await actor.setMode(1);
      await expect(actor.claim()).to.be.revertedWith("no thanks");
      expect(await shop.earnings(address)).to.equal(CUT);
    });

    it("keeps a sale and its revenue when its buyer refuses the refund", async () => {
      const ctx = await loadFixture(deployActor);
      const { shop, admin, actor } = ctx;
      const { quote, signature } = await quoteOf(ctx, "refused refund", { buyer: await actor.getAddress() });
      await actor.buy(quote, signature, { value: PRICE });

      await actor.setMode(1);
      await expect(shop.connect(admin).refund(quote.order)).to.be.revertedWith("no thanks");
      expect((await shop.saleOf(quote.order)).refunded).to.equal(false);
      expect(await shop.revenue()).to.equal(PRICE);
    });

    it("takes a sale made from inside a refund as a sale of its own", async () => {
      const ctx = await loadFixture(deployActor);
      const { shop, admin, actor } = ctx;
      const address = await actor.getAddress();
      const first = await quoteOf(ctx, "first of two", { buyer: address });
      await actor.buy(first.quote, first.signature, { value: PRICE });
      const second = await quoteOf(ctx, "bought inside the refund", { buyer: address });
      await actor.prepare(second.quote, second.signature);

      await actor.setMode(2);
      await shop.connect(admin).refund(first.quote.order);

      expect(await actor.innerCallFailed()).to.equal(false);
      expect((await shop.saleOf(first.quote.order)).refunded).to.equal(true);
      expect((await shop.saleOf(second.quote.order)).buyer).to.equal(address);
      expect(await shop.revenue()).to.equal(PRICE);
      expect(await balanceOf(shop)).to.equal(PRICE);
      expect(await shop.solvent()).to.equal(true);
    });

    it("keeps revenue when its receiver refuses a withdrawal", async () => {
      const ctx = await loadFixture(deployActor);
      const { shop, admin, actor } = ctx;
      await sell(ctx, "refused withdrawal");

      await actor.setMode(1);
      await expect(shop.connect(admin).withdraw(await actor.getAddress(), PRICE)).to.be.revertedWith("no thanks");
      expect(await shop.revenue()).to.equal(PRICE);
    });
  });

  describe("accounting", () => {
    it("stays solvent to the wei across shares, odd prices, refunds and claims", async () => {
      const ctx = await loadFixture(deploy);
      const { shop, admin, inviter } = ctx;
      const prices = [1n, 7n, 333n, ethers.parseEther("0.123456789"), ethers.parseEther("50"), ethers.parseEther("999") + 13n];
      const orders: string[] = [];

      for (const [i, price] of prices.entries()) {
        await shop.connect(admin).setReferralBps([0, 1, 999, 1_000, 2_999, 3_000][i]);
        const { quote } = await sell(ctx, `odd ${i}`, { price, referrer: i % 2 === 0 ? inviter.address : ethers.ZeroAddress });
        orders.push(quote.order);
        expect(await balanceOf(shop)).to.equal((await shop.revenue()) + (await shop.totalEarnings()));
      }

      await shop.connect(admin).refund(orders[4]);
      await shop.connect(inviter).claim();
      await shop.connect(admin).refund(orders[5]);
      await shop.connect(admin).refund(orders[0]);

      expect(await balanceOf(shop)).to.equal((await shop.revenue()) + (await shop.totalEarnings()));
      await shop.connect(admin).withdraw(admin.address, await shop.revenue());
      expect(await balanceOf(shop)).to.equal(await shop.totalEarnings());
    });
  });

  describe("gas", () => {
    it("sells within bounds, with an inviter and without", async () => {
      const ctx = await loadFixture(deploy);
      const plain = await (await sell(ctx, "gas plain")).tx.wait();
      const invited = await (await sell(ctx, "gas invited", { referrer: ctx.inviter.address })).tx.wait();

      console.log(`      buy ${plain!.gasUsed}, with an inviter ${invited!.gasUsed}`);
      expect(plain!.gasUsed).to.be.lessThan(150_000n);
      expect(invited!.gasUsed).to.be.lessThan(230_000n);
    });
  });
});
