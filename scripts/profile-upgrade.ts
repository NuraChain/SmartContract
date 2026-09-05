import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";

/**
 * Upgrades the NuraProfile proxy to a new implementation (UUPS: the call goes to the proxy,
 * which delegates to the current implementation's `upgradeToAndCall`, owner-only).
 *
 *   npx hardhat run scripts/profile-upgrade.ts --network nurachain
 *
 * What it does, in order:
 *
 *   1. finds the proxy (Ignition's record for this chain, or PROFILE_PROXY_ADDRESS)
 *   2. checks the connected signer is the proxy's owner — the upgrade would revert otherwise,
 *      and it is better to hear that before deploying anything
 *   3. deploys the new implementation, or uses the one at PROFILE_NEW_IMPLEMENTATION
 *   4. checks the candidate is UUPS-compatible (`proxiableUUID` == ERC-1967 implementation
 *      slot — what the on-chain upgrade checks too), exposes `VERSION()`, and fits EIP-170
 *   5. unless PROFILE_UPGRADE_DRY_RUN=1, sends `upgradeToAndCall(newImpl, PROFILE_UPGRADE_CALL)`
 *   6. reads the implementation slot back and prints before/after
 *
 * Storage safety is a review step, not something this script can prove: NuraProfile keeps
 * its state in one ERC-7201 namespace, so a new version must only APPEND to `Layout`, never
 * reorder or retype existing members, and must put brand-new state in its own namespace (see
 * NuraProfileV2Mock for the shape). Reinitializers go through PROFILE_UPGRADE_CALL.
 *
 * Environment:
 *   PROFILE_PROXY_ADDRESS       Optional. Defaults to Ignition's "profile#NuraProfileProxy".
 *   PROFILE_NEW_IMPLEMENTATION  Optional. A contract NAME to deploy (default "NuraProfile") or
 *                               the 0x address of an implementation already on this chain.
 *   PROFILE_UPGRADE_CALL        Optional. Hex calldata to run on the new implementation right
 *                               after the switch (e.g. an encoded `initializeV2(...)`). Empty
 *                               by default, which runs nothing.
 *   PROFILE_UPGRADE_DRY_RUN     Optional. Set to 1 to deploy and check, but not upgrade.
 *
 * No private keys here: the signer comes from the network config, as it does everywhere else.
 */

const IGNITION_PROXY_ID = "profile#NuraProfileProxy";

/** ERC-1967: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** EIP-170, enforced exactly by Nurachain. */
const MAX_CODE_SIZE = 24576;

async function resolveProxyAddress(chainId: bigint): Promise<string> {
  const fromEnv = process.env.PROFILE_PROXY_ADDRESS?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const path = resolve(process.cwd(), `ignition/deployments/chain-${chainId}/deployed_addresses.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No Ignition deployment found at ${path}.\n` +
        `Deploy first with: npx hardhat deploy --sc profile --network <network>\n` +
        `Or point this script at the proxy with PROFILE_PROXY_ADDRESS=0x...`,
    );
  }
  const address = (JSON.parse(raw) as Record<string, string>)[IGNITION_PROXY_ID];
  if (address === undefined) {
    throw new Error(`${path} has no "${IGNITION_PROXY_ID}" entry. Deploy the profile module, or set PROFILE_PROXY_ADDRESS.`);
  }
  return address;
}

function slotToAddress(slotValue: string): string {
  return "0x" + slotValue.slice(-40);
}

async function main() {
  const { ethers, networkName } = await network.getOrCreate();
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log(`Network:         ${networkName} (chain ${net.chainId})`);
  console.log(`Signer:          ${signer.address}`);

  const proxyAddress = await resolveProxyAddress(net.chainId);
  const profile = await ethers.getContractAt("NuraProfile", proxyAddress, signer);
  console.log(`Proxy:           ${proxyAddress}`);

  const owner: string = await profile.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `The connected signer is not the proxy owner (${owner}). Only the owner can upgrade; ` +
        `if the owner is a multisig, have it call upgradeToAndCall(newImplementation, data) itself.`,
    );
  }

  const before = slotToAddress(await ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT));
  const versionBefore: string = await profile.VERSION();
  const profilesBefore: bigint = await profile.profilesCreated();
  console.log(`Implementation:  ${before}  (VERSION ${versionBefore}, ${profilesBefore} profiles issued)`);

  // 3. the candidate: deploy by name, or take an address
  const target = process.env.PROFILE_NEW_IMPLEMENTATION?.trim() || "NuraProfile";
  let candidate: string;
  if (ethers.isAddress(target)) {
    candidate = target;
    console.log(`Candidate:       ${candidate}  (pre-deployed)`);
  } else {
    console.log(`Deploying:       ${target} ...`);
    const impl = await ethers.deployContract(target, [], signer);
    await impl.waitForDeployment();
    candidate = await impl.getAddress();
    console.log(`Candidate:       ${candidate}  (new ${target})`);
  }
  if (candidate.toLowerCase() === before.toLowerCase()) {
    throw new Error(`The candidate is already the current implementation. Nothing to do.`);
  }

  // 4. compatibility checks, the same ones the upgrade would enforce plus the ones it cannot
  const code = await ethers.provider.getCode(candidate);
  const size = (code.length - 2) / 2;
  if (size === 0) throw new Error(`No code at ${candidate}.`);
  if (size > MAX_CODE_SIZE) throw new Error(`Candidate is ${size} bytes, over the ${MAX_CODE_SIZE}-byte limit.`);

  const candidateContract = await ethers.getContractAt("NuraProfile", candidate, signer);
  const uuid: string = await candidateContract.proxiableUUID();
  if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT) {
    throw new Error(`Candidate proxiableUUID ${uuid} is not the ERC-1967 implementation slot; not a UUPS implementation.`);
  }
  const candidateVersion: string = await candidateContract.VERSION();
  console.log(`Candidate check: ${size} bytes (${MAX_CODE_SIZE - size} spare), UUPS ok, VERSION ${candidateVersion}`);

  const data = process.env.PROFILE_UPGRADE_CALL?.trim() || "0x";
  if (!ethers.isHexString(data)) throw new Error(`PROFILE_UPGRADE_CALL must be hex calldata (got ${data}).`);
  console.log(`Post-upgrade call: ${data === "0x" ? "(none)" : data}`);

  if (process.env.PROFILE_UPGRADE_DRY_RUN === "1") {
    console.log(`\nDry run: not upgrading. Re-run without PROFILE_UPGRADE_DRY_RUN to switch the proxy to ${candidate}.`);
    return;
  }

  // 5. the upgrade itself
  console.log(`\nUpgrading ...`);
  const tx = await profile.upgradeToAndCall(candidate, data);
  console.log(`  tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block ${receipt?.blockNumber}, ${receipt?.gasUsed} gas`);

  // 6. verify
  const after = slotToAddress(await ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT));
  if (after.toLowerCase() !== candidate.toLowerCase()) {
    throw new Error(`Implementation slot reads ${after}, expected ${candidate}. Investigate before doing anything else.`);
  }
  const versionAfter: string = await profile.VERSION();
  const profilesAfter: bigint = await profile.profilesCreated();
  if (profilesAfter !== profilesBefore) {
    throw new Error(`profilesCreated changed across the upgrade (${profilesBefore} -> ${profilesAfter}); storage layout mismatch?`);
  }

  console.log(`\nUpgraded.`);
  console.log(`  ${before}  VERSION ${versionBefore}`);
  console.log(`  ${after}  VERSION ${versionAfter}`);
  console.log(`  ${profilesAfter} profiles issued, unchanged.`);
}

main().catch((error) => {
  console.error(`\nUpgrade failed:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
