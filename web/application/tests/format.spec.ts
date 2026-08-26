import { describe, expect, it } from 'vitest';

import { fmtGas, fmtNative, groupDigits, shortAddress, timeAgo } from '../src/lib/format.ts';

describe('format', () =>
{
    it('shortens addresses from both ends', () =>
    {
        expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    });

    it('groups digits without touching fractions', () =>
    {
        expect(groupDigits('1234567')).toBe('1,234,567');
        expect(groupDigits('1234.5678')).toBe('1,234.5678');
        expect(groupDigits('42')).toBe('42');
    });

    it('renders native amounts with trimmed precision', () =>
    {
        expect(fmtNative(10n ** 18n)).toBe('1');
        expect(fmtNative(1_500_000_000_000_000_000n)).toBe('1.5');
        expect(fmtNative(1_234n * 10n ** 15n)).toBe('1.234');
        expect(fmtNative(0n)).toBe('0');
    });

    it('formats gas estimates', () =>
    {
        expect(fmtGas(21_000n)).toBe('21,000');
        expect(fmtGas(null)).toBe('');
    });

    it('speaks relative time in English', () =>
    {
        const now = Date.now();
        expect(timeAgo(now - 2_000, now)).toBe('just now');
        expect(timeAgo(now - 40_000, now)).toBe('40 seconds ago');
        expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
        expect(timeAgo(now - 60 * 60_000, now)).toBe('1 hour ago');
        expect(timeAgo(now - 26 * 60 * 60_000, now)).toBe('1 day ago');
    });
});
