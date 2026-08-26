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
    ['univ2/periphery/WNURA.sol/WNURA.json', 'WNURA.json'],
    ['univ2/vendor/Multicall3.sol/Multicall3.json', 'Multicall3.json'],
    ['univ2/core/UniswapV2Factory.sol/UniswapV2Factory.json', 'UniswapV2Factory.json'],
    ['univ2/periphery/UniswapV2Router02.sol/UniswapV2Router02.json', 'UniswapV2Router02.json'],
    ['univ3/core/UniswapV3Factory.sol/UniswapV3Factory.json', 'UniswapV3Factory.json'],
    ['univ3/periphery/NonfungiblePositionManager.sol/NonfungiblePositionManager.json', 'NonfungiblePositionManager.json'],
    ['univ3/periphery/SwapRouter.sol/SwapRouter.json', 'SwapRouter.json'],
    ['univ3/periphery/lens/QuoterV2.sol/QuoterV2.json', 'QuoterV2.json'],
    ['Forecast/PredictionFactory.sol/PredictionFactory.json', 'PredictionFactory.json'],
    ['Forecast/PredictionMarket.sol/PredictionMarket.json', 'PredictionMarket.json'],
    ['Forecast/PredictionTreasury.sol/PredictionTreasury.json', 'PredictionTreasury.json'],
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
