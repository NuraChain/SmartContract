import { expect } from "chai";
import { artifacts, network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();
const { loadFixture } = networkHelpers;

/**
 * NuraProfile: the profile registry behind an ERC-1967 proxy, its lens, and the reference
 * SocialVerifier extension.
 *
 * The contract's promises, in the order the suite checks them: one profile per address and a
 * globally unique, case-normalized username; content that only the owner (or an operator the
 * owner approved) can touch; localization that falls back to the default language; item
 * collections that keep working for kinds nobody has named yet; extensions that can write
 * only into their own namespace and only after the owner opted in; ownership that moves in
 * two steps and can be recovered; upgrades that keep every byte of state; and an event
 * stream an indexer can replay into the same picture the lens shows.
 */

const b32 = (s: string) => ethers.encodeBytes32String(s);
const ZERO32 = ethers.ZeroHash;

/** ERC-7201: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff */
function erc7201(id: string): string {
  const h = BigInt(ethers.keccak256(ethers.toUtf8Bytes(id))) - 1n;
  const k = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [h])));
  return "0x" + (k & ~0xffn).toString(16).padStart(64, "0");
}

/** ERC-165 interface id: XOR of every function selector in the interface. */
async function interfaceIdOf(name: string): Promise<string> {
  const { abi } = await artifacts.readArtifact(name);
  const iface = new ethers.Interface(abi);
  let acc = 0n;
  for (const f of iface.fragments) {
    // Solidity's type(I).interfaceId covers the functions I declares itself, not inherited ones (IERC165).
    if (f.type === "function" && f.format("sighash") !== "supportsInterface(bytes4)") {
      acc ^= BigInt(iface.getFunction(f.format("sighash"))!.selector);
    }
  }
  return "0x" + acc.toString(16).padStart(8, "0");
}

// Fixtures are module-scope functions: loadFixture snapshots on the function reference.

/** Implementation + proxy + lens, admin as owner; nobody has a profile yet. */
async function deployProfile() {
  const [admin, alice, bob, carol, operator, recovery, signer] = await ethers.getSigners();

  const impl = await ethers.deployContract("NuraProfile", [], admin);
  const initData = impl.interface.encodeFunctionData("initialize", [admin.address]);
  const proxy = await ethers.deployContract("NuraProfileProxy", [await impl.getAddress(), initData], admin);
  const proxyAddress = await proxy.getAddress();

  const profile = await ethers.getContractAt("NuraProfile", proxyAddress, admin);
  const lens = await ethers.deployContract("NuraProfileLens", [proxyAddress], admin);

  return { impl, proxy, proxyAddress, profile, lens, admin, alice, bob, carol, operator, recovery, signer };
}

/** Alice has profile #1 ("alice", display name, bio, avatar). */
async function deployWithAlice() {
  const ctx = await deployProfile();
  await ctx.profile.connect(ctx.alice).createProfile("Alice", "Alice Doe", "Builder", "ipfs://avatar");
  return { ...ctx, id: 1n };
}

/** Alice's profile plus a registered MockExtension ("mock-ext") she has approved. */
async function deployWithExtension() {
  const ctx = await deployWithAlice();
  const ext = await ethers.deployContract("MockExtension", [ctx.proxyAddress, b32("mock-ext")], ctx.admin);
  await ctx.profile.registerExtension("mock-ext", await ext.getAddress());
  await ctx.profile.connect(ctx.alice).approveExtension(ctx.id, "mock-ext", true);
  return { ...ctx, ext };
}

/** Alice's profile plus a registered SocialVerifier whose VERIFIER_ROLE is `signer`. */
async function deployWithVerifier() {
  const ctx = await deployWithAlice();
  const verifier = await ethers.deployContract(
    "SocialVerifier",
    [ctx.admin.address, ctx.signer.address, ctx.proxyAddress],
    ctx.admin,
  );
  await ctx.profile.registerExtension("social-verifier", await verifier.getAddress());
  await ctx.profile.connect(ctx.alice).approveExtension(ctx.id, "social-verifier", true);
  return { ...ctx, verifier };
}

describe("NuraProfile", () => {
  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("deployment", () => {
    it("initializes the proxy with the owner, version and constants", async () => {
      const { profile, admin } = await loadFixture(deployProfile);

      expect(await profile.owner()).to.equal(admin.address);
      expect(await profile.VERSION()).to.equal("1.0.0");
      expect(await profile.MAX_VALUE_LENGTH()).to.equal(4096n);
      expect(await profile.MIN_USERNAME_LENGTH()).to.equal(3n);
      expect(await profile.MAX_USERNAME_LENGTH()).to.equal(32n);
      expect(await profile.profilesCreated()).to.equal(0n);
    });

    it("cannot be initialized twice, and the bare implementation cannot be initialized at all", async () => {
      const { profile, impl, alice } = await loadFixture(deployProfile);

      await expect(profile.initialize(alice.address)).to.be.revertedWithCustomError(profile, "InvalidInitialization");
      await expect(impl.initialize(alice.address)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("advertises INuraProfile and ERC165", async () => {
      const { profile } = await loadFixture(deployProfile);

      expect(await profile.supportsInterface(await interfaceIdOf("INuraProfile"))).to.equal(true);
      expect(await profile.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await profile.supportsInterface("0xffffffff")).to.equal(false);
      expect(await profile.supportsInterface("0x80ac58cd")).to.equal(false); // not an ERC721
    });

    it("keeps its state in the ERC-7201 namespace it documents", async () => {
      const { admin } = await loadFixture(deployProfile);
      const v2 = await ethers.deployContract("NuraProfileV2Mock", [], admin);

      expect(await v2.layoutSlot()).to.equal(erc7201("nura.storage.NuraProfile"));
    });

    it("binds the lens to the proxy and rejects a zero core", async () => {
      const { lens, proxyAddress } = await loadFixture(deployProfile);

      expect(await lens.core()).to.equal(proxyAddress);
      const factory = await ethers.getContractFactory("NuraProfileLens");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("profile creation", () => {
    it("creates a profile with username and the three standard fields", async () => {
      const { profile, lens, alice } = await loadFixture(deployProfile);

      const tx = await profile.connect(alice).createProfile("Alice", "Alice Doe", "Builder", "ipfs://avatar");
      await expect(tx).to.emit(profile, "ProfileCreated").withArgs(1n, alice.address, b32("alice"));
      await expect(tx).to.emit(profile, "FieldUpdated").withArgs(1n, b32("displayName"), "Alice Doe");
      await expect(tx).to.emit(profile, "FieldUpdated").withArgs(1n, b32("bio"), "Builder");
      await expect(tx).to.emit(profile, "FieldUpdated").withArgs(1n, b32("avatar"), "ipfs://avatar");

      expect(await profile.profileIdOf(alice.address)).to.equal(1n);
      expect(await profile.ownerOf(1n)).to.equal(alice.address);
      expect(await profile.exists(1n)).to.equal(true);
      expect(await profile.usernameOf(1n)).to.equal("alice");
      expect(await profile.profilesCreated()).to.equal(1n);

      const view = await lens.getProfile(alice.address, "");
      expect(view.id).to.equal(1n);
      expect(view.owner).to.equal(alice.address);
      expect(view.username).to.equal("alice");
      expect(view.displayName).to.equal("Alice Doe");
      expect(view.bio).to.equal("Builder");
      expect(view.avatar).to.equal("ipfs://avatar");
      expect(view.cover).to.equal("");
      expect(view.createdAt).to.equal(BigInt(await networkHelpers.time.latest()));
      expect(view.updatedAt).to.equal(view.createdAt);
    });

    it("returns the new id, and ids are sequential from 1", async () => {
      const { profile, alice, bob } = await loadFixture(deployProfile);

      expect(await profile.connect(alice).createProfile.staticCall("alice", "", "", "")).to.equal(1n);
      await profile.connect(alice).createProfile("alice", "", "", "");
      expect(await profile.connect(bob).createProfile.staticCall("bob", "", "", "")).to.equal(2n);
    });

    it("allows a profile without a username, and skips empty fields entirely", async () => {
      const { profile, lens, bob } = await loadFixture(deployProfile);

      const tx = await profile.connect(bob).createProfile("", "", "", "");
      await expect(tx).to.emit(profile, "ProfileCreated").withArgs(1n, bob.address, ZERO32);
      await expect(tx).to.not.emit(profile, "FieldUpdated");

      expect(await profile.usernameOf(1n)).to.equal("");
      expect((await lens.getProfile(bob.address, "")).displayName).to.equal("");
      expect(await profile.isUsernameAvailable("bob")).to.equal(true);
    });

    it("refuses a second profile for the same address", async () => {
      const { profile, alice } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).createProfile("alice2", "", "", ""))
        .to.be.revertedWithCustomError(profile, "AlreadyHasProfile")
        .withArgs(alice.address);
    });

    it("reports no profile as an empty view, and a dead id as ProfileNotFound", async () => {
      const { profile, lens, bob } = await loadFixture(deployWithAlice);

      const view = await lens.getProfile(bob.address, "en");
      expect(view.id).to.equal(0n);
      expect(view.owner).to.equal(ethers.ZeroAddress);
      expect(await profile.profileIdOf(bob.address)).to.equal(0n);
      expect(await profile.ownerOf(99n)).to.equal(ethers.ZeroAddress);
      expect(await profile.exists(99n)).to.equal(false);

      await expect(lens.getProfileById(99n, "")).to.be.revertedWithCustomError(profile, "ProfileNotFound").withArgs(99n);
      await expect(profile.getField(99n, "bio")).to.be.revertedWithCustomError(profile, "ProfileNotFound");
      await expect(profile.usernameOf(99n)).to.be.revertedWithCustomError(profile, "ProfileNotFound");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("usernames", () => {
    it("normalizes case: registration, lookup and availability all see one name", async () => {
      const { profile, alice, bob } = await loadFixture(deployWithAlice);

      expect(await profile.normalizeUsername("ALICE")).to.equal("alice");
      expect(await profile.normalizeUsername("Alice_99")).to.equal("alice_99");

      const [id, owner] = await profile.resolveUsername("aLiCe");
      expect(id).to.equal(1n);
      expect(owner).to.equal(alice.address);

      expect(await profile.isUsernameAvailable("ALICE")).to.equal(false);
      await expect(profile.connect(bob).createProfile("ALICE", "", "", ""))
        .to.be.revertedWithCustomError(profile, "UsernameTaken")
        .withArgs(b32("alice"));
    });

    it("rejects invalid usernames", async () => {
      const { profile, bob } = await loadFixture(deployProfile);

      for (const bad of ["ab", "a".repeat(33), "al ice", "alice!", "0xabc", "0Xabc", "ali-ce", "alíce", "علی"]) {
        await expect(profile.connect(bob).createProfile(bad, "", "", ""), bad).to.be.revertedWithCustomError(
          profile,
          "InvalidUsername",
        );
        await expect(profile.normalizeUsername(bad), bad).to.be.revertedWithCustomError(profile, "InvalidUsername");
        expect(await profile.isUsernameAvailable(bad), bad).to.equal(false);
        const [id] = await profile.resolveUsername(bad);
        expect(id, bad).to.equal(0n);
      }
    });

    it("accepts the boundaries: 3 and 32 characters, digits first, underscores", async () => {
      const { profile, alice, bob, carol } = await loadFixture(deployProfile);

      await profile.connect(alice).createProfile("abc", "", "", "");
      await profile.connect(bob).createProfile("a".repeat(32), "", "", "");
      await profile.connect(carol).createProfile("1_2_3", "", "", "");

      expect(await profile.usernameOf(1n)).to.equal("abc");
      expect(await profile.usernameOf(2n)).to.equal("a".repeat(32));
      expect(await profile.usernameOf(3n)).to.equal("1_2_3");
    });

    it("changes the username, releasing the old one to others", async () => {
      const { profile, alice, bob, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).setUsername(id, "Alice_Nura"))
        .to.emit(profile, "UsernameChanged")
        .withArgs(id, b32("alice"), b32("alice_nura"));

      expect(await profile.usernameOf(id)).to.equal("alice_nura");
      expect(await profile.isUsernameAvailable("alice")).to.equal(true);
      expect((await profile.resolveUsername("alice"))[0]).to.equal(0n);

      await profile.connect(bob).createProfile("alice", "", "", "");
      expect((await profile.resolveUsername("alice"))[0]).to.equal(2n);
    });

    it("clears a username with the empty string", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).setUsername(id, ""))
        .to.emit(profile, "UsernameChanged")
        .withArgs(id, b32("alice"), ZERO32);
      expect(await profile.usernameOf(id)).to.equal("");
      expect(await profile.isUsernameAvailable("alice")).to.equal(true);

      // Clearing again is a no-op and says so.
      await expect(profile.connect(alice).setUsername(id, ""))
        .to.be.revertedWithCustomError(profile, "UsernameUnchanged")
        .withArgs(ZERO32);
    });

    it("rejects a change to the same normalized name, and to one that is taken", async () => {
      const { profile, alice, bob, id } = await loadFixture(deployWithAlice);
      await profile.connect(bob).createProfile("bob", "", "", "");

      await expect(profile.connect(alice).setUsername(id, "ALICE"))
        .to.be.revertedWithCustomError(profile, "UsernameUnchanged")
        .withArgs(b32("alice"));
      await expect(profile.connect(alice).setUsername(id, "bob"))
        .to.be.revertedWithCustomError(profile, "UsernameTaken")
        .withArgs(b32("bob"));
    });

    it("lets only the owner rename — not operators, not strangers", async () => {
      const { profile, alice, bob, operator, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setOperator(operator.address, true);

      await expect(profile.connect(operator).setUsername(id, "x_alice"))
        .to.be.revertedWithCustomError(profile, "NotProfileOwner")
        .withArgs(id, operator.address);
      await expect(profile.connect(bob).setUsername(id, "x_alice"))
        .to.be.revertedWithCustomError(profile, "NotProfileOwner")
        .withArgs(id, bob.address);
    });

    describe("reservations", () => {
      it("blocks a name reserved for nobody, and only the admin can reserve", async () => {
        const { profile, alice, bob } = await loadFixture(deployProfile);

        await expect(profile.reserveUsername("Nura", ethers.ZeroAddress))
          .to.emit(profile, "UsernameReserved")
          .withArgs(b32("nura"), ethers.ZeroAddress);

        const [claimant, active] = await profile.usernameReservation("NURA");
        expect(claimant).to.equal(ethers.ZeroAddress);
        expect(active).to.equal(true);
        expect(await profile.isUsernameAvailable("nura")).to.equal(false);

        await expect(profile.connect(bob).createProfile("nura", "", "", ""))
          .to.be.revertedWithCustomError(profile, "UsernameIsReserved")
          .withArgs(b32("nura"));

        await expect(profile.connect(alice).reserveUsername("admin", ethers.ZeroAddress)).to.be.revertedWithCustomError(
          profile,
          "OwnableUnauthorizedAccount",
        );
        await expect(profile.connect(alice).unreserveUsername("nura")).to.be.revertedWithCustomError(
          profile,
          "OwnableUnauthorizedAccount",
        );
        await expect(profile.reserveUsername("no", ethers.ZeroAddress)).to.be.revertedWithCustomError(
          profile,
          "InvalidUsername",
        );
      });

      it("lets exactly the claimant register a reserved name, consuming the reservation", async () => {
        const { profile, alice, bob } = await loadFixture(deployProfile);
        await profile.reserveUsername("nura", bob.address);

        await expect(profile.connect(alice).createProfile("nura", "", "", "")).to.be.revertedWithCustomError(
          profile,
          "UsernameIsReserved",
        );

        await profile.connect(bob).createProfile("NURA", "", "", "");
        expect((await profile.resolveUsername("nura"))[1]).to.equal(bob.address);

        // Consumed: if Bob lets it go, it is an ordinary free name again.
        const [, active] = await profile.usernameReservation("nura");
        expect(active).to.equal(false);
        await profile.connect(bob).setUsername(2n === 2n ? 1n : 1n, "bob_now");
        expect(await profile.isUsernameAvailable("nura")).to.equal(true);
      });

      it("can be lifted, and can be placed on a name that is currently taken (affecting only its future)", async () => {
        const { profile, alice, bob, id } = await loadFixture(deployWithAlice);

        await profile.reserveUsername("alice", ethers.ZeroAddress);
        expect(await profile.usernameOf(id)).to.equal("alice"); // untouched: no admin power over content

        await profile.connect(alice).setUsername(id, "alice_2");
        await expect(profile.connect(bob).createProfile("alice", "", "", "")).to.be.revertedWithCustomError(
          profile,
          "UsernameIsReserved",
        );

        await expect(profile.unreserveUsername("alice")).to.emit(profile, "UsernameUnreserved").withArgs(b32("alice"));
        await profile.connect(bob).createProfile("alice", "", "", "");
        expect((await profile.resolveUsername("alice"))[1]).to.equal(bob.address);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("fields", () => {
    it("sets, reads, overwrites and removes a default-language field", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await expect(p.setField(id, "jobTitle", "Blockchain Developer"))
        .to.emit(profile, "FieldUpdated")
        .withArgs(id, b32("jobTitle"), "Blockchain Developer");
      expect(await profile.getField(id, "jobTitle")).to.equal("Blockchain Developer");

      await p.setField(id, "jobTitle", "CTO");
      expect(await profile.getField(id, "jobTitle")).to.equal("CTO");

      // An empty value is a removal, and says so.
      await expect(p.setField(id, "jobTitle", "")).to.emit(profile, "FieldRemoved").withArgs(id, b32("jobTitle"), ZERO32);
      expect(await profile.getField(id, "jobTitle")).to.equal("");

      await p.setField(id, "company", "Nura");
      await expect(p.removeField(id, "company", "")).to.emit(profile, "FieldRemoved").withArgs(id, b32("company"), ZERO32);
      expect(await profile.getField(id, "company")).to.equal("");
    });

    it("bumps updatedAt and emits ProfileUpdated on every content change", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const before = (await profile.getProfileRecord(id)).updatedAt;

      await networkHelpers.time.increase(100);
      await expect(profile.connect(alice).setField(id, "location", "Tehran")).to.emit(profile, "ProfileUpdated").withArgs(id);

      const after = (await profile.getProfileRecord(id)).updatedAt;
      expect(after).to.be.greaterThan(before);
      expect(after).to.equal(BigInt(await networkHelpers.time.latest()));
    });

    it("stores custom keys freely: snake_case, reverse-DNS, 32 characters", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      const key32 = "a".repeat(32);

      await p.setFields(id, [
        { key: "job_title", lang: "", value: "Dev" },
        { key: "social.nura.badges", lang: "", value: "3" },
        { key: key32, lang: "", value: "max" },
        { key: "discord", lang: "", value: "alice#1234" },
      ]);

      expect(await profile.getField(id, "job_title")).to.equal("Dev");
      expect(await profile.getField(id, "social.nura.badges")).to.equal("3");
      expect(await profile.getField(id, key32)).to.equal("max");
      expect(await profile.resolveFields(id, ["discord", "job_title", "missing"], "")).to.deep.equal([
        "alice#1234",
        "Dev",
        "",
      ]);
    });

    it("rejects invalid keys", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      for (const bad of ["", "a".repeat(33), "job title", "bioé", "tab\tkey", "​"]) {
        await expect(p.setField(id, bad, "x"), JSON.stringify(bad)).to.be.revertedWithCustomError(profile, "InvalidKey");
        await expect(profile.getField(id, bad), JSON.stringify(bad)).to.be.revertedWithCustomError(profile, "InvalidKey");
      }
    });

    it("caps a value at MAX_VALUE_LENGTH bytes", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await p.setField(id, "bio", "x".repeat(4096));
      expect((await profile.getField(id, "bio")).length).to.equal(4096);

      await expect(p.setField(id, "bio", "x".repeat(4097)))
        .to.be.revertedWithCustomError(profile, "ValueTooLong")
        .withArgs(4097n, 4096n);

      // UTF-8 counts bytes, not characters: 2049 two-byte characters is 4098 bytes.
      await expect(p.setField(id, "bio", "é".repeat(2049)))
        .to.be.revertedWithCustomError(profile, "ValueTooLong")
        .withArgs(4098n, 4096n);
    });

    it("refuses writes from anyone but the owner or an operator", async () => {
      const { profile, bob, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(bob).setField(id, "bio", "hijack"))
        .to.be.revertedWithCustomError(profile, "NotAuthorized")
        .withArgs(id, bob.address);
      await expect(profile.connect(bob).setLocalizedField(id, "bio", "en", "hijack")).to.be.revertedWithCustomError(
        profile,
        "NotAuthorized",
      );
      await expect(profile.connect(bob).setFields(id, [{ key: "bio", lang: "", value: "x" }])).to.be.revertedWithCustomError(
        profile,
        "NotAuthorized",
      );
      await expect(profile.connect(bob).removeField(id, "bio", "")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await expect(profile.connect(bob).setField(99n, "bio", "x")).to.be.revertedWithCustomError(profile, "ProfileNotFound");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("localization", () => {
    it("keeps one value per language and falls back to the default", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await expect(p.setLocalizedField(id, "bio", "fa", "توسعه‌دهنده بلاکچین"))
        .to.emit(profile, "LocalizedFieldUpdated")
        .withArgs(id, b32("bio"), b32("fa"), "توسعه‌دهنده بلاکچین");
      await p.setLocalizedField(id, "bio", "de", "Blockchain-Entwickler");
      await p.setLocalizedField(id, "displayName", "fa", "آلیس");

      expect(await profile.getLocalizedField(id, "bio", "fa")).to.equal("توسعه‌دهنده بلاکچین");
      expect(await profile.getLocalizedField(id, "bio", "de")).to.equal("Blockchain-Entwickler");
      expect(await profile.getLocalizedField(id, "bio", "fr")).to.equal(""); // exact: no fallback
      expect(await profile.resolveField(id, "bio", "fr")).to.equal("Builder"); // resolve: fallback
      expect(await profile.resolveField(id, "bio", "fa")).to.equal("توسعه‌دهنده بلاکچین");
      expect(await profile.resolveField(id, "bio", "")).to.equal("Builder");

      const fa = await lens.getProfile(alice.address, "fa");
      expect(fa.displayName).to.equal("آلیس");
      expect(fa.bio).to.equal("توسعه‌دهنده بلاکچین");
      expect(fa.avatar).to.equal("ipfs://avatar"); // not localized: default

      const fr = await lens.getProfile(alice.address, "fr");
      expect(fr.displayName).to.equal("Alice Doe");
      expect(fr.bio).to.equal("Builder");
    });

    it("treats language tags case-insensitively and lower-cases them in events", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await expect(p.setLocalizedField(id, "location", "zh-Hant", "臺北"))
        .to.emit(profile, "LocalizedFieldUpdated")
        .withArgs(id, b32("location"), b32("zh-hant"), "臺北");
      expect(await profile.getLocalizedField(id, "location", "ZH-HANT")).to.equal("臺北");
      expect(await profile.getLocalizedField(id, "location", "zh-hant")).to.equal("臺北");

      await p.setLocalizedField(id, "location", "EN", "Taipei");
      expect(await profile.getLocalizedField(id, "location", "en")).to.equal("Taipei");
    });

    it("rejects malformed language tags, and allows unlimited languages", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      for (const bad of ["en_US", "en US", "a".repeat(33), "fä", "en;q=0.8"]) {
        await expect(p.setLocalizedField(id, "bio", bad, "x"), bad).to.be.revertedWithCustomError(profile, "InvalidLanguage");
      }

      const langs = ["en", "fa", "de", "fr", "es", "ar", "zh", "ja", "ko", "ru", "tr", "pt-br", "x-klingon", "a".repeat(32)];
      await p.setFields(
        id,
        langs.map((lang) => ({ key: "bio", lang, value: `bio in ${lang}` })),
      );
      for (const lang of langs) {
        expect(await profile.getLocalizedField(id, "bio", lang)).to.equal(`bio in ${lang}`);
      }
      expect(await profile.getField(id, "bio")).to.equal("Builder");
    });

    it("removes one language without touching the others, by empty value or removeField", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await p.setLocalizedField(id, "bio", "fa", "الف");
      await p.setLocalizedField(id, "bio", "de", "B");

      await expect(p.setLocalizedField(id, "bio", "fa", "")).to.emit(profile, "FieldRemoved").withArgs(id, b32("bio"), b32("fa"));
      await expect(p.removeField(id, "bio", "de")).to.emit(profile, "FieldRemoved").withArgs(id, b32("bio"), b32("de"));

      expect(await profile.getLocalizedField(id, "bio", "fa")).to.equal("");
      expect(await profile.getLocalizedField(id, "bio", "de")).to.equal("");
      expect(await profile.getField(id, "bio")).to.equal("Builder");
    });

    it("an empty language is the default: setLocalizedField(key, '', v) == setField(key, v)", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).setLocalizedField(id, "company", "", "Nura"))
        .to.emit(profile, "FieldUpdated")
        .withArgs(id, b32("company"), "Nura");
      expect(await profile.getField(id, "company")).to.equal("Nura");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("items: websites, images, socials", () => {
    it("adds, updates, localizes, lists and removes websites", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      const tx = await p.addWebsite(id, "https://nurachain.net", "Nura Chain");
      await expect(tx).to.emit(profile, "ItemAdded").withArgs(id, 1n, b32("website"));
      await expect(tx).to.emit(profile, "WebsiteAdded").withArgs(id, 1n, "https://nurachain.net", "Nura Chain");
      await p.addWebsite(id, "https://github.com/NuraChain", "GitHub");

      await p.setItemAttribute(id, 1n, "title", "fa", "نورا چین");
      await p.setItemAttribute(id, 1n, "description", "", "The chain");
      await p.setItemAttribute(id, 1n, "description", "fa", "زنجیره");

      const en = await lens.getWebsites(id, "en");
      expect(en.length).to.equal(2);
      expect(en[0].id).to.equal(1n);
      expect(en[0].url).to.equal("https://nurachain.net");
      expect(en[0].title).to.equal("Nura Chain");
      expect(en[0].description).to.equal("The chain");
      expect(en[1].title).to.equal("GitHub");
      expect(en[1].description).to.equal("");

      const fa = await lens.getWebsites(id, "fa");
      expect(fa[0].title).to.equal("نورا چین");
      expect(fa[0].description).to.equal("زنجیره");
      expect(fa[1].title).to.equal("GitHub"); // fallback

      await expect(p.updateWebsite(id, 2n, "https://github.com/nurachain", "Nura on GitHub"))
        .to.emit(profile, "WebsiteUpdated")
        .withArgs(id, 2n, "https://github.com/nurachain", "Nura on GitHub");
      const one = await lens.getWebsite(id, 2n, "");
      expect(one.url).to.equal("https://github.com/nurachain");
      expect(one.title).to.equal("Nura on GitHub");

      const rm = await p.removeWebsite(id, 1n);
      await expect(rm).to.emit(profile, "WebsiteRemoved").withArgs(id, 1n);
      await expect(rm).to.emit(profile, "ItemRemoved").withArgs(id, 1n, b32("website"));
      expect(await profile.getItemIds(id, "website")).to.deep.equal([2n]);
      expect(await profile.getItemCount(id, "website")).to.equal(1n);
      expect(await profile.getItemKind(id, 1n)).to.equal("");
      // Removed means gone through every read path: the orphaned attributes are unreachable.
      await expect(lens.getWebsite(id, 1n, "")).to.be.revertedWithCustomError(profile, "ItemNotFound").withArgs(1n);
      await expect(profile.getItemAttribute(id, 1n, "url", "")).to.be.revertedWithCustomError(profile, "ItemNotFound");
      await expect(profile.resolveItemAttributes(id, 1n, ["url"], "")).to.be.revertedWithCustomError(profile, "ItemNotFound");
      await expect(p.updateWebsite(id, 1n, "x", "y")).to.be.revertedWithCustomError(profile, "ItemNotFound").withArgs(1n);
    });

    it("adds, updates and removes images with localized alt text", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await expect(p.addImage(id, "ipfs://Qm1", "gallery", "Talk at ETHGlobal"))
        .to.emit(profile, "ImageAdded")
        .withArgs(id, 1n, "ipfs://Qm1", "gallery", "Talk at ETHGlobal");
      await p.addImage(id, "ar://abc", "portfolio", "");
      await p.addImage(id, "https://cdn.example/cover.png", "cover", "Cover");
      await p.setItemAttribute(id, 1n, "alt", "de", "Vortrag bei ETHGlobal");

      const de = await lens.getImages(id, "de");
      expect(de.map((i: any) => i.uri)).to.deep.equal(["ipfs://Qm1", "ar://abc", "https://cdn.example/cover.png"]);
      expect(de.map((i: any) => i.category)).to.deep.equal(["gallery", "portfolio", "cover"]);
      expect(de[0].alt).to.equal("Vortrag bei ETHGlobal");
      expect(de[2].alt).to.equal("Cover");

      await expect(p.updateImage(id, 2n, "ar://def", "portfolio", "Portfolio piece"))
        .to.emit(profile, "ImageUpdated")
        .withArgs(id, 2n, "ar://def", "portfolio", "Portfolio piece");
      expect((await lens.getImage(id, 2n, "")).uri).to.equal("ar://def");

      // Removing the first swaps the last into its place.
      await expect(p.removeImage(id, 1n)).to.emit(profile, "ImageRemoved").withArgs(id, 1n);
      expect(await profile.getItemIds(id, "image")).to.deep.equal([3n, 2n]);
      expect((await lens.getImages(id, "")).map((i: any) => i.id)).to.deep.equal([3n, 2n]);
    });

    it("adds, updates and removes socials for any platform", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await expect(p.addSocial(id, "twitter", "alice", "https://x.com/alice"))
        .to.emit(profile, "SocialAdded")
        .withArgs(id, 1n, "twitter", "alice", "https://x.com/alice");
      await p.addSocial(id, "farcaster", "alice.eth", "");
      await p.addSocial(id, "lens", "alice.lens", "https://hey.xyz/u/alice");

      const list = await lens.getSocials(id, "");
      expect(list.map((s: any) => s.platform)).to.deep.equal(["twitter", "farcaster", "lens"]);
      expect(list[1].handle).to.equal("alice.eth");
      expect(list[1].url).to.equal("");

      await expect(p.updateSocial(id, 2n, "farcaster", "alice", "https://warpcast.com/alice"))
        .to.emit(profile, "SocialUpdated")
        .withArgs(id, 2n, "farcaster", "alice", "https://warpcast.com/alice");
      expect((await lens.getSocial(id, 2n, "")).url).to.equal("https://warpcast.com/alice");

      await expect(p.removeSocial(id, 3n)).to.emit(profile, "SocialRemoved").withArgs(id, 3n);
      expect(await profile.getItemIds(id, "social")).to.deep.equal([1n, 2n]);
    });

    it("keeps typed functions on their own kind", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await p.addWebsite(id, "https://a", "A"); // 1
      await p.addImage(id, "ipfs://b", "gallery", "B"); // 2

      await expect(p.removeWebsite(id, 2n))
        .to.be.revertedWithCustomError(profile, "ItemKindMismatch")
        .withArgs(2n, b32("website"), b32("image"));
      await expect(p.updateImage(id, 1n, "x", "y", "z")).to.be.revertedWithCustomError(profile, "ItemKindMismatch");
      await expect(p.removeSocial(id, 1n)).to.be.revertedWithCustomError(profile, "ItemKindMismatch");
      await expect(p.updateSocial(id, 2n, "x", "y", "z")).to.be.revertedWithCustomError(profile, "ItemKindMismatch");
      expect((await lens.getWebsite(id, 2n, "")).url).to.equal(""); // lens is a projection, not a validator: an image has no url attribute
    });

    it("has no cap on how many websites, images or socials a profile holds", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      for (let i = 0; i < 12; i++) await p.addWebsite(id, `https://site${i}.example`, `Site ${i}`);
      for (let i = 0; i < 9; i++) await p.addSocial(id, `platform${i}`, `alice${i}`, "");

      expect(await profile.getItemCount(id, "website")).to.equal(12n);
      expect(await profile.getItemCount(id, "social")).to.equal(9n);
      const full = await lens.getFullProfile(alice.address, "");
      expect(full.websites.length).to.equal(12);
      expect(full.socials.length).to.equal(9);
      expect(full.images.length).to.equal(0);
      expect(full.profile.username).to.equal("alice");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("items: generic kinds", () => {
    it("stores items of any kind with arbitrary, localizable attributes", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      const tx = await p.addItem(id, "wallet", [
        { key: "chain", lang: "", value: "bitcoin" },
        { key: "address", lang: "", value: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" },
        { key: "label", lang: "en", value: "Cold storage" },
        { key: "label", lang: "fa", value: "کیف پول سرد" },
      ]);
      await expect(tx).to.emit(profile, "ItemAdded").withArgs(id, 1n, b32("wallet"));
      await expect(tx).to.emit(profile, "ItemAttributeUpdated").withArgs(id, 1n, b32("chain"), ZERO32, "bitcoin");
      await expect(tx).to.emit(profile, "ItemAttributeUpdated").withArgs(id, 1n, b32("label"), b32("fa"), "کیف پول سرد");

      expect(await profile.getItemKind(id, 1n)).to.equal("wallet");
      expect(await profile.getItemAttribute(id, 1n, "chain", "")).to.equal("bitcoin");
      expect(await profile.getItemAttribute(id, 1n, "label", "en")).to.equal("Cold storage");
      expect(await profile.getItemAttribute(id, 1n, "label", "")).to.equal(""); // exact
      expect(await profile.resolveItemAttribute(id, 1n, "label", "de")).to.equal(""); // no default to fall back to
      expect(await profile.resolveItemAttribute(id, 1n, "label", "fa")).to.equal("کیف پول سرد");
      expect(await profile.resolveItemAttributes(id, 1n, ["chain", "address", "label"], "en")).to.deep.equal([
        "bitcoin",
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        "Cold storage",
      ]);

      const [items, total] = await lens.getItems(id, "wallet", "fa", ["chain", "label"], 0, 0);
      expect(total).to.equal(1n);
      expect(items[0].id).to.equal(1n);
      expect(items[0].attributes).to.deep.equal(["bitcoin", "کیف پول سرد"]);
    });

    it("updates and removes attributes, with empty meaning removed", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await p.addItem(id, "credential", [{ key: "issuer", lang: "", value: "Nura DAO" }]);

      await p.setItemAttributes(id, 1n, [
        { key: "issuer", lang: "", value: "Nura Foundation" },
        { key: "expires", lang: "", value: "2027-01-01" },
      ]);
      expect(await profile.getItemAttribute(id, 1n, "issuer", "")).to.equal("Nura Foundation");

      await expect(p.setItemAttribute(id, 1n, "expires", "", ""))
        .to.emit(profile, "ItemAttributeRemoved")
        .withArgs(id, 1n, b32("expires"), ZERO32);
      expect(await profile.getItemAttribute(id, 1n, "expires", "")).to.equal("");

      await expect(p.setItemAttribute(id, 7n, "x", "", "y")).to.be.revertedWithCustomError(profile, "ItemNotFound").withArgs(7n);
      await expect(p.setItemAttributes(id, 7n, [])).to.be.revertedWithCustomError(profile, "ItemNotFound");
      await expect(p.setItemAttribute(id, 1n, "x", "", "y".repeat(4097))).to.be.revertedWithCustomError(profile, "ValueTooLong");
    });

    it("gives ids per profile, never reuses them, and keeps every kind's list consistent", async () => {
      const { profile, alice, bob, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await profile.connect(bob).createProfile("bob", "", "", "");

      await p.addItem(id, "nft", []); // 1
      await p.addWebsite(id, "https://a", "A"); // 2
      await p.addItem(id, "nft", []); // 3
      await p.addItem(id, "nft", []); // 4
      await profile.connect(bob).addItem(2n, "nft", []); // Bob's own #1

      expect(await profile.getItemIds(id, "nft")).to.deep.equal([1n, 3n, 4n]);
      expect(await profile.getItemIds(id, "website")).to.deep.equal([2n]);
      expect(await profile.getItemIds(2n, "nft")).to.deep.equal([1n]);

      await expect(p.removeItem(id, 1n)).to.emit(profile, "ItemRemoved").withArgs(id, 1n, b32("nft"));
      expect(await profile.getItemIds(id, "nft")).to.deep.equal([4n, 3n]); // swap-and-pop
      await p.removeItem(id, 3n);
      expect(await profile.getItemIds(id, "nft")).to.deep.equal([4n]);
      await p.removeItem(id, 4n);
      expect(await profile.getItemIds(id, "nft")).to.deep.equal([]);
      expect(await profile.getItemIds(id, "website")).to.deep.equal([2n]);

      await p.addItem(id, "nft", []);
      expect(await profile.getItemIds(id, "nft")).to.deep.equal([5n]); // 1, 3, 4 stay retired
      expect((await profile.getProfileRecord(id)).itemsCreated).to.equal(5n);

      await expect(p.removeItem(id, 1n)).to.be.revertedWithCustomError(profile, "ItemNotFound").withArgs(1n);
      await expect(p.removeItem(id, 99n)).to.be.revertedWithCustomError(profile, "ItemNotFound");
    });

    it("validates kinds: 1..28 printable ASCII bytes", async () => {
      const { profile, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);

      await p.addItem(id, "k".repeat(28), []);
      expect(await profile.getItemKind(id, 1n)).to.equal("k".repeat(28));

      for (const bad of ["", "k".repeat(29), "two words", "kïnd"]) {
        await expect(p.addItem(id, bad, []), bad).to.be.revertedWithCustomError(profile, "InvalidKind");
        await expect(profile.getItemIds(id, bad), bad).to.be.revertedWithCustomError(profile, "InvalidKind");
      }
    });

    it("pages through a kind with the lens", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      for (let i = 1; i <= 5; i++) await p.addItem(id, "badge", [{ key: "name", lang: "", value: `Badge ${i}` }]);

      let [page, total] = await lens.getItems(id, "badge", "", ["name"], 0, 2);
      expect(total).to.equal(5n);
      expect(page.map((it: any) => it.attributes[0])).to.deep.equal(["Badge 1", "Badge 2"]);

      [page] = await lens.getItems(id, "badge", "", ["name"], 2, 2);
      expect(page.map((it: any) => it.attributes[0])).to.deep.equal(["Badge 3", "Badge 4"]);

      [page] = await lens.getItems(id, "badge", "", ["name"], 4, 10); // clipped
      expect(page.map((it: any) => it.attributes[0])).to.deep.equal(["Badge 5"]);

      [page] = await lens.getItems(id, "badge", "", ["name"], 9, 2); // past the end
      expect(page.length).to.equal(0);

      [page, total] = await lens.getItems(id, "badge", "", ["name", "missing"], 0, 0); // 0 = all
      expect(page.length).to.equal(5);
      expect(page[4].attributes).to.deep.equal(["Badge 5", ""]);
      expect(total).to.equal(5n);

      [page, total] = await lens.getItems(id, "unknown-kind", "", ["name"], 0, 0);
      expect(page.length).to.equal(0);
      expect(total).to.equal(0n);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("operators", () => {
    it("lets an approved operator edit content but nothing identity-level", async () => {
      const { profile, alice, bob, operator, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).setOperator(operator.address, true))
        .to.emit(profile, "OperatorSet")
        .withArgs(alice.address, operator.address, true);
      expect(await profile.isOperator(alice.address, operator.address)).to.equal(true);
      expect(await profile.isAuthorized(id, operator.address)).to.equal(true);
      expect(await profile.isAuthorized(id, alice.address)).to.equal(true);
      expect(await profile.isAuthorized(id, bob.address)).to.equal(false);
      expect(await profile.isAuthorized(99n, alice.address)).to.equal(false);

      const asOp = profile.connect(operator);
      await asOp.setField(id, "location", "Lisbon");
      await asOp.setLocalizedField(id, "location", "pt", "Lisboa");
      await asOp.addWebsite(id, "https://op", "By operator");
      await asOp.addItem(id, "wallet", []);
      await asOp.setItemAttribute(id, 1n, "title", "fa", "x");
      await asOp.removeItem(id, 2n);
      await asOp.removeField(id, "location", "pt");
      expect(await profile.getField(id, "location")).to.equal("Lisbon");

      await expect(asOp.setUsername(id, "op_alice")).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asOp.deleteProfile(id)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asOp.transferProfile(id, bob.address)).to.be.revertedWithCustomError(profile, "NotOwnerOrRecovery");
      await expect(asOp.setRecoveryAddress(id, bob.address)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asOp.approveExtension(id, "x", true)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
    });

    it("revokes, and rejects the zero address or yourself as operator", async () => {
      const { profile, alice, operator, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setOperator(operator.address, true);
      await profile.connect(alice).setOperator(operator.address, false);

      expect(await profile.isOperator(alice.address, operator.address)).to.equal(false);
      await expect(profile.connect(operator).setField(id, "bio", "x")).to.be.revertedWithCustomError(profile, "NotAuthorized");

      await expect(profile.connect(alice).setOperator(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(profile, "ZeroAddress");
      await expect(profile.connect(alice).setOperator(alice.address, true))
        .to.be.revertedWithCustomError(profile, "InvalidAddress")
        .withArgs(alice.address);
    });

    it("is keyed by owner, so it does not follow a profile to its new owner", async () => {
      const { profile, alice, bob, operator, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setOperator(operator.address, true);
      await profile.connect(alice).transferProfile(id, bob.address);
      await profile.connect(bob).acceptProfile(id);

      await expect(profile.connect(operator).setField(id, "bio", "x")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await profile.connect(bob).setOperator(operator.address, true);
      await profile.connect(operator).setField(id, "bio", "x");
      expect(await profile.getField(id, "bio")).to.equal("x");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("transfer and recovery", () => {
    it("moves a profile in two steps and re-keys every index", async () => {
      const { profile, lens, alice, bob, recovery, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setRecoveryAddress(id, recovery.address);

      await expect(profile.connect(alice).transferProfile(id, bob.address))
        .to.emit(profile, "ProfileTransferInitiated")
        .withArgs(id, alice.address, bob.address);
      expect(await profile.pendingOwnerOf(id)).to.equal(bob.address);
      expect(await profile.ownerOf(id)).to.equal(alice.address); // nothing moved yet

      const tx = await profile.connect(bob).acceptProfile(id);
      await expect(tx).to.emit(profile, "ProfileTransferred").withArgs(id, alice.address, bob.address);
      await expect(tx).to.emit(profile, "ProfileUpdated").withArgs(id);

      expect(await profile.ownerOf(id)).to.equal(bob.address);
      expect(await profile.profileIdOf(bob.address)).to.equal(id);
      expect(await profile.profileIdOf(alice.address)).to.equal(0n);
      expect(await profile.pendingOwnerOf(id)).to.equal(ethers.ZeroAddress);
      expect(await profile.recoveryAddressOf(id)).to.equal(ethers.ZeroAddress); // previous owner's choice, cleared
      expect((await profile.resolveUsername("alice"))[1]).to.equal(bob.address);
      expect((await lens.getProfile(bob.address, "")).bio).to.equal("Builder"); // content came along
      expect((await lens.getProfile(alice.address, "")).id).to.equal(0n);

      // Alice can now start over; Bob edits; Alice cannot.
      await profile.connect(alice).createProfile("alice_again", "", "", "");
      await profile.connect(bob).setField(id, "bio", "Bob's now");
      await expect(profile.connect(alice).setField(id, "bio", "mine")).to.be.revertedWithCustomError(profile, "NotAuthorized");
    });

    it("validates the recipient at both steps", async () => {
      const { profile, alice, bob, carol, id } = await loadFixture(deployWithAlice);
      await profile.connect(carol).createProfile("carol", "", "", "");

      await expect(profile.connect(alice).transferProfile(id, ethers.ZeroAddress)).to.be.revertedWithCustomError(profile, "ZeroAddress");
      await expect(profile.connect(alice).transferProfile(id, alice.address))
        .to.be.revertedWithCustomError(profile, "InvalidAddress")
        .withArgs(alice.address);
      await expect(profile.connect(alice).transferProfile(id, carol.address))
        .to.be.revertedWithCustomError(profile, "AlreadyHasProfile")
        .withArgs(carol.address);

      await profile.connect(alice).transferProfile(id, bob.address);
      await expect(profile.connect(carol).acceptProfile(id))
        .to.be.revertedWithCustomError(profile, "NotPendingOwner")
        .withArgs(id, carol.address);

      // Bob creates a profile of his own before accepting: the accept must now fail.
      await profile.connect(bob).createProfile("bob", "", "", "");
      await expect(profile.connect(bob).acceptProfile(id))
        .to.be.revertedWithCustomError(profile, "AlreadyHasProfile")
        .withArgs(bob.address);
      await expect(profile.connect(bob).acceptProfile(99n)).to.be.revertedWithCustomError(profile, "ProfileNotFound");
    });

    it("can be cancelled by the owner or the recovery address, and only while pending", async () => {
      const { profile, alice, bob, recovery, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setRecoveryAddress(id, recovery.address);

      await expect(profile.connect(alice).cancelTransfer(id)).to.be.revertedWithCustomError(profile, "NoPendingTransfer").withArgs(id);

      await profile.connect(alice).transferProfile(id, bob.address);
      await expect(profile.connect(bob).cancelTransfer(id)).to.be.revertedWithCustomError(profile, "NotOwnerOrRecovery");
      await expect(profile.connect(recovery).cancelTransfer(id)).to.emit(profile, "ProfileTransferCancelled").withArgs(id);
      expect(await profile.pendingOwnerOf(id)).to.equal(ethers.ZeroAddress);
      await expect(profile.connect(bob).acceptProfile(id)).to.be.revertedWithCustomError(profile, "NotPendingOwner");

      await profile.connect(alice).transferProfile(id, bob.address);
      await profile.connect(alice).cancelTransfer(id);
      expect(await profile.pendingOwnerOf(id)).to.equal(ethers.ZeroAddress);
    });

    it("lets the recovery address move the profile when the owner key is lost — and nothing else", async () => {
      const { profile, alice, bob, recovery, id } = await loadFixture(deployWithAlice);

      await expect(profile.connect(alice).setRecoveryAddress(id, recovery.address))
        .to.emit(profile, "RecoveryAddressSet")
        .withArgs(id, recovery.address);
      expect(await profile.recoveryAddressOf(id)).to.equal(recovery.address);
      await expect(profile.connect(alice).setRecoveryAddress(id, alice.address)).to.be.revertedWithCustomError(profile, "InvalidAddress");
      await expect(profile.connect(bob).setRecoveryAddress(id, bob.address)).to.be.revertedWithCustomError(profile, "NotProfileOwner");

      const asRecovery = profile.connect(recovery);
      await expect(asRecovery.setField(id, "bio", "x")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await expect(asRecovery.setUsername(id, "stolen")).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asRecovery.deleteProfile(id)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asRecovery.acceptProfile(id)).to.be.revertedWithCustomError(profile, "NotPendingOwner");

      await asRecovery.transferProfile(id, bob.address); // Alice's new wallet
      await profile.connect(bob).acceptProfile(id);
      expect(await profile.ownerOf(id)).to.equal(bob.address);
      expect(await profile.recoveryAddressOf(id)).to.equal(ethers.ZeroAddress);
      await expect(asRecovery.transferProfile(id, alice.address)).to.be.revertedWithCustomError(profile, "NotOwnerOrRecovery");

      // Clearing the recovery address works too.
      await profile.connect(bob).setRecoveryAddress(id, recovery.address);
      await profile.connect(bob).setRecoveryAddress(id, ethers.ZeroAddress);
      expect(await profile.recoveryAddressOf(id)).to.equal(ethers.ZeroAddress);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("deletion", () => {
    it("retires the id, releases the username and frees the address", async () => {
      const { profile, lens, alice, bob, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).addWebsite(id, "https://a", "A");

      await expect(profile.connect(alice).deleteProfile(id))
        .to.emit(profile, "ProfileDeleted")
        .withArgs(id, alice.address, b32("alice"));

      expect(await profile.profileIdOf(alice.address)).to.equal(0n);
      expect(await profile.ownerOf(id)).to.equal(ethers.ZeroAddress);
      expect(await profile.exists(id)).to.equal(false);
      expect((await lens.getProfile(alice.address, "")).id).to.equal(0n);
      expect((await profile.resolveUsername("alice"))[0]).to.equal(0n);
      expect(await profile.isUsernameAvailable("alice")).to.equal(true);

      // Every id-based read closes: no stale content leaks through the API.
      for (const call of [
        () => profile.getField(id, "bio"),
        () => profile.resolveField(id, "bio", "en"),
        () => profile.getItemIds(id, "website"),
        () => profile.getItemAttribute(id, 1n, "url", ""),
        () => profile.getProfileRecord(id),
        () => lens.getProfileById(id, ""),
        () => lens.getWebsites(id, ""),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(profile, "ProfileNotFound").withArgs(id);
      }
      for (const call of [
        () => profile.connect(alice).setField(id, "bio", "x"),
        () => profile.connect(alice).deleteProfile(id),
        () => profile.connect(alice).transferProfile(id, bob.address),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(profile, "ProfileNotFound");
      }

      // A new profile gets a new id; the old one is never reused; the name is free again.
      await profile.connect(bob).createProfile("alice", "", "", "");
      expect(await profile.profileIdOf(bob.address)).to.equal(2n);
      await profile.connect(alice).createProfile("alice_v2", "", "", "");
      expect(await profile.profileIdOf(alice.address)).to.equal(3n);
      expect(await profile.profilesCreated()).to.equal(3n);
    });

    it("is owner-only", async () => {
      const { profile, bob, operator, alice, id } = await loadFixture(deployWithAlice);
      await profile.connect(alice).setOperator(operator.address, true);

      await expect(profile.connect(bob).deleteProfile(id)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(profile.connect(operator).deleteProfile(id)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("extensions", () => {
    it("registers an extension that passes the handshake, and lists it", async () => {
      const { profile, proxyAddress, admin } = await loadFixture(deployWithAlice);
      const ext = await ethers.deployContract("MockExtension", [proxyAddress, b32("mock-ext")], admin);
      const extAddress = await ext.getAddress();

      await expect(profile.registerExtension("mock-ext", extAddress))
        .to.emit(profile, "ExtensionAdded")
        .withArgs(b32("mock-ext"), extAddress);

      expect(await profile.getExtension("mock-ext")).to.equal(extAddress);
      expect(await profile.extensionIdOf(extAddress)).to.equal(b32("mock-ext"));
      const [ids, addrs] = await profile.getExtensions();
      expect(ids).to.deep.equal([b32("mock-ext")]);
      expect(addrs).to.deep.equal([extAddress]);
    });

    it("rejects impostors: wrong id, wrong registry, no ERC165, zero, duplicates, non-admin", async () => {
      const { profile, proxyAddress, admin, alice } = await loadFixture(deployWithAlice);
      const ext = await ethers.deployContract("MockExtension", [proxyAddress, b32("mock-ext")], admin);
      const extAddress = await ext.getAddress();
      const notExt = await ethers.deployContract("NotAnExtension", [], admin);

      await expect(profile.registerExtension("other-id", extAddress))
        .to.be.revertedWithCustomError(profile, "ExtensionIdMismatch")
        .withArgs(b32("other-id"), b32("mock-ext"));

      await ext.setReportedRegistry(alice.address);
      await expect(profile.registerExtension("mock-ext", extAddress))
        .to.be.revertedWithCustomError(profile, "InvalidExtension")
        .withArgs(extAddress);
      await ext.setReportedRegistry(proxyAddress);

      await ext.setClaimsInterface(false);
      await expect(profile.registerExtension("mock-ext", extAddress)).to.be.revertedWithCustomError(profile, "InvalidExtension");
      await ext.setClaimsInterface(true);

      await expect(profile.registerExtension("impostor", await notExt.getAddress())).to.be.revertedWithCustomError(
        profile,
        "InvalidExtension",
      );
      await expect(profile.registerExtension("eoa", alice.address)).to.be.revertedWithCustomError(profile, "InvalidExtension");
      await expect(profile.registerExtension("mock-ext", ethers.ZeroAddress)).to.be.revertedWithCustomError(profile, "ZeroAddress");
      await expect(profile.registerExtension("", extAddress)).to.be.revertedWithCustomError(profile, "InvalidKey");
      await expect(profile.connect(alice).registerExtension("mock-ext", extAddress)).to.be.revertedWithCustomError(
        profile,
        "OwnableUnauthorizedAccount",
      );

      await profile.registerExtension("mock-ext", extAddress);
      await expect(profile.registerExtension("mock-ext", extAddress))
        .to.be.revertedWithCustomError(profile, "ExtensionAlreadyRegistered")
        .withArgs(b32("mock-ext"));
      const twin = await ethers.deployContract("MockExtension", [proxyAddress, b32("twin")], admin);
      await twin.setReportedId(b32("mock-ext"));
      await expect(profile.registerExtension("mock-ext", await twin.getAddress())).to.be.revertedWithCustomError(
        profile,
        "ExtensionAlreadyRegistered",
      );
      // Same address under a second id is refused too: one address, one namespace.
      await ext.setReportedId(b32("second"));
      await expect(profile.registerExtension("second", extAddress)).to.be.revertedWithCustomError(profile, "ExtensionAlreadyRegistered");
    });

    it("unregisters with swap-and-pop, and only the admin may", async () => {
      const { profile, proxyAddress, admin, alice } = await loadFixture(deployWithAlice);
      const exts = [];
      for (const id of ["ext-a", "ext-b", "ext-c"]) {
        const e = await ethers.deployContract("MockExtension", [proxyAddress, b32(id)], admin);
        await profile.registerExtension(id, await e.getAddress());
        exts.push(await e.getAddress());
      }

      await expect(profile.connect(alice).unregisterExtension("ext-a")).to.be.revertedWithCustomError(
        profile,
        "OwnableUnauthorizedAccount",
      );
      await expect(profile.unregisterExtension("nope")).to.be.revertedWithCustomError(profile, "ExtensionNotRegistered").withArgs(b32("nope"));

      await expect(profile.unregisterExtension("ext-a")).to.emit(profile, "ExtensionRemoved").withArgs(b32("ext-a"), exts[0]);
      let [ids, addrs] = await profile.getExtensions();
      expect(ids).to.deep.equal([b32("ext-c"), b32("ext-b")]);
      expect(addrs).to.deep.equal([exts[2], exts[1]]);
      expect(await profile.getExtension("ext-a")).to.equal(ethers.ZeroAddress);
      expect(await profile.extensionIdOf(exts[0])).to.equal(ZERO32);

      await profile.unregisterExtension("ext-b");
      [ids] = await profile.getExtensions();
      expect(ids).to.deep.equal([b32("ext-c")]);
      await profile.unregisterExtension("ext-c");
      [ids] = await profile.getExtensions();
      expect(ids).to.deep.equal([]);

      // Re-registration after removal works.
      await profile.registerExtension("ext-a", exts[0]);
      expect(await profile.getExtension("ext-a")).to.equal(exts[0]);
    });

    it("writes only into its own namespace, and only after the owner opted in", async () => {
      const { profile, proxyAddress, admin, alice, id } = await loadFixture(deployWithAlice);
      const ext = await ethers.deployContract("MockExtension", [proxyAddress, b32("mock-ext")], admin);

      // Not registered: cannot write, and the owner cannot even approve an unknown id.
      await expect(ext.write(id, "score", "", "10")).to.be.revertedWithCustomError(profile, "ExtensionNotRegistered").withArgs(ZERO32);
      await expect(profile.connect(alice).approveExtension(id, "mock-ext", true))
        .to.be.revertedWithCustomError(profile, "ExtensionNotRegistered")
        .withArgs(b32("mock-ext"));

      await profile.registerExtension("mock-ext", await ext.getAddress());
      await expect(ext.write(id, "score", "", "10"))
        .to.be.revertedWithCustomError(profile, "ExtensionNotApproved")
        .withArgs(id, b32("mock-ext"));
      expect(await profile.isExtensionApproved(id, "mock-ext")).to.equal(false);

      await expect(profile.connect(alice).approveExtension(id, "mock-ext", true))
        .to.emit(profile, "ExtensionApprovalSet")
        .withArgs(id, b32("mock-ext"), true);
      expect(await profile.isExtensionApproved(id, "mock-ext")).to.equal(true);

      const tx = await ext.write(id, "score", "", "10");
      await expect(tx).to.emit(profile, "ExtensionFieldUpdated").withArgs(id, b32("mock-ext"), b32("score"), ZERO32, "10");
      await expect(tx).to.emit(profile, "ProfileUpdated").withArgs(id);
      await ext.write(id, "title", "en", "Gold contributor");
      await ext.write(id, "title", "fa", "همکار طلایی");

      expect(await profile.getExtensionField(id, "mock-ext", "score", "")).to.equal("10");
      expect(await profile.getExtensionField(id, "mock-ext", "title", "fa")).to.equal("همکار طلایی");
      expect(await profile.getField(id, "score")).to.equal(""); // never touches the owner's fields

      // Non-existent profile, and validation, still apply to extensions.
      await expect(ext.write(99n, "score", "", "1")).to.be.revertedWithCustomError(profile, "ProfileNotFound");
      await expect(ext.write(id, "bad key", "", "1")).to.be.revertedWithCustomError(profile, "InvalidKey");
      await expect(ext.write(id, "score", "", "x".repeat(4097))).to.be.revertedWithCustomError(profile, "ValueTooLong");

      // Revoking approval closes the door; existing data stays readable.
      await profile.connect(alice).approveExtension(id, "mock-ext", false);
      await expect(ext.write(id, "score", "", "11")).to.be.revertedWithCustomError(profile, "ExtensionNotApproved");
      expect(await profile.getExtensionField(id, "mock-ext", "score", "")).to.equal("10");

      // Unregistering closes it for good; data stays readable under the old namespace.
      await profile.connect(alice).approveExtension(id, "mock-ext", true);
      await profile.unregisterExtension("mock-ext");
      await expect(ext.write(id, "score", "", "12")).to.be.revertedWithCustomError(profile, "ExtensionNotRegistered");
      expect(await profile.getExtensionField(id, "mock-ext", "score", "")).to.equal("10");
    });

    it("lets the extension, the owner or an operator remove an extension field — nobody else", async () => {
      const { profile, ext, proxyAddress, admin, alice, bob, operator, id } = await loadFixture(deployWithExtension);
      await ext.write(id, "score", "", "10");
      await ext.write(id, "score", "fa", "ده");

      // A different registered extension cannot reach into this namespace.
      const other = await ethers.deployContract("MockExtension", [proxyAddress, b32("other")], admin);
      await profile.registerExtension("other", await other.getAddress());
      await expect(other.remove(id, "mock-ext", "score", "")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await expect(profile.connect(bob).removeExtensionField(id, "mock-ext", "score", "")).to.be.revertedWithCustomError(
        profile,
        "NotAuthorized",
      );

      // Empty value from the extension removes.
      await expect(ext.write(id, "score", "fa", "")).to.emit(profile, "ExtensionFieldRemoved").withArgs(id, b32("mock-ext"), b32("score"), b32("fa"));
      expect(await profile.getExtensionField(id, "mock-ext", "score", "fa")).to.equal("");

      // The extension removes its own; the owner and operators remove anything on their profile.
      await ext.write(id, "a", "", "1");
      await ext.write(id, "b", "", "2");
      await ext.write(id, "c", "", "3");
      await expect(ext.remove(id, "mock-ext", "a", "")).to.emit(profile, "ExtensionFieldRemoved").withArgs(id, b32("mock-ext"), b32("a"), ZERO32);
      await profile.connect(alice).removeExtensionField(id, "mock-ext", "b", "");
      await profile.connect(alice).setOperator(operator.address, true);
      await profile.connect(operator).removeExtensionField(id, "mock-ext", "c", "");
      expect(await profile.resolveFields(id, ["a"], "")).to.deep.equal([""]); // owner fields untouched, still empty
      for (const k of ["a", "b", "c"]) expect(await profile.getExtensionField(id, "mock-ext", k, "")).to.equal("");
      expect(await profile.getExtensionField(id, "mock-ext", "score", "")).to.equal("10");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("SocialVerifier extension", () => {
    const TYPES = {
      VerifyHandle: [
        { name: "profileId", type: "uint256" },
        { name: "platform", type: "string" },
        { name: "handle", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function domainFor(verifier: any) {
      return {
        name: "NuraSocialVerifier",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await verifier.getAddress(),
      };
    }

    it("passes the handshake and is registered under its id", async () => {
      const { profile, verifier, proxyAddress, signer } = await loadFixture(deployWithVerifier);

      expect(await verifier.extensionId()).to.equal(b32("social-verifier"));
      expect(await verifier.profileRegistry()).to.equal(proxyAddress);
      expect(await verifier.supportsInterface(await interfaceIdOf("IProfileExtension"))).to.equal(true);
      expect(await verifier.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await verifier.hasRole(await verifier.VERIFIER_ROLE(), signer.address)).to.equal(true);
      expect(await profile.getExtension("social-verifier")).to.equal(await verifier.getAddress());
    });

    it("records a signed handle on the profile, once per signature", async () => {
      const { profile, verifier, alice, signer, id } = await loadFixture(deployWithVerifier);
      const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
      const value = { profileId: id, platform: "github", handle: "alice-dev", nonce: 0n, deadline };
      const domain = await domainFor(verifier);

      // The on-chain digest is exactly what a wallet library produces for the same data.
      expect(await verifier.hashVerifyHandle(id, "github", "alice-dev", deadline)).to.equal(
        ethers.TypedDataEncoder.hash(domain, TYPES, value),
      );

      const sig = await signer.signTypedData(domain, TYPES, value);
      const tx = await verifier.connect(alice).verifyHandle(id, "github", "alice-dev", deadline, sig);
      await expect(tx).to.emit(verifier, "HandleVerified").withArgs(id, b32("github"), "alice-dev", signer.address);
      await expect(tx).to.emit(profile, "ExtensionFieldUpdated").withArgs(id, b32("social-verifier"), b32("github"), ZERO32, "alice-dev");

      expect(await verifier.verifiedHandle(id, "github")).to.equal("alice-dev");
      expect(await profile.getExtensionField(id, "social-verifier", "github", "")).to.equal("alice-dev");
      expect(await verifier.nonces(id)).to.equal(1n);

      // Replay: the nonce moved on.
      await expect(verifier.connect(alice).verifyHandle(id, "github", "alice-dev", deadline, sig)).to.be.revertedWithCustomError(
        verifier,
        "InvalidSignature",
      );
    });

    it("rejects the wrong signer, an expired deadline, tampered fields, and unauthorized submitters", async () => {
      const { profile, verifier, alice, bob, operator, signer, id } = await loadFixture(deployWithVerifier);
      const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
      const domain = await domainFor(verifier);
      const value = { profileId: id, platform: "twitter", handle: "alice", nonce: 0n, deadline };

      const badSig = await bob.signTypedData(domain, TYPES, value);
      await expect(verifier.connect(alice).verifyHandle(id, "twitter", "alice", deadline, badSig)).to.be.revertedWithCustomError(
        verifier,
        "InvalidSignature",
      );

      const sig = await signer.signTypedData(domain, TYPES, value);
      await expect(verifier.connect(alice).verifyHandle(id, "twitter", "mallory", deadline, sig)).to.be.revertedWithCustomError(
        verifier,
        "InvalidSignature",
      );
      await expect(verifier.connect(alice).verifyHandle(id, "github", "alice", deadline, sig)).to.be.revertedWithCustomError(
        verifier,
        "InvalidSignature",
      );
      await expect(verifier.connect(bob).verifyHandle(id, "twitter", "alice", deadline, sig))
        .to.be.revertedWithCustomError(verifier, "NotAuthorized")
        .withArgs(id, bob.address);

      // An operator may submit on the owner's behalf.
      await profile.connect(alice).setOperator(operator.address, true);
      await verifier.connect(operator).verifyHandle(id, "twitter", "alice", deadline, sig);
      expect(await verifier.verifiedHandle(id, "twitter")).to.equal("alice");

      // Expired.
      const late = { ...value, nonce: 1n, deadline: deadline - 7200n };
      const lateSig = await signer.signTypedData(domain, TYPES, late);
      await expect(verifier.connect(alice).verifyHandle(id, "twitter", "alice", late.deadline, lateSig))
        .to.be.revertedWithCustomError(verifier, "SignatureExpired")
        .withArgs(late.deadline);

      // Without the core-side approval, a valid signature still cannot land.
      await profile.connect(alice).approveExtension(id, "social-verifier", false);
      const next = { ...value, nonce: 1n };
      const nextSig = await signer.signTypedData(domain, TYPES, next);
      await expect(verifier.connect(alice).verifyHandle(id, "twitter", "alice", deadline, nextSig)).to.be.revertedWithCustomError(
        profile,
        "ExtensionNotApproved",
      );
    });

    it("lets a verifier revoke, and the owner clear, a verification", async () => {
      const { profile, verifier, alice, bob, signer, id } = await loadFixture(deployWithVerifier);
      const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
      const domain = await domainFor(verifier);
      for (const [platform, handle, nonce] of [
        ["github", "alice-dev", 0n],
        ["telegram", "alice_tg", 1n],
      ] as const) {
        const sig = await signer.signTypedData(domain, TYPES, { profileId: id, platform, handle, nonce, deadline });
        await verifier.connect(alice).verifyHandle(id, platform, handle, deadline, sig);
      }

      await expect(verifier.connect(bob).revokeHandle(id, "github")).to.be.revertedWithCustomError(
        verifier,
        "AccessControlUnauthorizedAccount",
      );
      await expect(verifier.connect(signer).revokeHandle(id, "github")).to.emit(verifier, "HandleRevoked").withArgs(id, b32("github"));
      expect(await verifier.verifiedHandle(id, "github")).to.equal("");

      await profile.connect(alice).removeExtensionField(id, "social-verifier", "telegram", "");
      expect(await verifier.verifiedHandle(id, "telegram")).to.equal("");
    });

    it("rejects a zero admin, signer or registry", async () => {
      const { proxyAddress, admin, signer } = await loadFixture(deployProfile);
      const factory = await ethers.getContractFactory("SocialVerifier");
      await expect(factory.deploy(ethers.ZeroAddress, signer.address, proxyAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, proxyAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, signer.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("upgradeability", () => {
    it("upgrades to a V2 that keeps every profile, field, item and username intact", async () => {
      const { profile, lens, proxyAddress, admin, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await p.setLocalizedField(id, "bio", "fa", "بایو");
      await p.addWebsite(id, "https://nurachain.net", "Nura");
      await p.addItem(id, "wallet", [{ key: "chain", lang: "", value: "btc" }]);
      const recordBefore = await profile.getProfileRecord(id);
      const fullBefore = await lens.getFullProfile(alice.address, "fa");

      const v2 = await ethers.deployContract("NuraProfileV2Mock", [], admin);
      const v2Address = await v2.getAddress();
      const upgradeCall = v2.interface.encodeFunctionData("initializeV2", ["hello from v2"]);
      await expect(profile.upgradeToAndCall(v2Address, upgradeCall)).to.emit(profile, "Upgraded").withArgs(v2Address);

      const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      expect("0x" + (await ethers.provider.getStorage(proxyAddress, implSlot)).slice(-40)).to.equal(v2Address.toLowerCase());

      const upgraded = await ethers.getContractAt("NuraProfileV2Mock", proxyAddress, alice);
      expect(await upgraded.version()).to.equal("2.0.0-mock");
      expect(await upgraded.greeting()).to.equal("hello from v2");
      expect(await upgraded.bump.staticCall()).to.equal(1n);
      expect(await upgraded.VERSION()).to.equal("1.0.0"); // inherited constant, as a real V2 would bump it

      // V1 state, byte for byte.
      expect(await upgraded.getProfileRecord(id)).to.deep.equal(recordBefore);
      expect(await lens.getFullProfile(alice.address, "fa")).to.deep.equal(fullBefore);
      expect(await upgraded.usernameOf(id)).to.equal("alice");
      expect(await upgraded.getItemAttribute(id, 2n, "chain", "")).to.equal("btc");
      expect(await upgraded.owner()).to.equal(admin.address);
      expect(await upgraded.profilesCreated()).to.equal(1n);

      // And it keeps working.
      await upgraded.setField(id, "company", "Nura");
      expect(await upgraded.getField(id, "company")).to.equal("Nura");
      await expect(upgraded.initializeV2("again")).to.be.revertedWithCustomError(upgraded, "InvalidInitialization");
    });

    it("refuses upgrades from anyone but the owner, and to anything that is not a UUPS implementation", async () => {
      const { profile, lens, alice, admin } = await loadFixture(deployWithAlice);
      const v2 = await ethers.deployContract("NuraProfileV2Mock", [], admin);

      await expect(profile.connect(alice).upgradeToAndCall(await v2.getAddress(), "0x")).to.be.revertedWithCustomError(
        profile,
        "OwnableUnauthorizedAccount",
      );
      await expect(profile.upgradeToAndCall(await lens.getAddress(), "0x")).to.be.revertedWithCustomError(
        profile,
        "ERC1967InvalidImplementation",
      );
      // An EOA has no code to call: Solidity fails the return-data decode before the try/catch, so the revert is bare.
      await expect(profile.upgradeToAndCall(alice.address, "0x")).to.be.revert(ethers);
      // The implementation itself refuses to be upgraded directly (onlyProxy).
      const { impl } = await loadFixture(deployWithAlice);
      await expect(impl.upgradeToAndCall(await v2.getAddress(), "0x")).to.be.revertedWithCustomError(impl, "UUPSUnauthorizedCallContext");
    });

    it("moves the admin role in two steps", async () => {
      const { profile, alice, bob } = await loadFixture(deployWithAlice);

      await profile.transferOwnership(alice.address);
      expect(await profile.owner()).to.not.equal(alice.address);
      expect(await profile.pendingOwner()).to.equal(alice.address);
      await expect(profile.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(profile, "OwnableUnauthorizedAccount");

      await profile.connect(alice).acceptOwnership();
      expect(await profile.owner()).to.equal(alice.address);
      await expect(profile.reserveUsername("nura", ethers.ZeroAddress)).to.be.revertedWithCustomError(profile, "OwnableUnauthorizedAccount");
      await profile.connect(alice).reserveUsername("nura", ethers.ZeroAddress);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("profile security", () => {
    it("gives the admin no path to a user's content", async () => {
      const { profile, admin, id } = await loadFixture(deployWithAlice);
      const asAdmin = profile.connect(admin);

      await expect(asAdmin.setField(id, "bio", "admin was here")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await expect(asAdmin.setUsername(id, "seized")).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asAdmin.deleteProfile(id)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asAdmin.transferProfile(id, admin.address)).to.be.revertedWithCustomError(profile, "NotOwnerOrRecovery");
      await expect(asAdmin.addWebsite(id, "https://evil", "x")).to.be.revertedWithCustomError(profile, "NotAuthorized");
      await expect(asAdmin.approveExtension(id, "x", true)).to.be.revertedWithCustomError(profile, "NotProfileOwner");
      await expect(asAdmin.setExtensionField(id, "x", "", "y")).to.be.revertedWithCustomError(profile, "ExtensionNotRegistered");
    });

    it("rejects native coin: no receive, no fallback", async () => {
      const { proxyAddress, alice } = await loadFixture(deployWithAlice);

      await expect(alice.sendTransaction({ to: proxyAddress, value: 1n })).to.be.revert(ethers);
      await expect(alice.sendTransaction({ to: proxyAddress, data: "0x12345678" })).to.be.revert(ethers);
    });

    it("cannot be squatted by creating profiles for other addresses", async () => {
      const { profile, bob } = await loadFixture(deployProfile);
      // The ABI has no createProfileFor: the only way to own a profile is to create it yourself.
      expect(profile.interface.getFunction("createProfile")!.inputs.map((i) => i.type)).to.deep.equal([
        "string",
        "string",
        "string",
        "string",
      ]);
      await profile.connect(bob).createProfile("bob", "", "", "");
      expect(await profile.ownerOf(1n)).to.equal(bob.address);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("lens", () => {
    it("resolves a username straight to a profile view, in any casing", async () => {
      const { lens, alice, id } = await loadFixture(deployWithAlice);

      const view = await lens.getProfileByUsername("ALICE", "");
      expect(view.id).to.equal(id);
      expect(view.owner).to.equal(alice.address);
      expect(view.displayName).to.equal("Alice Doe");

      expect((await lens.getProfileByUsername("nobody", "")).id).to.equal(0n);
      expect((await lens.getProfileByUsername("!!", "")).id).to.equal(0n); // invalid input: none, no revert
    });

    it("returns an empty full view for an address without a profile", async () => {
      const { lens, bob } = await loadFixture(deployWithAlice);

      const full = await lens.getFullProfile(bob.address, "en");
      expect(full.profile.id).to.equal(0n);
      expect(full.profile.owner).to.equal(ethers.ZeroAddress);
      expect(full.websites.length).to.equal(0);
      expect(full.images.length).to.equal(0);
      expect(full.socials.length).to.equal(0);
    });

    it("serves the full view by id as well as by address", async () => {
      const { profile, lens, alice, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      await p.addWebsite(id, "https://a", "A");
      await p.addImage(id, "ipfs://i", "gallery", "I");
      await p.addSocial(id, "x", "alice", "");

      const byId = await lens.getFullProfileById(id, "en");
      expect(byId).to.deep.equal(await lens.getFullProfile(alice.address, "en"));
      expect(byId.websites.length).to.equal(1);
      expect(byId.images[0].uri).to.equal("ipfs://i");
      expect(byId.socials[0].handle).to.equal("alice");

      await expect(lens.getFullProfileById(99n, "en")).to.be.revertedWithCustomError(profile, "ProfileNotFound");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  describe("indexer compatibility", () => {
    it("replays the event stream into the same state the lens reports", async () => {
      const { profile, lens, proxyAddress, alice, bob, id } = await loadFixture(deployWithAlice);
      const p = profile.connect(alice);
      const fromBlock = await ethers.provider.getBlockNumber();

      // A realistic editing session, including removals and a second profile as noise.
      await p.setLocalizedField(id, "bio", "fa", "بایو");
      await p.setFields(id, [
        { key: "location", lang: "", value: "Tehran" },
        { key: "location", lang: "fa", value: "تهران" },
        { key: "jobTitle", lang: "", value: "Dev" },
      ]);
      await p.addWebsite(id, "https://a", "A"); // 1
      await p.addWebsite(id, "https://b", "B"); // 2
      await p.addWebsite(id, "https://c", "C"); // 3
      await p.setItemAttribute(id, 2n, "title", "fa", "ب");
      await p.setItemAttribute(id, 2n, "description", "", "desc");
      await p.addImage(id, "ipfs://i", "gallery", "alt"); // 4
      await p.addSocial(id, "twitter", "alice", ""); // 5
      await p.addItem(id, "wallet", [{ key: "chain", lang: "", value: "btc" }]); // 6
      await p.removeWebsite(id, 1n); // swap: [3, 2]
      await p.updateSocial(id, 5n, "twitter", "alice_", "https://x.com/alice_");
      await p.updateWebsite(id, 3n, "https://c2", "C2");
      await p.removeField(id, "jobTitle", "");
      await p.setItemAttribute(id, 2n, "description", "", "");
      await p.setField(id, "bio", "New bio");
      await profile.connect(bob).createProfile("bob", "Bob", "", "");
      await profile.connect(bob).addWebsite(2n, "https://bob", "Bob");

      // ── the indexer ───────────────────────────────────────────────────────────────────
      type Item = { kind: string; attrs: Map<string, string> };
      const fields = new Map<string, string>(); // "key|lang" -> value
      const items = new Map<bigint, Item>();
      const lists = new Map<string, bigint[]>(); // kind -> ordered ids (swap-and-pop mirrored)
      const s32 = (h: string) => ethers.decodeBytes32String(h);
      const fk = (key: string, lang: string) => `${key}|${lang}`;
      const setAttr = (itemId: bigint, key: string, lang: string, value: string) => {
        const it = items.get(itemId)!;
        if (value === "") it.attrs.delete(fk(key, lang));
        else it.attrs.set(fk(key, lang), value);
      };
      const addItem = (itemId: bigint, kind: string) => {
        items.set(itemId, { kind, attrs: new Map() });
        lists.set(kind, [...(lists.get(kind) ?? []), itemId]);
      };
      const removeItem = (itemId: bigint) => {
        const kind = items.get(itemId)!.kind;
        const list = lists.get(kind)!;
        const i = list.indexOf(itemId);
        list[i] = list[list.length - 1];
        list.pop();
        items.delete(itemId);
      };

      const logs = await ethers.provider.getLogs({ address: proxyAddress, fromBlock, toBlock: "latest" });
      for (const log of logs) {
        const ev = profile.interface.parseLog(log);
        if (ev === null || ev.args.profileId !== id) continue;
        const a = ev.args;
        switch (ev.name) {
          case "FieldUpdated":
            fields.set(fk(s32(a.key), ""), a.value);
            break;
          case "LocalizedFieldUpdated":
            fields.set(fk(s32(a.key), s32(a.lang)), a.value);
            break;
          case "FieldRemoved":
            fields.delete(fk(s32(a.key), s32(a.lang)));
            break;
          case "ItemAdded":
            addItem(a.itemId, s32(a.kind));
            break;
          case "ItemRemoved":
            removeItem(a.itemId);
            break;
          case "ItemAttributeUpdated":
            setAttr(a.itemId, s32(a.key), s32(a.lang), a.value);
            break;
          case "ItemAttributeRemoved":
            setAttr(a.itemId, s32(a.key), s32(a.lang), "");
            break;
          case "WebsiteAdded":
          case "WebsiteUpdated":
            setAttr(a.websiteId, "url", "", a.url);
            setAttr(a.websiteId, "title", "", a.title);
            break;
          case "ImageAdded":
          case "ImageUpdated":
            setAttr(a.imageId, "uri", "", a.uri);
            setAttr(a.imageId, "category", "", a.category);
            setAttr(a.imageId, "alt", "", a.alt);
            break;
          case "SocialAdded":
          case "SocialUpdated":
            setAttr(a.socialId, "platform", "", a.platform);
            setAttr(a.socialId, "handle", "", a.handle);
            setAttr(a.socialId, "url", "", a.url);
            break;
          // WebsiteRemoved / ImageRemoved / SocialRemoved duplicate ItemRemoved; ProfileUpdated is a heartbeat.
        }
      }

      // ── compare with the chain, in two languages ──────────────────────────────────────
      const resolve = (attrs: Map<string, string>, key: string, lang: string) =>
        attrs.get(fk(key, lang)) ?? attrs.get(fk(key, "")) ?? "";
      for (const lang of ["", "fa"]) {
        const full = await lens.getFullProfile(alice.address, lang);
        expect(full.profile.bio).to.equal(fields.get(fk("bio", lang)) ?? fields.get(fk("bio", "")));
        expect(full.profile.location).to.equal(fields.get(fk("location", lang)) ?? fields.get(fk("location", "")));
        expect(full.profile.jobTitle).to.equal(fields.get(fk("jobTitle", "")) ?? "");

        expect(full.websites.map((w: any) => w.id)).to.deep.equal(lists.get("website"));
        for (const w of full.websites) {
          const attrs = items.get(w.id)!.attrs;
          expect(w.url).to.equal(resolve(attrs, "url", lang));
          expect(w.title).to.equal(resolve(attrs, "title", lang));
          expect(w.description).to.equal(resolve(attrs, "description", lang));
        }
        expect(full.images.map((i: any) => i.id)).to.deep.equal(lists.get("image"));
        expect(full.socials.map((s: any) => s.id)).to.deep.equal(lists.get("social"));
        expect(full.socials[0].handle).to.equal(resolve(items.get(5n)!.attrs, "handle", lang));
        expect(full.socials[0].url).to.equal(resolve(items.get(5n)!.attrs, "url", lang));
        const [wallets] = await lens.getItems(id, "wallet", lang, ["chain"], 0, 0);
        expect(wallets.map((w: any) => w.id)).to.deep.equal(lists.get("wallet"));
        expect(wallets[0].attributes[0]).to.equal(resolve(items.get(6n)!.attrs, "chain", lang));
      }
      expect(items.has(1n)).to.equal(false);
      expect(lists.get("website")).to.deep.equal([3n, 2n]);
      expect(fields.has(fk("jobTitle", ""))).to.equal(false);
    });
  });
});
