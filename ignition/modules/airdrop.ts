import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/airdrop — deployed by `npm run deploy:nurachain:airdrop`,
 * or `npx hardhat deploy --sc airdrop --network <network>`.
 *
 * `maxClaims` and `rewardAmount` have no defaults on purpose. The cap is immutable
 * once deployed and the reward decides how much coin you are committing to fund, so
 * they are not values to inherit from whatever someone last wrote in this file. The
 * `deploy` task asks for both at the terminal and passes them in; answer the questions,
 * or supply them up front:
 *
 *   npx hardhat deploy --sc airdrop --network nurachain --max-claims 50000 --reward 200
 *
 * `admin` and `signer` both default to the deployer. Override any of them in
 * ignition/params.json and pass --parameters:
 *
 *   {
 *     "airdrop": {
 *       "admin":  "0xYourMultisig",
 *       "signer": "0xYourBackendSigningKeyAddress",
 *       "maxClaims": "50000n",
 *       "rewardAmount": "200000000000000000000n"
 *     }
 *   }
 *
 * maxClaims and rewardAmount in that file are taken as given — the deploy task only
 * asks about the ones it cannot find. rewardAmount there is in wei, unlike --reward,
 * which is in whole coin.
 *
 * Set `signer` to the address of the backend key that will sign eligibility. Leaving
 * it as the deployer means your deployer key doubles as the signing key, which is
 * fine for a testnet run and a bad idea in production.
 *
 * This module only deploys the contract — it does not fund it. Covering every claim
 * needs `maxClaims * rewardAmount` sent to the deployed address afterwards.
 *
 * Deploying this module directly through `npx hardhat ignition deploy` skips the
 * questions and fails on the two missing parameters instead. That is the intended
 * failure: go through `hardhat deploy --sc airdrop`.
 */
export default buildModule("airdrop", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const signer = m.getParameter("signer", m.getAccount(0));
  const maxClaims = m.getParameter<bigint>("maxClaims");
  const rewardAmount = m.getParameter<bigint>("rewardAmount");

  const airdrop = m.contract("Airdrop", [admin, signer, maxClaims, rewardAmount]);

  return { airdrop };
});
