import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/profile — deployed by `npm run deploy:nurachain:profile`,
 * or `npx hardhat deploy --sc profile --network <network>`.
 *
 * Four deployments, one address that matters:
 *
 *   NuraProfile        the UUPS implementation. Its constructor disables initializers, so
 *                      the bare implementation can never be claimed; only the proxy is live.
 *   NuraProfileProxy   ERC-1967 proxy, initialized atomically with `initialize(owner)`.
 *                      THIS is the profile registry address: wallets, indexers and the lens
 *                      all point here, and it never changes across upgrades.
 *   NuraProfileLens    stateless read model (getProfile, getFullProfile, getWebsites, ...),
 *                      bound to the proxy. Redeploy freely; nothing depends on its address.
 *   SocialVerifier     the reference extension: EIP-712 attestations that a profile owns a
 *                      handle on an external platform. Deployed here but NOT registered —
 *                      registration is an owner action, done by scripts/profile-setup.ts so
 *                      it also works when `owner` is a multisig the deployer cannot sign for.
 *
 * Parameters (ignition/params.json via --parameters):
 *
 *   {
 *     "profile": {
 *       "owner":          "0xYourMultisig",
 *       "verifierAdmin":  "0xYourMultisig",
 *       "verifierSigner": "0xBackendSigningKey"
 *     }
 *   }
 *
 * `owner` defaults to the deployer and is the only privileged key on the core: it can upgrade
 * the implementation, register/unregister extensions and reserve usernames. It cannot edit or
 * remove any user's data. Ownership is two-step (Ownable2Step), so moving it to a multisig
 * later is `transferOwnership` from the deployer plus `acceptOwnership` from the multisig.
 *
 * `verifierAdmin` (default deployer) manages VERIFIER_ROLE on the SocialVerifier;
 * `verifierSigner` (default deployer) is the backend key whose signatures it accepts. Use a
 * dedicated hot key for the signer — it only ever signs attestations, never moves funds.
 */
export default buildModule("profile", (m) => {
  const owner = m.getParameter("owner", m.getAccount(0));
  const verifierAdmin = m.getParameter("verifierAdmin", m.getAccount(0));
  const verifierSigner = m.getParameter("verifierSigner", m.getAccount(0));

  const implementation = m.contract("NuraProfile", []);

  // initialize(owner) runs inside the proxy constructor, so there is no window in which an
  // uninitialized proxy could be claimed by someone else.
  const initData = m.encodeFunctionCall(implementation, "initialize", [owner]);
  const proxy = m.contract("NuraProfileProxy", [implementation, initData]);

  // The implementation's ABI at the proxy's address: what every caller uses from here on.
  const profile = m.contractAt("NuraProfile", proxy, { id: "ProfileAtProxy" });

  const lens = m.contract("NuraProfileLens", [proxy]);
  const verifier = m.contract("SocialVerifier", [verifierAdmin, verifierSigner, proxy]);

  return { profile, implementation, proxy, lens, verifier };
});
