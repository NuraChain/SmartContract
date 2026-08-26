// Builds public/coins.svg: real coin marks from cryptocurrency-icons (MIT) as
// <symbol>s, plus the NURA coin - a shamseh on the brand ice disc. TokenIcon
// references them with <use>; unknown tokens keep the gradient monogram.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COINS = ['bnb', 'usdt', 'usdc', 'dai', 'wbtc'];

const require = createRequire(import.meta.url);
const svgDir = join(dirname(require.resolve('cryptocurrency-icons/package.json')), 'svg', 'color');

const symbols = COINS.map((name) =>
{
    const svg = readFileSync(join(svgDir, `${ name }.svg`), 'utf8');
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    return `<symbol id="c-${ name }" viewBox="0 0 32 32">${ inner }</symbol>`;
});

// NURA: the shamseh (two rotated squares + core) in value-gold on the ice disc.
symbols.push(
    '<symbol id="c-nura" viewBox="0 0 32 32">'
    + '<circle cx="16" cy="16" r="16" fill="#1f6fa8"/>'
    + '<g transform="translate(16 16) scale(0.155)" fill="none" stroke="#f4d07a">'
    + '<rect x="-31" y="-31" width="62" height="62" stroke-width="7"/>'
    + '<rect x="-31" y="-31" width="62" height="62" stroke-width="7" transform="rotate(45)"/>'
    + '<circle r="10" fill="#f4d07a" stroke="none"/>'
    + '</g>'
    + '</symbol>'
);

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${ symbols.join('') }</svg>\n`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'coins.svg');
writeFileSync(out, sprite);
console.log(`coins.svg: ${ symbols.length } symbols`);
