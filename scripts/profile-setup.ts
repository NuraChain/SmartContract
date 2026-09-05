import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";

/**
 * Finishes a profile deployment and prints the state it ends up in.
 *
 *   npx hardhat run scripts/profile-setup.ts --network nurachain
 *
 * ignition/modules/profile.ts deploys the core, the lens and the SocialVerifier extension
 * and stops. Registering the extension is an owner-only call on the core, and the owner is
 * not always the deploying key (a multisig, typically), so it lives here, where it can be
 * run by whoever holds the owner key — or skipped, and done from the multisig instead.
 *
 *   1. find the proxy, lens and verifier (Ignition's record for this chain, or env)
 *   2. report owner / version / profile count / registered extensions
 *   3. if the signer is the owner and the verifier is not registered yet, register it
 *   4. verify the registry entry and print the lot
 *
 * Re-running is safe: registration is skipped when the id is already taken.
 *
 * Environment (all optional, defaulting to the Ignition deployment for this chain):
 *   PROFILE_PROXY_ADDRESS     the NuraProfile proxy
 *   PROFILE_LENS_ADDRESS      the NuraProfileLens
 *   PROFILE_VERIFIER_ADDRESS  the SocialVerifier
 *   PROFILE_SKIP_REGISTER     set to 1 to only report, registering nothing
 */

const IDS = {
  proxy: "profile#NuraProfileProxy",
  lens: "profile#NuraProfileLens",
  verifier: "profile#SocialVerifier",
} as const;

const EXTENSION_ID = "social-verifier";

async function deployedAddresses(chainId: bigint): Promise<Record<string, string>> {
  const path = resolve(process.cwd(), `ignition/deployments/chain-${chainId}/deployed_addresses.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function pick(env: string | undefined, recorded: string | undefined, what: string): string {
  const fromEnv = env?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (recorded !== undefined) return recorded;
  throw new Error(
    `No address for ${what}: no Ignition record for this chain and no environment override. ` +
      `Deploy with: npx hardhat deploy --sc profile --network <network>`,
  );
}

async function main() {
  const { ethers, networkName } = await network.getOrCreate();
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const recorded = await deployedAddresses(net.chainId);

  const proxyAddress = pick(process.env.PROFILE_PROXY_ADDRESS, recorded[IDS.proxy], "the NuraProfile proxy");
  const lensAddress = pick(process.env.PROFILE_LENS_ADDRESS, recorded[IDS.lens], "the NuraProfileLens");
  const verifierAddress = pick(process.env.PROFILE_VERIFIER_ADDRESS, recorded[IDS.verifier], "the SocialVerifier");

  const profile = await ethers.getContractAt("NuraProfile", proxyAddress, signer);
  const lens = await ethers.getContractAt("NuraProfileLens", lensAddress, signer);
  const verifier = await ethers.getContractAt("SocialVerifier", verifierAddress, signer);

  console.log(`Network:     ${networkName} (chain ${net.chainId})`);
  console.log(`Signer:      ${signer.address}`);
  console.log(`Profile:     ${proxyAddress}  VERSION ${await profile.VERSION()}`);
  console.log(`Lens:        ${lensAddress}  core=${await lens.core()}`);
  console.log(`Verifier:    ${verifierAddress}  registry=${await verifier.profileRegistry()}`);

  const owner: string = await profile.owner();
  const pending: string = await profile.pendingOwner();
  console.log(`Owner:       ${owner}${pending !== ethers.ZeroAddress ? `  (pending: ${pending})` : ""}`);
  console.log(`Profiles:    ${await profile.profilesCreated()} issued`);

  if ((await lens.core()).toLowerCase() !== proxyAddress.toLowerCase()) {
    throw new Error(`The lens reads from ${await lens.core()}, not this proxy. Wrong lens address?`);
  }
  if ((await verifier.profileRegistry()).toLowerCase() !== proxyAddress.toLowerCase()) {
    throw new Error(`The verifier serves ${await verifier.profileRegistry()}, not this proxy. Wrong verifier address?`);
  }

  const registered: string = await profile.getExtension(EXTENSION_ID);
  if (registered.toLowerCase() === verifierAddress.toLowerCase()) {
    console.log(`\n"${EXTENSION_ID}" is already registered at ${registered}. Nothing to do.`);
  } else if (registered !== ethers.ZeroAddress) {
    console.log(`\n"${EXTENSION_ID}" is registered to a DIFFERENT address: ${registered}.`);
    console.log(`Unregister it first (owner: unregisterExtension("${EXTENSION_ID}")) if this verifier should replace it.`);
  } else if (process.env.PROFILE_SKIP_REGISTER === "1") {
    console.log(`\nPROFILE_SKIP_REGISTER=1: not registering "${EXTENSION_ID}".`);
  } else if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`\nThe signer is not the owner, so this script cannot register the extension.`);
    console.log(`From the owner (${owner}) call:`);
    console.log(`  NuraProfile(${proxyAddress}).registerExtension("${EXTENSION_ID}", ${verifierAddress})`);
  } else {
    console.log(`\nRegistering "${EXTENSION_ID}" -> ${verifierAddress} ...`);
    const tx = await profile.registerExtension(EXTENSION_ID, verifierAddress);
    console.log(`  tx ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  mined in block ${receipt?.blockNumber}, ${receipt?.gasUsed} gas`);
    const now: string = await profile.getExtension(EXTENSION_ID);
    if (now.toLowerCase() !== verifierAddress.toLowerCase()) {
      throw new Error(`Registry reads ${now} after registration; expected ${verifierAddress}.`);
    }
    console.log(`  registered.`);
  }

  const [ids, addresses] = await profile.getExtensions();
  console.log(`\nExtensions (${ids.length}):`);
  for (let i = 0; i < ids.length; i++) {
    console.log(`  ${ethers.decodeBytes32String(ids[i]).padEnd(20)} ${addresses[i]}`);
  }

  console.log(`\nNext steps:`);
  console.log(`  - users approve the verifier once: approveExtension(profileId, "${EXTENSION_ID}", true)`);
  console.log(`  - the backend signs VerifyHandle attestations with a VERIFIER_ROLE key`);
  console.log(`  - move ownership to a multisig: transferOwnership(...) then acceptOwnership() from it`);
}

main().catch((error) => {
  console.error(`\nProfile setup failed:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
