import { describe, expect, it } from 'vitest';

import { classifyError, decodeRevertData } from '../src/lib/errors.ts';

// EIP-1193 providers reject with PLAIN OBJECTS - the classifier must read
// those shapes, not just Error instances.

describe('classifyError', () =>
{
    it('recognizes a plain-object user rejection', () =>
    {
        const result = classifyError({ code: 4001, message: 'The user rejected the request.' });
        expect(result.code).toBe('user-rejected');
        expect(result.title).toBe('Request rejected');
    });

    it('recognizes viem ACTION_REJECTED errors', () =>
    {
        expect(classifyError(new Error('User rejected the request.')).code).toBe('user-rejected');
    });

    it('recognizes a pending wallet request (-32002)', () =>
    {
        expect(classifyError({ code: -32002 }).code).toBe('request-pending');
    });

    it('recognizes chain mismatches after the guard', () =>
    {
        const error = new Error("Chain '0x1' does not match the target chain '0x3fc' for the transaction.");
        expect(classifyError(error).code).toBe('wrong-network');
    });

    it('recognizes a disconnected wallet', () =>
    {
        expect(classifyError(new Error('wallet not connected')).code).toBe('wallet-not-connected');
    });

    it('recognizes insufficient funds', () =>
    {
        expect(classifyError(new Error('insufficient funds for gas * price + value')).code).toBe('insufficient-funds');
    });

    it('surfaces revert reasons as contract-reverted with the reason in the title', () =>
    {
        const result = classifyError(new Error('execution reverted with reason "ERC20: insufficient allowance"'));
        expect(result.code).toBe('contract-reverted');
        expect(result.title).toBe('Reverted: ERC20: insufficient allowance');
    });

    it('decodes Error(string) revert data attached to the message', () =>
    {
        const reason = 'Ownable: caller is not the owner';
        // selector + offset(32B) + length(32B) + the UTF-8 reason.
        const word = (value: number): string => value.toString(16).padStart(64, '0');
        const hex = Array.from(reason, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        const data = `0x08c379a0${ word(32) }${ word(reason.length) }${ hex }`;
        const result = classifyError(new Error(`execution reverted, data "${ data }"`));
        expect(result.code).toBe('contract-reverted');
        expect(result.title).toBe('Reverted: Ownable: caller is not the owner');
    });

    it('maps invalid input to invalid-arguments', () =>
    {
        expect(classifyError(new Error('invalid address')).code).toBe('invalid-arguments');
    });

    it('maps RPC failures to rpc-error', () =>
    {
        expect(classifyError(new Error('HTTP request failed: 429 too many requests')).code).toBe('rpc-error');
    });

    it('keeps the raw text for debugging', () =>
    {
        const raw = 'weird provider failure 12345';
        expect(classifyError(new Error(raw)).technical).toContain(raw);
    });
});

describe('decodeRevertData', () =>
{
    it('decodes Panic(uint256) codes', () =>
    {
        // keccak("Panic(uint256)") = 0x4e487b71..., code 17 (overflow)
        const data = `0x4e487b71${ '00'.repeat(31) }11`;
        expect(decodeRevertData(data)).toContain('arithmetic overflow');
    });

    it('returns null for non-selector blobs', () =>
    {
        expect(decodeRevertData('0xdeadbeefdeadbeef')).toBe('custom error 0xdeadbeef');
        expect(decodeRevertData('0x')).toBe(null);
    });
});
