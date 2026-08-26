// ABI -> UI. Turns a viem Abi into the descriptors the function cards render,
// validates and converts form input into call args, and formats returned
// values. Pure TypeScript: no chain access, fully unit-testable.

import type { Abi, AbiFunction, AbiParameter } from 'viem';
import { isAddress } from 'viem';

import { groupDigits } from './format.ts';

export type Mutability = 'view' | 'pure' | 'nonpayable' | 'payable';

export interface ParamSpec
{
    /** ABI name, possibly empty; use fallbackName for display. */
    name: string;
    /** Canonical Solidity type string, e.g. `uint256`, `address[3][]`. */
    type: string;
    base:
        | 'address'
        | 'bool'
        | 'string'
        | 'bytes'
        | 'int'
        | 'uint'
        | 'fixed'
        | 'tuple';
    /** Tuple components when base is 'tuple'. */
    components?: readonly AbiParameter[];
    /** Number of array dimensions, straight from the type's suffixes. */
    arrayDepth: number;
}

export interface FunctionSpec
{
    name: string;
    /** Canonical signature, e.g. `transfer(address,uint256)`. */
    signature: string;
    kind: 'read' | 'write';
    mutability: Mutability;
    payable: boolean;
    inputs: ParamSpec[];
    outputs: ParamSpec[];
}

function baseOf(type: string): ParamSpec['base']
{
    if (type === 'tuple')
    {
        return 'tuple';
    }
    const bare = type.replace(/\[\d*\]$/, '');
    if (bare.startsWith('uint') || bare === 'uint')
    {
        return 'uint';
    }
    if (bare.startsWith('int') || bare === 'int')
    {
        return 'int';
    }
    if (/^bytes\d*$/.test(bare))
    {
        return 'bytes';
    }
    if (/^(u?fixed)x\d+x\d+$/.test(bare))
    {
        return 'fixed';
    }
    return bare as ParamSpec['base'];
}

export function toParamSpec(param: AbiParameter): ParamSpec
{
    const arrayDepth = (param.type.match(/\[\d*\]/g) ?? []).length;
    const inner = param.type.replace(/\[\d*\]/g, '');
    const isTuple = inner === 'tuple';
    const spec: ParamSpec = {
        name: param.name ?? '',
        type: param.type,
        base: isTuple ? 'tuple' : baseOf(arrayDepth > 0 ? inner : param.type),
        arrayDepth
    };
    if (isTuple && 'components' in param)
    {
        spec.components = param.components;
    }
    return spec;
}

/** Human label for an unnamed ABI parameter. */
export function paramLabel(spec: ParamSpec, index: number): string
{
    return spec.name !== '' ? spec.name : `param${ index + 1 }`;
}

export function signatureOf(fn: AbiFunction): string
{
    return `${ fn.name }(${ fn.inputs.map((input) => input.type).join(',') })`;
}

function spec(fn: AbiFunction): FunctionSpec
{
    return {
        name: fn.name,
        signature: signatureOf(fn),
        kind: fn.stateMutability === 'view' || fn.stateMutability === 'pure' ? 'read' : 'write',
        mutability: fn.stateMutability as Mutability,
        payable: fn.stateMutability === 'payable',
        inputs: fn.inputs.map(toParamSpec),
        outputs: fn.outputs.map(toParamSpec)
    };
}

/**
 * Splits an ABI into read and write descriptors, in declaration order.
 * Constructor/fallback/receive are not callable through this UI and drop out.
 */
export function parseAbiFunctions(abi: Abi): { reads: FunctionSpec[]; writes: FunctionSpec[] }
{
    const reads: FunctionSpec[] = [];
    const writes: FunctionSpec[] = [];
    for (const entry of abi)
    {
        if (entry.type !== 'function')
        {
            continue;
        }
        const item = spec(entry);
        if (item.kind === 'read')
        {
            reads.push(item);
        }
        else
        {
            writes.push(item);
        }
    }
    return { reads, writes };
}

// ---------------------------------------------------------------------------
// Input parsing: raw text field -> typed call arg.

export class InvalidInputError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'InvalidInputError';
    }
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

function fail(spec: ParamSpec, label: string, why: string): never
{
    throw new InvalidInputError(`${ label } (${ spec.type }): ${ why }`);
}

/** Parses one scalar (non-array) value of the given inner type. JSON input
 *  arrives as numbers/booleans; text fields arrive as strings. */
function parseScalar(spec: ParamSpec, label: string, raw: unknown): unknown
{
    if (spec.base === 'bool' && typeof raw === 'boolean')
    {
        return raw;
    }
    if ((spec.base === 'uint' || spec.base === 'int') && typeof raw === 'number')
    {
        if (!Number.isSafeInteger(raw))
        {
            fail(spec, label, 'not a safe integer');
        }
        raw = String(raw);
    }
    if (typeof raw !== 'string')
    {
        fail(spec, label, 'expected text');
    }
    const text = raw.trim();
    switch (spec.base)
    {
        case 'address':
        {
            if (!isAddress(text))
            {
                fail(spec, label, 'not a valid address');
            }
            return text;
        }
        case 'bool':
        {
            if (text === 'true')
            {
                return true;
            }
            if (text === 'false')
            {
                return false;
            }
            return fail(spec, label, 'must be true or false');
        }
        case 'string':
        {
            return text;
        }
        case 'uint':
        case 'int':
        {
            // A decimal point means human units; scale by 10^18 like every
            // wallet does for token amounts. Plain integers pass through raw.
            const negative = text.startsWith('-');
            const digits = negative ? text.slice(1) : text;
            if (!/^\d+(\.\d+)?$/.test(digits) || !/\d/.test(digits))
            {
                fail(spec, label, 'not a number');
            }
            let value: bigint;
            try
            {
                const point = digits.indexOf('.');
                if (point === -1)
                {
                    // Plain integer: RAW units pass through untouched.
                    value = BigInt(digits);
                }
                else
                {
                    const whole = digits.slice(0, point);
                    const fraction = digits.slice(point + 1);
                    value = BigInt(whole === '' ? '0' : whole) * 10n ** 18n +
                        BigInt((fraction + '000000000000000000').slice(0, 18));
                }
            }
            catch
            {
                fail(spec, label, 'out of range');
            }
            return negative ? -value : value;
        }
        case 'bytes':
        {
            if (!HEX_RE.test(text) || text.length % 2 !== 0)
            {
                fail(spec, label, 'expected hex bytes');
            }
            const fixed = /^bytes(\d+)$/.exec(spec.type);
            if (fixed !== null)
            {
                const width = Number(fixed[1]);
                if (text.length !== 2 * width + 2)
                {
                    fail(spec, label, `expected exactly ${ width } bytes`);
                }
            }
            return text;
        }
        default:
        {
            fail(spec, label, 'unsupported type');
        }
    }
}

function parseArrayLike(
    spec: ParamSpec,
    label: string,
    raw: string,
    elementSpec: ParamSpec
): unknown[]
{
    let parsed: unknown;
    try
    {
        parsed = JSON.parse(raw);
    }
    catch
    {
        fail(spec, label, 'expected a JSON array, e.g. [1, 2]');
    }
    if (!Array.isArray(parsed))
    {
        fail(spec, label, 'expected a JSON array');
    }
    const fixed = spec.type.match(/\[(\d+)\](\[\])?$/);
    if (spec.arrayDepth === 1 && fixed !== null && fixed[2] === undefined && parsed.length !== Number(fixed[1]))
    {
        fail(spec, label, `expected exactly ${ fixed[1] } items`);
    }
    return parsed.map((item, index) => parseValue(elementSpec, `${ label }[${ index }]`, item));
}

/** Converts one field's text into the value viem should encode. */
export function parseValue(spec: ParamSpec, label: string, raw: unknown): unknown
{
    if (spec.arrayDepth > 0)
    {
        if (typeof raw !== 'string')
        {
            fail(spec, label, 'expected a JSON array');
        }
        const innerType = spec.type.replace(/\[\d*\]$/, '');
        const elementSpec: ParamSpec =
            spec.arrayDepth > 1
                ? { ...spec, type: innerType, arrayDepth: spec.arrayDepth - 1 }
                : {
                    name: '',
                    type: innerType,
                    base: baseOf(innerType),
                    arrayDepth: 0,
                    ...(innerType === 'tuple' ? { components: spec.components } : {})
                };
        return parseArrayLike(spec, label, raw.trim() === '' ? '[]' : raw, elementSpec);
    }
    if (spec.base === 'tuple')
    {
        if (typeof raw !== 'string')
        {
            fail(spec, label, 'expected a JSON object');
        }
        let parsed: unknown;
        try
        {
            parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
        }
        catch
        {
            fail(spec, label, 'invalid JSON');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            fail(spec, label, 'expected a JSON object');
        }
        const record = parsed as Record<string, unknown>;
        const componentSpecs = (spec.components ?? []).map(toParamSpec);
        // Positional arrays also work: {"0": v0, "1": v1}.
        return componentSpecs.map((component, index) =>
        {
            const key = component.name !== '' ? component.name : String(index);
            if (!(key in record))
            {
                fail(component, `${ label }.${ key }`, 'missing');
            }
            return parseValue(component, `${ label }.${ key }`, record[key]);
        });
    }
    return parseScalar(spec, label, raw);
}

// ---------------------------------------------------------------------------
// Output formatting: typed values -> display strings. Raw always survives.

const WEI = 10n ** 18n;

/**
 * A human-scale reading of a wei-sized integer, or null when the magnitude
 * does not look like wei (below ~0.001 at 18 decimals). The RAW value stays
 * primary wherever this is shown.
 */
export function weiHint(value: bigint): string | null
{
    const negative = value < 0n;
    const abs = negative ? -value : value;
    if (abs < 10n ** 15n || abs >= 10n ** 30n)
    {
        return null;
    }
    const whole = abs / WEI;
    const fraction = (abs % WEI).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
    const text = fraction === '' ? whole.toString() : `${ whole }.${ fraction }`;
    return `${ negative ? '-' : '' }${ groupDigits(text) }`;
}

function formatOne(value: unknown): string
{
    if (typeof value === 'bigint')
    {
        return value.toString();
    }
    if (value === null || value === undefined)
    {
        return '';
    }
    if (typeof value === 'object')
    {
        return formatStructured(value);
    }
    return String(value);
}

function formatStructured(value: object): string
{
    if (Array.isArray(value))
    {
        return `[${ value.map(formatOne).join(', ') }]`;
    }
    const entries = Object.entries(value).map(([key, item]) => `${ key }: ${ formatOne(item) }`);
    return `{ ${ entries.join(', ') } }`;
}

/** Pretty-printer for read results and error data. */
export function formatValue(value: unknown): string
{
    return formatOne(value);
}
