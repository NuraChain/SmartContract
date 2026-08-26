// The RTL grep-lint the style canon promised: physical direction utilities are
// banned in components (logical ms/me/ps/pe/start/end mirror for free; physical
// ones silently break the Persian half of the app). Runs in CI and locally.
//
// Allowed escapes:
// - `rtl:` variants (an explicit, considered override)
// - `-translate-x-1/2` centering (symmetric, direction-free)
//
// `space-x`/`divide-x` are NOT banned: Tailwind v4 builds them out of
// margin-inline-* and border-inline-*, so they already mirror. Pairing one with
// an `rtl:*-reverse` - the v3 idiom, when they were physical left/right - is the
// finding instead: it moves the gap or the rule onto the wrong side, hanging one
// off the outer edge and leaving the last boundary bare. `*-reverse` on its own
// is still right for `flex-row-reverse`, where DOM order really is reversed.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

const BANNED = [
    /\b(?:sm:|md:|lg:|xl:)?(?:-)?m[lr]-\d/,
    /\b(?:sm:|md:|lg:|xl:)?p[lr]-\d/,
    /\b(?:sm:|md:|lg:|xl:)?(?:-)?(?:left|right)-\d/,
    /\btext-(?:left|right)\b/,
    /\brounded-(?:[lr]|t[lr]|b[lr])-/,
    /\bborder-[lr]-/
];

const files = [];
const walk = (dir) =>
{
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
        {
            walk(full);
        }
        else if (/\.(azeroth|ts)$/.test(entry.name))
        {
            files.push(full);
        }
    }
};
walk(ROOT);

const findings = [];
for (const file of files)
{
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) =>
    {
        // Checked BEFORE the rtl: escape below, because this finding IS an rtl: variant.
        if (/\b(?:[a-z]+:)*rtl:(?:[a-z]+:)*(?:space-x|divide-x)-reverse\b/.test(line))
        {
            findings.push(`${ file.replace(ROOT, 'src') }:${ index + 1 }  rtl:*-reverse on space-x/divide-x - they are already logical, drop it`);
        }
        if (line.includes('rtl:'))
        {
            return; // explicit RTL handling on this line - considered
        }
        for (const pattern of BANNED)
        {
            const match = line.match(pattern);
            if (match)
            {
                findings.push(`${ file.replace(ROOT, 'src') }:${ index + 1 }  ${ match[0] }`);
            }
        }
    });
}

if (findings.length > 0)
{
    console.error('rtl-lint: physical direction utilities found - use logical (ms/me/ps/pe/start/end/text-start/text-end) or add rtl: handling:');
    for (const finding of findings)
    {
        console.error('  ' + finding);
    }
    process.exit(1);
}
console.log(`rtl-lint: ${ files.length } files clean.`);
