import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * ArcadeMarkets alone, from contracts/baziche - deployed by `npm run deploy:nurachain:bazichemarkets`,
 * or `npx hardhat deploy --sc bazichemarkets --network <network>`. A group of its own so that a
 * chain which already holds the vault, the achievements, the shop and the gifts' contract is not
 * given a second of each.
 *
 *   {
 *     "bazichemarkets": {
 *       "admin":         "0xYourAdminWallet",
 *       "operator":      "0xTheArcadeServersKey",
 *       "disputeWindow": 900
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE: the owner
 * withdraws fees, replaces the operator, pauses new positions and overturns a settlement in its
 * dispute window, which gives every stake back; it never sends a stake anywhere else. It is
 * handed on in two steps, `beginDefaultAdminTransfer(next)` then `acceptDefaultAdminTransfer()`.
 *
 * `disputeWindow` is how long, in seconds, the winners of a settled market wait to claim while
 * the owner may overturn it: 900 (fifteen minutes) unless given, at most a day. It is the time
 * whoever watches the chain against the server's records has to catch a settlement the server did
 * not make. The owner changes it later with `setDisputeWindow`.
 *
 * `operator` is the address of the Arcade server's key (its `NURA_REFEREE_KEY`, the one key that
 * server signs with): the only key whose tickets the contract takes, and the one that settles and
 * cancels markets. It defaults to the deployer, which is fine for a local chain and a bad idea
 * anywhere real. The admin moves it later with `setOperator`.
 *
 * A market's fee is a term of each market, which the operator signs, at most 5% on the contract.
 */
export default buildModule("bazichemarkets", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const operator = m.getParameter("operator", m.getAccount(0));
  const disputeWindow = m.getParameter("disputeWindow", 900);

  const markets = m.contract("ArcadeMarkets", [admin, operator, disputeWindow]);

  return { markets };
});
