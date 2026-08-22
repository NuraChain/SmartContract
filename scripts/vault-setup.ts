import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";

import { formatUnits, parseWholeTokens } from "./lib/params.ts";

/**
 * Funds a deployed CollateralizedNFT and prints the state it ends up in.
 *
 *   npx hardhat run scripts/vault-setup.ts --network nurachain
 *
 * ignition/modules/vault.ts deploys the contract and stops, the way the airdrop module does,
 * because moving the reserve needs an allowance from whoever holds the tokens and that is not
 * always the deploying key. This is the second half:
 *
 *   1. find the deployed vault
 *   2. read back what it was deployed with, including the token it is pinned to
 *   3. scale the target reserve by the token's real decimals
 *   4. approve and deposit whatever is still missing
 *   5. verify balance, totalReserved and remainingMintCapacity against expectations
 *   6. print the lot
 *
 * Re-running is safe and is the intended way to top up: it deposits the shortfall between the
 * current balance and the target, and does nothing at all when the target is already met.
 *
 * Environment:
 *   VAULT_ADDRESS  Optional. Defaults to the address Ignition recorded for this chain.
 *   VAULT_RESERVE  Optional. Whole tokens to fund up to, default 2500000. Scaled here by the
 *                  token's own decimals, so do not pre-multiply it.
 *   VAULT_SKIP_FUNDING  Optional. Set to 1 to only report, moving nothing.
 *
 * No private keys here: the signer comes from the network config, as it does everywhere else.
 */

const DEFAULT_RESERVE_WHOLE = 2_500_000n;

/** The id Ignition files this contract under, from buildModule("vault") plus the contract name. */
const IGNITION_FUTURE_ID = "vault#CollateralizedNFT";

/**
 * Reads the vault address out of the Ignition deployment for this chain, so the common case
 * needs no environment variable at all. VAULT_ADDRESS wins when it is set.
 */
async function resolveVaultAddress(chainId: bigint): Promise<string> {
  const fromEnv = process.env.VAULT_ADDRESS?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  const path = resolve(
    process.cwd(),
    `ignition/deployments/chain-${chainId}/deployed_addresses.json`,
  );

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No Ignition deployment found at ${path}.\n` +
        `Deploy first with: npx hardhat deploy --sc vault --network <network> --parameters ./ignition/params.json\n` +
        `Or point this script at an existing contract with VAULT_ADDRESS=0x...`,
    );
  }

  const addresses = JSON.parse(raw) as Record<string, string>;
  const address = addresses[IGNITION_FUTURE_ID];

  if (address === undefined) {
    throw new Error(
      `${path} has no "${IGNITION_FUTURE_ID}" entry. Deploy the vault module, or set VAULT_ADDRESS.`,
    );
  }

  return address;
}

async function main() {
  const { ethers, networkName } = await network.getOrCreate();

  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  const vaultAddress = await resolveVaultAddress(chainId);
  const vault = await ethers.getContractAt("CollateralizedNFT", vaultAddress, deployer);

  // Everything below is read back off-chain rather than assumed, so a params.json that was
  // edited between deployments cannot make this script report a configuration the contract
  // does not actually have.
  const tokenAddress = await vault.backingToken();
  const token = await ethers.getContractAt("IBackingToken", tokenAddress, deployer);

  const [decimals, tokenSymbol, nftName, nftSymbol, lockAmount] = await Promise.all([
    token.decimals(),
    token.symbol(),
    vault.name(),
    vault.symbol(),
    vault.lockAmount(),
  ]);

  const scale = 10n ** BigInt(decimals);
  const targetReserve =
    parseWholeTokens(process.env.VAULT_RESERVE, "VAULT_RESERVE", DEFAULT_RESERVE_WHOLE) * scale;

  console.log(`Network:        ${networkName} (chain ${chainId})`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Vault:          ${vaultAddress}`);
  console.log(`NFT:            ${nftName} (${nftSymbol})`);
  console.log(`Backing token:  ${tokenAddress}`);
  console.log(`                ${tokenSymbol}, ${decimals} decimals`);
  console.log(
    `Lock per NFT:   ${formatUnits(lockAmount, Number(decimals))} ${tokenSymbol} (${lockAmount} base units)`,
  );

  // A lockAmount scaled for the wrong number of decimals is the one deployment mistake that
  // cannot be corrected for NFTs already minted, so it is worth naming rather than implying.
  if (lockAmount % scale !== 0n) {
    console.log(
      `\n  WARNING: ${lockAmount} is not a whole number of ${tokenSymbol} at ${decimals} decimals.\n` +
        `           Check the lockAmount parameter was scaled for this token, not for 18 decimals.\n` +
        `           setLockAmount can fix it for future NFTs; already-minted ones keep their amount.`,
    );
  }

  const balanceBefore = await vault.tokenBalance();
  const shortfall = targetReserve > balanceBefore ? targetReserve - balanceBefore : 0n;

  console.log(
    `\nTarget reserve: ${formatUnits(targetReserve, Number(decimals))} ${tokenSymbol}` +
      `\nHeld now:       ${formatUnits(balanceBefore, Number(decimals))} ${tokenSymbol}`,
  );

  if (process.env.VAULT_SKIP_FUNDING === "1") {
    console.log(`\nVAULT_SKIP_FUNDING=1, reporting only.`);
  } else if (shortfall === 0n) {
    console.log(`\nAlready funded to target, nothing to deposit.`);
  } else {
    const held = await token.balanceOf(deployer.address);
    if (held < shortfall) {
      throw new Error(
        `Deployer holds ${formatUnits(held, Number(decimals))} ${tokenSymbol} but the deposit needs ` +
          `${formatUnits(shortfall, Number(decimals))}. Fund ${deployer.address}, lower VAULT_RESERVE, ` +
          `or deposit from the account that holds the tokens.`,
      );
    }

    console.log(`\nDepositing ${formatUnits(shortfall, Number(decimals))} ${tokenSymbol}...`);

    // Some tokens refuse a non-zero-to-non-zero approve, so this clears any leftover
    // allowance first. approve(0) on a token that does not need it is a cheap no-op.
    const existing = await token.allowance(deployer.address, vaultAddress);
    if (existing !== 0n) {
      await (await token.approve(vaultAddress, 0n)).wait();
    }

    await (await token.approve(vaultAddress, shortfall)).wait();
    const receipt = await (await vault.deposit(shortfall)).wait();
    console.log(`  deposit mined in block ${receipt?.blockNumber}`);
  }

  const state = await vault.vaultState();

  console.log(`\nState`);
  console.log(`  token balance:          ${formatUnits(state.balance, Number(decimals))} ${tokenSymbol}`);
  console.log(`  total reserved:         ${formatUnits(state.reserved, Number(decimals))} ${tokenSymbol}`);
  console.log(`  available backing:      ${formatUnits(state.available, Number(decimals))} ${tokenSymbol}`);
  console.log(`  NFTs minted:            ${state.minted}`);
  console.log(`  NFTs redeemed:          ${state.redeemed}`);
  console.log(`  NFTs outstanding:       ${state.outstanding}`);
  console.log(`  lock amount:            ${formatUnits(state.currentLockAmount, Number(decimals))} ${tokenSymbol}`);
  console.log(`  remaining capacity:     ${state.mintCapacity} NFTs`);

  console.log(`\nAccess`);
  console.log(`  public minting:         ${(await vault.publicMintEnabled()) ? "OPEN TO EVERYONE" : "MINTER_ROLE only"}`);
  console.log(`  deployer is admin:      ${await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), deployer.address)}`);
  console.log(`  deployer is minter:     ${await vault.hasRole(await vault.MINTER_ROLE(), deployer.address)}`);

  // The checks the deploy is actually judged on. Each is a statement about solvency rather
  // than about this script having run, so they hold on a re-run against a live contract too.
  const problems: string[] = [];

  if (state.reserved > state.balance) {
    problems.push(`totalReserved (${state.reserved}) exceeds the balance (${state.balance})`);
  }
  if (state.balance - state.reserved !== state.available) {
    problems.push(`availableBacking does not equal balance - totalReserved`);
  }
  if (state.available / state.currentLockAmount !== state.mintCapacity) {
    problems.push(`remainingMintCapacity does not equal availableBacking / lockAmount`);
  }
  if (state.outstanding !== state.minted - state.redeemed) {
    problems.push(`outstanding supply does not equal minted - redeemed`);
  }
  if (process.env.VAULT_SKIP_FUNDING !== "1" && state.balance < targetReserve) {
    problems.push(
      `balance ${state.balance} is below the ${targetReserve} target after funding`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Verification failed:\n  - ${problems.join("\n  - ")}`);
  }

  console.log(`\nVerified. ${state.mintCapacity} more NFTs can be backed at the current lock amount.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
