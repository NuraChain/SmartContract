import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/univ2 — deployed by `npm run deploy:nurachain:univ2`,
 * or `npx hardhat deploy --sc univ2 --network <network>`.
 *
 * Four contracts, and that is the whole AMM:
 *
 *   WNURA              wrapped native coin, so the router can route native <-> ERC20
 *   UniswapV2Factory   creates pairs with CREATE2, one per token pair
 *   UniswapV2Router02  the contract wallets actually call: swaps, add/remove liquidity
 *   Multicall3         read batching; every UI and indexer expects it at some address
 *
 * Pairs are not deployed here. The factory makes them on demand the first time someone
 * adds liquidity for a token pair, which is why the router can compute a pair address
 * before it exists — see the init code hash note in scripts/write-init-code-hash.ts.
 *
 * `feeToSetter` holds three powers, and on this fork that is more than upstream gives
 * it: `setSwapFee` retunes the trading fee for every pair at once (capped at 1% by
 * MAX_SWAP_FEE, which is constant and cannot be lifted without a new factory),
 * `setFeeTo` switches on the protocol's 1/6 cut of that fee, and `setFeeToSetter`
 * hands the lot to someone else. It defaults to the deployer; on anything real it
 * should be a multisig. Override it in ignition/params.json and pass --parameters:
 *
 *   { "univ2": { "feeToSetter": "0xYourMultisig" } }
 *
 * The trading fee starts at 0.25% and the protocol fee starts off — `feeTo` is the
 * zero address until `setFeeTo` is called. Until then the full 0.25% stays with
 * liquidity providers, which is the usual way to launch.
 *
 * This module always deploys its own WNURA. If Nurachain already has a canonical
 * wrapped-native contract, the router has to be pointed at that one instead — say so
 * and it becomes a parameter.
 *
 * The demo tokens in contracts/univ2/tokens (NuraToken, MockToken) are deliberately not
 * here: mUSDT and a public faucet are testnet furniture, not something to deploy by
 * reflex on a chain that matters.
 */
/**
 * A note on what is already deployed on Nurachain.
 *
 * These four were deployed while this folder was called contracts/swap, and the
 * deployment records in ignition/deployments/chain-1020 have been remapped onto the
 * `univ2` module id, so `--sc univ2` there redeploys nothing:
 *
 *   WNURA              0xf0a4eC07916feBa4432121Ed5969887D9b939cD0
 *   UniswapV2Factory   0xa812c195c5B683C2FfCd3CCD0E57ee4EE19F85d6
 *   UniswapV2Router02  0xfE126FD0CEcec827112bFc5440d792b3698B3850
 *   Multicall3         0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24
 *
 * The rename moved the pair init code hash, because solc puts the source paths in the
 * metadata it appends (contracts/univ3 avoids this with bytecodeHash "none"; V2 uses
 * solc's default). So the router above carries 0xeb232717…bb2ef while this tree now
 * builds 0x206906a0…5859d9. Both are internally consistent; they are simply different
 * builds. A `--reset`, or a deploy to any other chain, stands up an AMM on the new hash
 * — and WNURA is the one contract to think twice about there, since the live UniswapV3
 * periphery is wired to the address above.
 *
 * See scripts/write-init-code-hash.ts for the full story.
 */
export default buildModule("univ2", (m) => {
  const feeToSetter = m.getParameter("feeToSetter", m.getAccount(0));

  const wnura = m.contract("WNURA");
  const factory = m.contract("UniswapV2Factory", [feeToSetter]);
  const router = m.contract("UniswapV2Router02", [factory, wnura]);
  const multicall3 = m.contract("Multicall3");

  return { wnura, factory, router, multicall3 };
});
