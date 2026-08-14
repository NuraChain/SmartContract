import "dotenv/config";

import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

// Hardhat needs chainId as a literal number when the config loads, so it cannot come
// from configVariable() the way the lazy secrets below do. Nurachain is not in any
// public chain registry, so put its id in .env rather than guessing it here. Leaving
// it unset is fine — Hardhat then accepts whatever the RPC reports, it just loses the
// safety check that stops you deploying to the wrong chain.
const nurachainChainId = process.env.NURACHAIN_CHAIN_ID
  ? Number(process.env.NURACHAIN_CHAIN_ID)
  : undefined;

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // OpenZeppelin 5.6 uses `mcopy` in utils/Bytes.sol, which is Cancun-only, so
      // this cannot be lowered to "paris" without downgrading the library. BNB Chain
      // has supported the Cancun opcodes since the Pascal upgrade; check any other
      // target chain before deploying there.
      evmVersion: "cancun",
    },
  },

  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },

    bscTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 97,
      url: configVariable("BSC_TESTNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },

    bsc: {
      type: "http",
      chainType: "l1",
      chainId: 56,
      url: configVariable("BSC_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },

    nurachain: {
      type: "http",
      chainType: "l1",
      chainId: nurachainChainId,
      url: configVariable("NURACHAIN_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },

  verify: {
    etherscan: {
      // One Etherscan V2 key covers BscScan and the other supported explorers.
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
