// The contract registry - the SINGLE SOURCE OF TRUTH for everything this
// application can talk to. No component hardcodes an address or an ABI; they
// read this file.
//
// Entries mirror the contracts repository (C:/Users/Alex/Desktop/Smart
// Contract): each ABI is the compiled artifact from that repo's
// artifacts/contracts tree, refreshed by `node scripts/extract-abi.mjs`.
//
// An entry with `address: null` is a supported contract whose deployment this
// repository has no address on record for. It is listed honestly as such -
// never guessed, never faked. When a deployment lands, record its address here.

import type { Abi, Address } from 'viem';

import AirdropAbi from './abi/Airdrop.json';
import BridgeBnbAbi from './abi/BridgeBNB.json';
import BridgeUsdtAbi from './abi/BridgeUSDT.json';
import CollateralizedNftAbi from './abi/CollateralizedNFT.json';
import Multicall3Abi from './abi/Multicall3.json';
import NonfungiblePositionManagerAbi from './abi/NonfungiblePositionManager.json';
import NuraProfileAbi from './abi/NuraProfile.json';
import NuraProfileLensAbi from './abi/NuraProfileLens.json';
import PredictionFactoryAbi from './abi/PredictionFactory.json';
import PredictionMarketAbi from './abi/PredictionMarket.json';
import PredictionPoolAbi from './abi/PredictionPool.json';
import PredictionTreasuryAbi from './abi/PredictionTreasury.json';
import QuoterV2Abi from './abi/QuoterV2.json';
import SocialVerifierAbi from './abi/SocialVerifier.json';
import SwapRouterAbi from './abi/SwapRouter.json';
import UniswapV3FactoryAbi from './abi/UniswapV3Factory.json';
import WnuraAbi from './abi/WNURA.json';

import { NURA_CHAIN_ID } from './chain.ts';

export type ContractCategory =
    | 'token'
    | 'airdrop'
    | 'amm-v3'
    | 'prediction'
    | 'vault'
    | 'identity'
    | 'infra';

export interface ContractDef
{
    /** URL slug and stable reference used by the activity log. */
    id: string;
    name: string;
    description: string;
    category: ContractCategory;
    chainId: number;
    /** Deployed address on record, or null when none has been recorded. */
    address: Address | null;
    abi: Abi;
    /** Where the deployment comes from, shown verbatim in the overview. */
    deploymentNote?: string;
    /**
     * Function names whose ABI says nonpayable but which are DESIGNED to be
     * called statically: they answer by reverting with their result in the
     * revert data (the Uniswap V3 Quoter pattern). Listed here so the UI can
     * offer them as reads instead of pretending they are transactions.
     */
    staticCallables?: string[];
}

export const CATEGORY_LABEL: Record<ContractCategory, string> = {
    token: 'Token',
    airdrop: 'Airdrop',
    'amm-v3': 'AMM · V3',
    prediction: 'Prediction',
    vault: 'Vault',
    identity: 'Identity',
    infra: 'Infrastructure'
};

// Live addresses on Nura Chain (1020), as recorded in the contracts repository
// (README, ignition module defaults, and the fork-patched position descriptor).
const BRIDGE_USDT = '0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC' as Address;
const BRIDGE_BNB = '0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc' as Address;
const WNURA = '0xf0a4eC07916feBa4432121Ed5969887D9b939cD0' as Address;
const MULTICALL3 = '0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24' as Address;
// Forecast (prediction market) – deployed 2026-08-26 via ignition/modules/forecast.ts
// Batch #1: implementations + treasury, Batch #2: factory (clone deployer + registry).
// See ignition/deployments/chain-1020/journal.jsonl and hardhat.config.ts:619 ignition fees.
const PREDICTION_MARKET_IMPL = '0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145' as Address;
const PREDICTION_POOL_IMPL = '0x675b24758B199c3A5674f0288dfdeaA217fB2A86' as Address;
const PREDICTION_TREASURY = '0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8' as Address;
const PREDICTION_FACTORY = '0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d' as Address;

export const CONTRACTS: readonly ContractDef[] = [
    {
        id: 'bridge-usdt',
        name: 'BridgeUSDT',
        description: 'Bridge-managed USDT representation. OpenZeppelin ERC20 with mint/burn, pause and permit behind AccessControl roles.',
        category: 'token',
        chainId: NURA_CHAIN_ID,
        address: BRIDGE_USDT,
        abi: BridgeUsdtAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/token.ts.'
    },
    {
        id: 'bridge-bnb',
        name: 'BridgeBNB',
        description: 'Bridge-managed BNB representation. OpenZeppelin ERC20 with mint/burn, pause and permit behind AccessControl roles.',
        category: 'token',
        chainId: NURA_CHAIN_ID,
        address: BRIDGE_BNB,
        abi: BridgeBnbAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/token.ts.'
    },
    {
        id: 'wnura',
        name: 'WNURA',
        description: 'Wrapped NURA. The canonical WETH9 wrapper: deposit native coin to mint, withdraw to unwrap.',
        category: 'token',
        chainId: NURA_CHAIN_ID,
        address: WNURA,
        abi: WnuraAbi as Abi,
        deploymentNote: 'Live since the original exchange deployment.'
    },
    {
        id: 'multicall3',
        name: 'Multicall3',
        description: 'Aggregate arbitrary calls into one transaction or one eth_call. Shared infrastructure across the chain.',
        category: 'infra',
        chainId: NURA_CHAIN_ID,
        address: MULTICALL3,
        abi: Multicall3Abi as Abi,
        deploymentNote: 'Shared Multicall3 deployment.'
    },
    {
        id: 'airdrop',
        name: 'Airdrop',
        description: 'Native-coin claims gated by an EIP-712 signature from a backend signer. Funded separately; immutable claim cap.',
        category: 'airdrop',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: AirdropAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/airdrop.ts with --max-claims/--reward; address recorded at deploy time only.'
    },
    {
        id: 'prediction-factory',
        name: 'PredictionFactory',
        description: 'Deploys prediction-market clones (CPMM and parimutuel) and keeps the registry. Admin controls fees, treasury and lifecycle; resolution itself needs an N-of-M signer quorum (e.g. 3-of-5).',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_FACTORY,
        abi: PredictionFactoryAbi as Abi,
        deploymentNote: 'Deployed 2026-08-26 by ignition/modules/forecast.ts (`npm run deploy:nurachain:forecast`) — Batch #2. Verified on Nurachain (1020) at 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d.'
    },
    {
        id: 'prediction-market',
        name: 'PredictionMarket',
        description: 'CPMM prediction market clone implementation (ERC1155 outcome shares): buy, sell, merge sets, redeem, funding controls. This is the template; each live market is a minimal proxy via PredictionFactory.createMarket.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_MARKET_IMPL,
        abi: PredictionMarketAbi as Abi,
        deploymentNote: 'Implementation deployed 2026-08-26 by forecast Batch #1 at 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 (clones via factory; paste a specific market address to interact as an instance).'
    },
    {
        id: 'prediction-pool',
        name: 'PredictionPool',
        description: 'Parimutuel prediction market clone implementation: bet native coin on an outcome, admin resolves after lockTime, winners claim pro-rata net of fee. This is the template; each live market is a minimal proxy via PredictionFactory.createMarket2.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_POOL_IMPL,
        abi: PredictionPoolAbi as Abi,
        deploymentNote: 'Implementation deployed 2026-08-26 by forecast Batch #1 at 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 (clones via factory; paste a specific market address to interact as an instance).'
    },
    {
        id: 'prediction-treasury',
        name: 'PredictionTreasury',
        description: 'Collects protocol fees from markets; withdraws go to the configured fee recipient.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_TREASURY,
        abi: PredictionTreasuryAbi as Abi,
        deploymentNote: 'Deployed 2026-08-26 by forecast Batch #1 at 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8; repointable via PredictionFactory.setTreasury.'
    },
    {
        id: 'collateralized-nft',
        name: 'CollateralizedNFT',
        description: 'ERC721 where every token locks a fixed slice of one backing ERC20 reserve. Mint gated until public mint is enabled.',
        category: 'vault',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: CollateralizedNftAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/vault.ts plus scripts/vault-setup.ts.'
    },
    {
        id: 'nura-profile',
        name: 'NuraProfile',
        description: 'Decentralized profile registry: one profile per address, unique usernames, localizable fields, generic websites/images/socials (and any other item kind), operators, two-step transfer, curated extensions. UUPS proxy - this is the implementation ABI at the proxy address.',
        category: 'identity',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: NuraProfileAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/profile.ts (`npm run deploy:nurachain:profile`); the address to record is the NuraProfileProxy. Register the verifier with scripts/profile-setup.ts.'
    },
    {
        id: 'nura-profile-lens',
        name: 'NuraProfileLens',
        description: 'Read model over NuraProfile: getProfile(address, lang), getFullProfile, getWebsites/getImages/getSocials and paged getItems, all resolved in one language with fallback. Stateless and replaceable.',
        category: 'identity',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: NuraProfileLensAbi as Abi,
        deploymentNote: 'Deployed alongside the core by ignition/modules/profile.ts; bound to the proxy at construction.'
    },
    {
        id: 'social-verifier',
        name: 'SocialVerifier',
        description: 'Reference profile extension: records EIP-712-attested handles (GitHub, X, Telegram, ...) into its own namespace on a profile after the owner opts in. VERIFIER_ROLE signs, owner or operator submits.',
        category: 'identity',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: SocialVerifierAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/profile.ts; registered on the core as "social-verifier" by scripts/profile-setup.ts.'
    },
    {
        id: 'uniswap-v3-factory',
        name: 'UniswapV3Factory',
        description: 'Creates V3 pools per fee tier and owns them. Pools themselves are created deterministically, one address each.',
        category: 'amm-v3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: UniswapV3FactoryAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/univ3.ts; address recorded at deploy time only.'
    },
    {
        id: 'nonfungible-position-manager',
        name: 'NonfungiblePositionManager',
        description: 'Mints liquidity positions as NFTs: mint, increase, decrease, collect fees, burn.',
        category: 'amm-v3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: NonfungiblePositionManagerAbi as Abi,
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    },
    {
        id: 'swap-router',
        name: 'SwapRouter',
        description: 'V3 swaps: exactInput/exactOutput single- and multi-pool routes, with multicall and native-coin refund helpers.',
        category: 'amm-v3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: SwapRouterAbi as Abi,
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    },
    {
        id: 'quoter-v2',
        name: 'QuoterV2',
        description: 'Quotes V3 swap results. Answers by REVERTING with the quote encoded in the revert data - callable statically, never sendable.',
        category: 'amm-v3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: QuoterV2Abi as Abi,
        staticCallables: ['quoteExactInput', 'quoteExactInputSingle', 'quoteExactOutput', 'quoteExactOutputSingle'],
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    }
];

export function findContract(id: string | undefined): ContractDef | undefined
{
    return CONTRACTS.find((def) => def.id === id);
}

export function isKnownCategory(value: string): value is ContractCategory
{
    return Object.hasOwn(CATEGORY_LABEL, value);
}
