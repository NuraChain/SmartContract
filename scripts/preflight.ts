import { network } from "hardhat";

/**
 * Pre-deployment sanity check for a chain you have not deployed to before.
 *
 *   npx hardhat run scripts/preflight.ts --network nurachain
 *
 * Confirms the RPC answers, that the chain id is what you expect, that the deployer
 * is funded, and — via a real gas estimate against the node — that this bytecode can
 * actually execute there. The gas estimate is the important one: it runs the
 * constructor on the node, so it fails loudly if the chain lacks the Cancun opcodes
 * this build targets, instead of you finding out by burning gas on a failed deploy.
 */
async function main() {
  const { ethers, networkName, networkConfig } = await network.getOrCreate();

  console.log(`Network:        ${networkName}`);

  const net = await ethers.provider.getNetwork();
  console.log(`Chain ID:       ${net.chainId}`);

  const expected = (networkConfig as { chainId?: number }).chainId;
  if (expected === undefined) {
    console.log(`                (no chainId pinned in hardhat.config.ts)`);
  } else if (BigInt(expected) !== net.chainId) {
    throw new Error(`Chain ID mismatch: config says ${expected}, RPC says ${net.chainId}`);
  }

  const block = await ethers.provider.getBlock("latest");
  console.log(`Latest block:   ${block?.number}`);
  // Chains that shipped EIP-4844 expose these. Only a hint about Cancun support —
  // the gas estimate below is the real test.
  const cancunHint = block !== null && "excessBlobGas" in block && block.excessBlobGas !== null;
  console.log(`Cancun hint:    ${cancunHint ? "blob fields present" : "no blob fields"}`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Balance:        ${ethers.formatEther(balance)} (native)`);

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  console.log(`Gas price:      ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  let totalGas = 0n;
  for (const name of ["BridgeUSDT", "BridgeBNB"]) {
    const factory = await ethers.getContractFactory(name);
    const tx = await factory.getDeployTransaction(deployer.address);
    const gas = await ethers.provider.estimateGas({ ...tx, from: deployer.address });
    totalGas += gas;
    console.log(`Deploy gas:     ${gas} (${name})`);
  }

  const cost = totalGas * gasPrice;
  console.log(`Estimated cost: ${ethers.formatEther(cost)} (native) for both`);

  if (balance < cost) {
    throw new Error(
      `Deployer is underfunded: has ${ethers.formatEther(balance)}, needs ~${ethers.formatEther(cost)}`,
    );
  }

  console.log(`\nReady to deploy.`);
}

main().catch((error) => {
  console.error(`\nPreflight failed:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
