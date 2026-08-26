// Extracts the OFFICIAL wallet vectors from @web3icons/core (MIT) into
// public/wallets - self-hosted, so the connect sheet needs no CDN and no runtime
// icon dependency, and the strict CSP stays closed. Brand colors live in the
// assets; the theme never tints them.
//
// Rerun after changing WALLETS; the output is committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WALLETS = ['metamask', 'trust'];

// The package blocks ./package.json in its exports map, so resolve by path from
// the workspace root rather than through require.resolve.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const brandedDir = [
    join(root, 'node_modules', '@web3icons', 'core', 'dist', 'svgs', 'wallets', 'branded'),
    join(root, 'application', 'node_modules', '@web3icons', 'core', 'dist', 'svgs', 'wallets', 'branded')
].find((candidate) => existsSync(candidate));
if (brandedDir === undefined)
{
    throw new Error('@web3icons/core is not installed - run npm install first');
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wallets');
mkdirSync(out, { recursive: true });

for (const name of WALLETS)
{
    const module = readFileSync(join(brandedDir, `${ name }.svg.js`), 'utf8');
    // The module is `var <ident> = '<svg .../>'` then a blank line and the export -
    // note there is NO trailing semicolon, so the terminator is the export itself.
    const match = module.match(/=\s*'([\s\S]*?)'\s*\r?\n\s*export/);
    if (match === null)
    {
        throw new Error(`could not extract the svg literal from ${ name }.svg.js`);
    }
    const svg = match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\'/g, "'")
        .replace(/ class="web3icons"/, '');
    writeFileSync(join(out, `${ name }.svg`), `${ svg }\n`);
}

console.log(`wallets: ${ WALLETS.length } vectors written to public/wallets`);
