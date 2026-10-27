import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * ArcadeShop alone, from contracts/baziche - deployed by `npm run deploy:nurachain:bazicheshop`,
 * or `npx hardhat deploy --sc bazicheshop --network <network>`. A group of its own so that a
 * chain which already holds the vault and the achievements is not given a second of each.
 *
 *   {
 *     "bazicheshop": {
 *       "admin":       "0xYourAdminWallet",
 *       "seller":      "0xTheArcadeServersKey",
 *       "referralBps": 1000
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE; it is
 * handed on in two steps, `beginDefaultAdminTransfer(next)` then `acceptDefaultAdminTransfer()`.
 *
 * `seller` is the address of the Arcade server's key (its `NURA_REFEREE_KEY`, the one key that
 * server signs with), the only key whose quotes the shop takes. It defaults to the deployer,
 * which is fine for a local chain and a bad idea anywhere real: the deployer would then be the
 * key that prices every sale. The admin moves it later with `setSeller`.
 *
 * `referralBps` is the part of each sale its buyer's inviter is credited, in basis points of the
 * price (1,000 is 10%, from 0 to 3,000). The admin changes it later with `setReferralBps`.
 */
export default buildModule("bazicheshop", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const seller = m.getParameter("seller", m.getAccount(0));
  const referralBps = m.getParameter("referralBps", 1_000);

  const shop = m.contract("ArcadeShop", [admin, seller, referralBps]);

  return { shop };
});
