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
 *       "owner":                     "0xYourMultisig",
 *       "feeRecipient":              "0xWhereFeesGo",
 *       "defaultFeeBps":             "300n",
 *       "defaultProtocolFeeShareBps": "2000n",
 *       "resolutionSigners":         ["0xSigner1", "0xSigner2", "0xSigner3", "0xSigner4", "0xSigner5"],
 *       "requiredConfirmations":     "3n"
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE on the
 * factory — this key creates markets, pauses/closes/voids them, and manages fees.
 * Move it to a multisig for anything real.
 *
 * Resolution is MULTISIG. Resolving a market needs `requiredConfirmations` of the
 * `resolutionSigners` to vote for the SAME outcome; the last confirming vote executes
 * the on-chain resolution, which releases the pool/shares to winners. The recommended
 * production shape is five signers with a threshold of three: an owner appoints them,
 * three must agree, then coins distribute to winners through claim()/redeem(). Defaults
 * here are deliberately minimal for a first deploy (the deployer as sole signer, quorum 1)
 * because Ignition cannot invent four extra funded keys — pass real distinct addresses
 * and threshold 3 via --parameters before mainnet value flows.
 *
 * `owner` defaults to `admin` and may replace the signer set/quorum later via
 * setResolutionSigners (owner-only, two lists validated atomically).
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
  // Zero address means "same as admin" — resolved inside the factory constructor.
  const owner = m.getParameter("owner", "0x0000000000000000000000000000000000000000");
  const feeRecipient = m.getParameter("feeRecipient", m.getAccount(0));
  const defaultFeeBps = m.getParameter<bigint>("defaultFeeBps", 300n);
  const defaultProtocolFeeShareBps = m.getParameter<bigint>("defaultProtocolFeeShareBps", 2000n);

  // Signer list comes straight from --parameters ("resolutionSigners": [addr, ...],
  // "requiredConfirmations": "3n"). With nothing configured the factory falls back to a
  // single-signer setup (the admin, quorum 1) so a first deploy still works. Production
  // passes five distinct addresses and a threshold of three.
  const resolutionSigners = m.getParameter<string[]>("resolutionSigners", []);
  const requiredConfirmations = m.getParameter<bigint>("requiredConfirmations", 1n);

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
    owner,
    resolutionSigners,
    requiredConfirmations,
  ]);

  return { factory, treasury };
});
