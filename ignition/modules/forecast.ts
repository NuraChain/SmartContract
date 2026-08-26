import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/forecast — deployed by `npm run deploy:nurachain:forecast`,
 * or `npx hardhat deploy --sc forecast --network <network>`.
 *
 * Four contracts:
 *
 *   PredictionTreasury   sink for protocol fees (Ownable2Step)
 *   PredictionMarket     CPMM implementation, cloned per market by createMarket
 *   PredictionPool       parimutuel implementation, cloned per market by createMarket2
 *   PredictionFactory    clone factory + ADMIN_ROLE registry control plane
 *
 * Both implementations are deployed bare: their constructors call _disableInitializers(),
 * so only clones created by the factory can ever be initialized. Nothing is initialized
 * here and no market exists until an ADMIN_ROLE holder calls createMarket/createMarket2.
 *
 * Parameters (ignition/params.json via --parameters):
 *
 *   {
 *     "forecast": {
 *       "admin":                     "0xYourMultisig",
 *       "feeRecipient":              "0xWhereFeesGo",
 *       "defaultFeeBps":             "300n",
 *       "defaultProtocolFeeShareBps": "2000n"
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE on the
 * factory — this key creates markets, pauses/closes/resolves/voids them, and is trusted
 * to declare winners honestly. Move it to a multisig for anything real.
 *
 * `feeRecipient` defaults to `admin`; wrong values are recoverable later via
 * `setFeeRecipient` (owner-only), unlike a botched market parameter.
 *
 * `defaultFeeBps` (3%) is the total trade/bet fee a market inherits when its params pass
 * 0 — this is where the fee percentage per market type comes from. Cap is 1000 bps (10%).
 * `defaultProtocolFeeShareBps` (20% of each fee) only affects CPMM markets; pool markets
 * always send the whole fee to the treasury.
 */
export default buildModule("forecast", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const feeRecipient = m.getParameter("feeRecipient", m.getAccount(0));
  const defaultFeeBps = m.getParameter<bigint>("defaultFeeBps", 300n);
  const defaultProtocolFeeShareBps = m.getParameter<bigint>("defaultProtocolFeeShareBps", 2000n);

  const treasury = m.contract("PredictionTreasury", [admin, feeRecipient]);

  const marketImplementation = m.contract("PredictionMarket", []);
  const poolImplementation = m.contract("PredictionPool", []);

  const factory = m.contract("PredictionFactory", [
    admin,
    treasury,
    marketImplementation,
    poolImplementation,
    defaultFeeBps,
    defaultProtocolFeeShareBps,
  ]);

  return { factory, treasury };
});
