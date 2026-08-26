// Builds public/icons.svg as a sprite of <symbol>s from lucide-static (ISC).
// Components reference them with <svg><use href="/icons.svg#i-name" /></svg>.
// Rerun after changing ICONS; the output is committed.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = [
    'arrow-up-right',
    'check',
    'chevron-down',
    'chevron-left',
    'chevron-right',
    'coins',
    'copy',
    'external-link',
    'eye',
    'file-code',
    'layers',
    'menu',
    'moon',
    'pencil',
    'plus',
    'refresh-cw',
    'search',
    'shield-check',
    'sun',
    'triangle-alert',
    'wallet',
    'x'
];

const require = createRequire(import.meta.url);
const iconsDir = join(dirname(require.resolve('lucide-static/package.json')), 'icons');

const symbols = ICONS.map((name) =>
{
    const svg = readFileSync(join(iconsDir, `${ name }.svg`), 'utf8');
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    return `<symbol id="i-${ name }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ inner }</symbol>`;
});

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${ symbols.join('') }</svg>\n`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons.svg');
writeFileSync(out, sprite);
console.log(`icons.svg: ${ symbols.length } symbols`);
