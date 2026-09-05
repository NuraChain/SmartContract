import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';

import { NURA_CHAIN_ID } from '../src/config/chain.ts';
import { CATEGORY_LABEL, FOLDERS, contractsInFolder, findFolder } from '../src/config/contracts.ts';
import type { ContractCategory } from '../src/config/contracts.ts';
import { CONTRACTS, findContract } from '../src/config/contracts.ts';
import { parseAbiFunctions } from '../src/lib/abi.ts';

const KNOWN_CATEGORIES = Object.keys(CATEGORY_LABEL) as ContractCategory[];

describe('contract registry', () =>
{
    it('has unique ids', () =>
    {
        const ids = CONTRACTS.map((def) => def.id);
        expect(new Set(ids).size).toBe(CONTRACTS.length);
    });

    it('targets Nura Chain only', () =>
    {
        for (const def of CONTRACTS)
        {
            expect(def.chainId).toBe(NURA_CHAIN_ID);
        }
    });

    it('carries a non-empty ABI with at least one callable function each', () =>
    {
        for (const def of CONTRACTS)
        {
            expect(def.abi.length).toBeGreaterThan(0);
            const { reads, writes } = parseAbiFunctions(def.abi);
            expect(reads.length + writes.length).toBeGreaterThan(0);
        }
    });

    it('uses checksummed addresses or none at all', () =>
    {
        for (const def of CONTRACTS)
        {
            if (def.address !== null)
            {
                // getAddress throws on a bad checksum - the registry must not
                // carry an address it would silently mis-encode against.
                expect(() => getAddress(def.address as string)).not.toThrow();
                expect(getAddress(def.address as string)).toBe(def.address);
            }
        }
    });

    it('only declares staticCallables that exist in the ABI as writes', () =>
    {
        for (const def of CONTRACTS)
        {
            if (def.staticCallables === undefined)
            {
                continue;
            }
            const { reads, writes } = parseAbiFunctions(def.abi);
            const readNames = new Set(reads.map((fn) => fn.name));
            const writeNames = new Set(writes.map((fn) => fn.name));
            for (const name of def.staticCallables)
            {
                expect(writeNames.has(name), `${ def.id }: ${ name } should be a write`).toBe(true);
                expect(readNames.has(name)).toBe(false);
            }
        }
    });

    it('classifies every contract into a known category', () =>
    {
        for (const def of CONTRACTS)
        {
            expect(KNOWN_CATEGORIES).toContain(def.category);
        }
    });

    it('resolves by id and only by id', () =>
    {
        expect(findContract('bridge-usdt')?.name).toBe('BridgeUSDT');
        expect(findContract('nonexistent')).toBeUndefined();
        expect(findContract(undefined)).toBeUndefined();
    });

    it('files every contract under a declared folder, and every folder holds something', () =>
    {
        const ids = FOLDERS.map((folder) => folder.id);
        expect(new Set(ids).size).toBe(FOLDERS.length);

        for (const def of CONTRACTS)
        {
            expect(ids, `${ def.id } names an unknown folder`).toContain(def.folder);
            expect(findFolder(def.folder).id).toBe(def.folder);
        }
        for (const folder of FOLDERS)
        {
            expect(contractsInFolder(folder.id).length, `${ folder.id } section would be empty`).toBeGreaterThan(0);
            expect(folder.path).not.toBe('');
            expect(folder.deploy).not.toBe('');
        }
    });

    it('mirrors the contracts repository: each deployable folder is a `hardhat deploy --sc` group', () =>
    {
        const deployable = ['token', 'airdrop', 'univ3', 'vault', 'forecast', 'profile'];
        for (const id of deployable)
        {
            const folder = findFolder(id as (typeof FOLDERS)[number]['id']);
            expect(folder.path).toBe(`contracts/${ id }`);
            expect(folder.deploy).toContain(`--sc ${ id }`);
        }
        expect(findFolder('testing').path).toBe('contracts/testing');
        expect(contractsInFolder('profile').map((def) => def.id)).toEqual(['nura-profile', 'nura-profile-lens', 'social-verifier']);
    });
});
