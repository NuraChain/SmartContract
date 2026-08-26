import { describe, expect, it } from 'vitest';
import type { Abi } from 'viem';
import { parseAbi } from 'viem';

import {
    formatValue,
    parseAbiFunctions,
    parseValue,
    toParamSpec,
    weiHint
} from '../src/lib/abi.ts';
import { InvalidInputError } from '../src/lib/abi.ts';

const TEST_ABI = parseAbi([
    'function balanceOf(address owner) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function mint(address to, uint256 amount) payable',
    'function setApprovalForAll(address operator, bool approved)',
    'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
    'function batchCall(address[] targets, uint256[] values)',
    'struct Vote { uint256 proposalId; bool support; }',
    'function castVote(Vote vote) returns (uint256)',
    'function pairs(uint256[2] ids)'
]);

describe('parseAbiFunctions', () =>
{
    const { reads, writes } = parseAbiFunctions(TEST_ABI as Abi);

    it('splits reads and writes by mutability, in declaration order', () =>
    {
        expect(reads.map((fn) => fn.name)).toEqual(['balanceOf', 'totalSupply']);
        expect(writes.map((fn) => fn.name)).toEqual([
            'transfer', 'mint', 'setApprovalForAll', 'safeTransferFrom', 'batchCall', 'castVote', 'pairs'
        ]);
    });

    it('builds canonical signatures', () =>
    {
        const transfer = writes.find((fn) => fn.name === 'transfer');
        expect(transfer?.signature).toBe('transfer(address,uint256)');
        const balanceOf = reads[0];
        expect(balanceOf.signature).toBe('balanceOf(address)');
    });

    it('flags payable functions', () =>
    {
        const mint = writes.find((fn) => fn.name === 'mint');
        expect(mint?.payable).toBe(true);
        expect(mint?.mutability).toBe('payable');
        const transfer = writes.find((fn) => fn.name === 'transfer');
        expect(transfer?.payable).toBe(false);
    });

    it('carries output types', () =>
    {
        const transfer = writes.find((fn) => fn.name === 'transfer');
        expect(transfer?.outputs.map((output) => output.type)).toEqual(['bool']);
        const mint = writes.find((fn) => fn.name === 'mint');
        expect(mint?.outputs).toHaveLength(0);
    });

    it('drops constructors, fallbacks and receive', () =>
    {
        const extended = [
            ...(TEST_ABI as Abi),
            { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
            { type: 'fallback', stateMutability: 'payable' },
            { type: 'receive', stateMutability: 'payable' }
        ] as Abi;
        const all = parseAbiFunctions(extended);
        expect(all.reads.length + all.writes.length).toBe(TEST_ABI.length);
    });
});

describe('toParamSpec / signatureOf', () =>
{
    it('detects array depth', () =>
    {
        const abi = parseAbi(['function f(uint256[3][] xs)']);
        const spec = toParamSpec((abi[0] as unknown as { inputs: Array<Parameters<typeof toParamSpec>[0]> }).inputs[0]);
        expect(spec.arrayDepth).toBe(2);
        expect(spec.base).toBe('uint');
        expect(spec.type).toBe('uint256[3][]');
    });

    it('marks tuple base with components', () =>
    {
        const castVote = (parseAbiFunctions(TEST_ABI as Abi).writes).find((fn) => fn.name === 'castVote');
        const voteParam = castVote?.inputs[0];
        expect(voteParam?.base).toBe('tuple');
        expect(voteParam?.components?.map((component) => component.name)).toEqual(['proposalId', 'support']);
    });
});

describe('parseValue', () =>
{
    it('accepts valid addresses', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(address a)'])[0].inputs[0]);
        expect(parseValue(spec, 'a', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(
            '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
        );
    });

    it('rejects invalid addresses', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(address a)'])[0].inputs[0]);
        expect(() => parseValue(spec, 'a', 'not-an-address')).toThrow(InvalidInputError);
        expect(() => parseValue(spec, 'a', '0x1234')).toThrow(InvalidInputError);
    });

    it('passes raw integers through untouched', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(uint256 v)'])[0].inputs[0]);
        expect(parseValue(spec, 'v', '1500000000000000000')).toBe(1_500_000_000_000_000_000n);
    });

    it('scales decimal input by 10^18 and echoes raw', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(uint256 v)'])[0].inputs[0]);
        expect(parseValue(spec, 'v', '1.5')).toBe(1_500_000_000_000_000_000n);
        expect(parseValue(spec, 'v', '0.000001')).toBe(1_000_000_000_000n);
    });

    it('handles signed ints', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(int256 v)'])[0].inputs[0]);
        expect(parseValue(spec, 'v', '-2.5')).toBe(-2_500_000_000_000_000_000n);
    });

    it('rejects garbage numbers', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(uint256 v)'])[0].inputs[0]);
        expect(() => parseValue(spec, 'v', 'abc')).toThrow(InvalidInputError);
        expect(() => parseValue(spec, 'v', '')).toThrow(InvalidInputError);
    });

    it('parses booleans strictly', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(bool b)'])[0].inputs[0]);
        expect(parseValue(spec, 'b', 'true')).toBe(true);
        expect(() => parseValue(spec, 'b', 'TRUE')).toThrow(InvalidInputError);
    });

    it('validates hex for fixed-size bytes', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(bytes32 h)'])[0].inputs[0]);
        const valid = `0x${ 'ab'.repeat(32) }`;
        expect(parseValue(spec, 'h', valid)).toBe(valid);
        expect(() => parseValue(spec, 'h', `0x${ 'ab'.repeat(31) }`)).toThrow(/exactly 32/);
        expect(() => parseValue(spec, 'h', 'zzzz')).toThrow(InvalidInputError);
    });

    it('takes JSON arrays with per-element validation', () =>
    {
        const fn = parseAbi(['function f(address[] addrs)'])[0];
        const spec = toParamSpec(fn.inputs[0]);
        const value = parseValue(spec, 'addrs', '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]') as string[];
        expect(value).toHaveLength(1);
        expect(() => parseValue(spec, 'addrs', '[123]')).toThrow(InvalidInputError);
    });

    it('enforces fixed-length arrays', () =>
    {
        const spec = toParamSpec(parseAbi(['function f(uint256[3] ids)'])[0].inputs[0]);
        expect(parseValue(spec, 'ids', '[1, 2, 3]')).toEqual([1n, 2n, 3n]);
        expect(() => parseValue(spec, 'ids', '[1, 2]')).toThrow(/exactly 3/);
    });

    it('unrolls tuples from named JSON objects', () =>
    {
        const castVote = parseAbiFunctions(TEST_ABI as Abi).writes.find((fn) => fn.name === 'castVote');
        const spec = toParamSpec(castVote!.inputs[0]);
        const args = parseValue(spec, 'vote', '{"proposalId": "7", "support": "true"}') as unknown[];
        expect(args).toEqual([7n, true]);
        expect(() => parseValue(spec, 'vote', '{"support": "true"}')).toThrow(/missing/);
    });
});

describe('weiHint / formatValue', () =>
{
    it('hints only at wei-like magnitudes', () =>
    {
        expect(weiHint(10n ** 18n)).toBe('1');
        expect(weiHint(1_500_000_000_000_000_000n)).toBe('1.5');
        expect(weiHint(999n * 10n ** 12n)).toBe(null);
        expect(weiHint(42n)).toBe(null);
        expect(weiHint(10n ** 30n)).toBe(null);
    });

    it('formats bigints as raw digits', () =>
    {
        expect(formatValue(123n)).toBe('123');
        expect(formatValue([1n, 'ok'])).toBe('[1, ok]');
    });
});
