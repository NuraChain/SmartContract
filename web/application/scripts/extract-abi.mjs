// Extracts the `abi` arrays from the Hardhat artifacts of the contracts
// repository (C:/Users/Alex/Desktop/Smart Contract) into src/config/abi.
// Bytecode stays behind: this app calls deployed contracts, it does not deploy.
// Rerun after recompiling the contracts repository.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.env.ARTIFACTS_DIR ?? 'C:/Users/Alex/Desktop/Smart Contract/artifacts/contracts';
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'config', 'abi');

const picks = [
    ['airdrop/Airdrop.sol/Airdrop.json', 'Airdrop.json'],
    ['token/BridgeUSDT.sol/BridgeUSDT.json', 'BridgeUSDT.json'],
    ['token/BridgeBNB.sol/BridgeBNB.json', 'BridgeBNB.json'],
    // Wrapped-native wrapper. Lives under contracts/testing in the contracts repo;
    // on Nura Chain the canonical WNURA predates that move and stays where it is.
    ['testing/WNURA.sol/WNURA.json', 'WNURA.json'],
    // Multicall3 is no longer vendored in the contracts repo (it rode along with the
    // removed UniswapV2 tree). Its ABI is frozen by design - Multicall3 is a canonical,
    // immutable chain-wide deployment - so the checked-in Multicall3.json snapshot is
    // kept as-is and simply not regenerated here.
    ['univ3/core/UniswapV3Factory.sol/UniswapV3Factory.json', 'UniswapV3Factory.json'],
    ['univ3/periphery/NonfungiblePositionManager.sol/NonfungiblePositionManager.json', 'NonfungiblePositionManager.json'],
    ['univ3/periphery/SwapRouter.sol/SwapRouter.json', 'SwapRouter.json'],
    ['univ3/periphery/lens/QuoterV2.sol/QuoterV2.json', 'QuoterV2.json'],
    ['forecast/PredictionFactory.sol/PredictionFactory.json', 'PredictionFactory.json'],
    ['forecast/PredictionMarket.sol/PredictionMarket.json', 'PredictionMarket.json'],
    ['forecast/PredictionPool.sol/PredictionPool.json', 'PredictionPool.json'],
    ['forecast/PredictionTreasury.sol/PredictionTreasury.json', 'PredictionTreasury.json'],
    ['vault/CollateralizedNFT.sol/CollateralizedNFT.json', 'CollateralizedNFT.json']
];

let total = 0;
for (const [from, to] of picks)
{
    const artifact = JSON.parse(readFileSync(`${ SRC }/${ from }`, 'utf8'));
    if (!Array.isArray(artifact.abi) || artifact.abi.length === 0)
    {
        throw new Error(`no abi in ${ from }`);
    }
    writeFileSync(`${ OUT }/${ to }`, `${ JSON.stringify(artifact.abi, null, 4) }\n`);
    total += artifact.abi.length;
    console.log(`${ to }: ${ artifact.abi.length } entries`);
}
console.log(`${ picks.length } files, ${ total } abi entries`);
