import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/swap — deployed by `npm run deploy:nurachain:swap`,
 * or `npx hardhat deploy --sc swap --network <network>`.
 *
 * Four contracts, and that is the whole AMM:
 *
 *   WBNB               wrapped native coin, so the router can route native <-> ERC20
 *   UniswapV2Factory   creates pairs with CREATE2, one per token pair
 *   UniswapV2Router02  the contract wallets actually call: swaps, add/remove liquidity
 *   Multicall3         read batching; every UI and indexer expects it at some address
 *
 * Pairs are not deployed here. The factory makes them on demand the first time someone
 * adds liquidity for a token pair, which is why the router can compute a pair address
 * before it exists — see the init code hash note in scripts/write-init-code-hash.ts.
 *
 * `feeToSetter` gets to switch on the protocol fee cut (1/6 of the 0.30% fee) and to
 * hand that right on. It defaults to the deployer; on anything real it should be a
 * multisig. Override it in ignition/params.json and pass --parameters:
 *
 *   { "swap": { "feeToSetter": "0xYourMultisig" } }
 *
 * The protocol fee starts off — `feeTo` is the zero address until whoever holds
 * `feeToSetter` calls `setFeeTo`. Until then the full 0.30% stays with liquidity
 * providers, which is the usual way to launch.
 *
 * This module always deploys its own WBNB. If your chain already has a canonical
 * wrapped-native contract, the router has to be pointed at that one instead — say so
 * and it becomes a parameter.
 *
 * The demo tokens in contracts/swap/tokens (NuraToken, MockToken) are deliberately not
 * here: mUSDT and a public faucet are testnet furniture, not something to deploy by
 * reflex on a chain that matters.
 */
export default buildModule("swap", (m) => {
  const feeToSetter = m.getParameter("feeToSetter", m.getAccount(0));

  const wbnb = m.contract("WBNB");
  const factory = m.contract("UniswapV2Factory", [feeToSetter]);
  const router = m.contract("UniswapV2Router02", [factory, wbnb]);
  const multicall3 = m.contract("Multicall3");

  return { wbnb, factory, router, multicall3 };
});
