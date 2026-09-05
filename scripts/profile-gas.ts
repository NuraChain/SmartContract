import { network } from "hardhat";

/**
 * Gas report for the profile registry, measured against the in-process chain.
 *
 *   npm run gas:profile            # or: npx hardhat run scripts/profile-gas.ts
 *
 * Deploys the real contracts (implementation, proxy, lens), runs each operation a wallet
 * would, and prints the gas each transaction actually used, as a Markdown table that can be
 * pasted into contracts/profile/README.md. Values are deterministic for a given compiler
 * configuration; re-run after touching the contracts or hardhat.config.ts.
 *
 * "cold" rows write to storage that held nothing before (20k per new slot); "warm" rows
 * overwrite existing values (5k per slot) — the distinction is most of the spread.
 */

const LONG_BIO =
  "Blockchain developer building Nura Chain: an EVM chain with a native profile primitive, " +
  "prediction markets, a V3 exchange and a collateralized NFT vault. This bio is 240 bytes long " +
  "so that it needs eight storage words instead of one.....";

type Row = { op: string; gas: bigint; note: string };

async function main() {
  const { ethers } = await network.getOrCreate();
  const [admin, alice, bob, operator] = await ethers.getSigners();

  const impl = await ethers.deployContract("NuraProfile", [], admin);
  const initData = impl.interface.encodeFunctionData("initialize", [admin.address]);
  const proxy = await ethers.deployContract("NuraProfileProxy", [await impl.getAddress(), initData], admin);
  const profile = await ethers.getContractAt("NuraProfile", await proxy.getAddress(), alice);
  const lens = await ethers.deployContract("NuraProfileLens", [await proxy.getAddress()], admin);

  const rows: Row[] = [];
  const measure = async (op: string, note: string, send: () => Promise<{ wait(): Promise<any> }>) => {
    const receipt = await (await send()).wait();
    rows.push({ op, gas: receipt.gasUsed, note });
  };

  const implCode = await ethers.provider.getCode(await impl.getAddress());
  const lensCode = await ethers.provider.getCode(await lens.getAddress());
  const deployRows: Row[] = [
    { op: "deploy NuraProfile (implementation)", gas: (await impl.deploymentTransaction()!.wait())!.gasUsed, note: `${(implCode.length - 2) / 2} bytes of runtime code` },
    { op: "deploy NuraProfileProxy + initialize", gas: (await proxy.deploymentTransaction()!.wait())!.gasUsed, note: "one-time" },
    { op: "deploy NuraProfileLens", gas: (await lens.deploymentTransaction()!.wait())!.gasUsed, note: `${(lensCode.length - 2) / 2} bytes of runtime code` },
  ];

  // ── profiles ────────────────────────────────────────────────────────────────────────────
  await measure("createProfile(username only)", "cold: record + username index", () =>
    profile.connect(bob).createProfile("bob", "", "", ""),
  );
  await measure("createProfile(username, displayName, bio, avatar)", "cold: record + username + 3 short fields", () =>
    profile.createProfile("alice", "Alice Doe", "Builder at Nura", "ipfs://bafybeigdyrztavatar"),
  );
  const id = await profile.profileIdOf(alice.address);

  // ── fields ──────────────────────────────────────────────────────────────────────────────
  await measure("setField(short, cold)", "new key, 15-byte value (1 slot)", () => profile.setField(id, "location", "Tehran, Iran"));
  await measure("setField(short, warm)", "overwrite same key, similar length", () => profile.setField(id, "location", "Berlin, Germany"));
  await measure("setField(240-byte bio, cold)", "8 data slots + length slot", () => profile.setField(id, "longBio", LONG_BIO));
  await measure("setLocalizedField(fa bio, cold)", "Persian text, 60 bytes UTF-8", () =>
    profile.setLocalizedField(id, "bio", "fa", "توسعه‌دهنده بلاکچین و سازنده Nura Chain"),
  );
  await measure("setLocalizedField(de bio, cold)", "second language, same key", () =>
    profile.setLocalizedField(id, "bio", "de", "Blockchain-Entwickler"),
  );
  await measure("setFields(3 fields, cold)", "batch: jobTitle, company, cover", () =>
    profile.setFields(id, [
      { key: "jobTitle", lang: "", value: "Blockchain Developer" },
      { key: "company", lang: "", value: "Nura Chain" },
      { key: "cover", lang: "", value: "ipfs://bafybeigdyrztcover" },
    ]),
  );
  await measure("removeField", "clears 1 slot (refund applied)", () => profile.removeField(id, "longBio", ""));

  // ── websites / images / socials ─────────────────────────────────────────────────────────
  const w1 = await measureReturning(() => profile.addWebsite(id, "https://nurachain.net", "Nura Chain"), rows, "addWebsite(url, title)", "cold: item + 2 attributes");
  await measure("setItemAttribute(website title, fa)", "localized title on existing item", () =>
    profile.setItemAttribute(id, w1, "title", "fa", "نورا چین"),
  );
  await measure("updateWebsite", "overwrite url + title", () => profile.updateWebsite(id, w1, "https://nurachain.net/", "Nura"));
  const w2 = await measureReturning(() => profile.addWebsite(id, "https://github.com/NuraChain", "GitHub"), rows, "addWebsite (second)", "kind list already exists");
  await measure("addImage(uri, category, alt)", "cold: item + 3 attributes", () =>
    profile.addImage(id, "ipfs://bafybeigdyrztgallery1", "gallery", "Conference talk"),
  );
  await measure("addSocial(platform, handle, url)", "cold: item + 3 attributes", () =>
    profile.addSocial(id, "twitter", "alice", "https://x.com/alice"),
  );
  await measure("addItem(generic 'wallet', 2 attrs)", "any kind, generic path + events", () =>
    profile.addItem(id, "wallet", [
      { key: "chain", lang: "", value: "bitcoin" },
      { key: "address", lang: "", value: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" },
    ]),
  );
  await measure("removeWebsite (not last: swap-and-pop)", "removes w1 while w2 exists", () => profile.removeWebsite(id, w1));
  void w2;

  // ── identity ────────────────────────────────────────────────────────────────────────────
  await measure("setUsername (change)", "release old + claim new", () => profile.setUsername(id, "alice_nura"));
  await measure("setOperator(true)", "owner-keyed approval", () => profile.setOperator(operator.address, true));
  await measure("setField by operator", "same as owner + one extra SLOAD", () =>
    profile.connect(operator).setField(id, "location", "Lisbon"),
  );
  await measure("setRecoveryAddress", "", () => profile.setRecoveryAddress(id, operator.address));
  await measure("transferProfile (initiate)", "", () => profile.transferProfile(id, admin.address));
  await measure("acceptProfile", "moves owner index, clears pending + recovery", () => profile.connect(admin).acceptProfile(id));
  await measure("deleteProfile", "releases username + owner index (refunds)", () => profile.connect(admin).deleteProfile(id));

  // ── report ──────────────────────────────────────────────────────────────────────────────
  const all = [...deployRows, ...rows];
  const width = Math.max(...all.map((r) => r.op.length));
  console.log(`\n| Operation | Gas | Notes |`);
  console.log(`| --- | ---: | --- |`);
  for (const r of all) {
    console.log(`| ${r.op.padEnd(width)} | ${r.gas.toLocaleString("en-US").padStart(9)} | ${r.note} |`);
  }
}

/** Like `measure`, but also decodes the uint256 return value from the emitted ItemAdded event. */
async function measureReturning(
  send: () => Promise<any>,
  rows: Row[],
  op: string,
  note: string,
): Promise<bigint> {
  const tx = await send();
  const receipt = await tx.wait();
  rows.push({ op, gas: receipt.gasUsed, note });
  // ItemAdded(uint256 indexed profileId, uint256 indexed itemId, bytes32 indexed kind)
  const topic = receipt.logs.find((l: any) => l.topics.length === 4 && l.fragment?.name === "ItemAdded");
  return BigInt(topic.topics[2]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
