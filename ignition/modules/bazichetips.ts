import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * ArcadeTips alone, from contracts/baziche - deployed by `npm run deploy:nurachain:bazichetips`,
 * or `npx hardhat deploy --sc bazichetips --network <network>`. A group of its own so that a
 * chain which already holds the vault, the achievements and the shop is not given a second of
 * each.
 *
 *   {
 *     "bazichetips": {
 *       "admin": "0xYourAdminWallet"
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE, which is all
 * the contract has: the owner can stop new gifts and start them again, and nothing else. It is
 * handed on in two steps, `beginDefaultAdminTransfer(next)` then `acceptDefaultAdminTransfer()`.
 */
export default buildModule("bazichetips", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));

  const tips = m.contract("ArcadeTips", [admin]);

  return { tips };
});
