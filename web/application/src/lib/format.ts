// Display formatting over raw on-chain values. Everything returns strings for
// the UI; no parsing lives here (input parsing is lib/abi.ts).

export function shortAddress(address: string): string
{
    return `${ address.slice(0, 6) }…${ address.slice(-4) }`;
}

/** Two hues from the address bytes - the deterministic identicon gradient. */
export function addressGradient(address: string): string
{
    let first = 0;
    let second = 0;
    for (let index = 2; index < address.length; index++)
    {
        const code = address.charCodeAt(index);
        if (index % 2 === 0)
        {
            first = (first + code * 7) % 360;
        }
        else
        {
            second = (second + code * 13) % 360;
        }
    }
    return `linear-gradient(135deg, hsl(${ first } 70% 55%), hsl(${ second } 70% 40%))`;
}

/** "2 minutes ago" style relative time, English. */
export function timeAgo(timestamp: number, now = Date.now()): string
{
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 10)
    {
        return 'just now';
    }
    if (seconds < 60)
    {
        return `${ seconds } seconds ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
    {
        return `${ minutes } minute${ minutes === 1 ? '' : 's' } ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24)
    {
        return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
    }
    const days = Math.round(hours / 24);
    return `${ days } day${ days === 1 ? '' : 's' } ago`;
}

export function fmtTime(timestamp: number): string
{
    return new Intl.DateTimeFormat('en', {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: 'numeric'
    }).format(timestamp);
}

/** Groups an integer string with commas. */
export function groupDigits(digits: string): string
{
    const [whole, fraction] = digits.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction !== undefined && fraction.length > 0 ? `${ grouped }.${ fraction }` : grouped;
}

/** Wei -> native units at display precision. */
export function fmtNative(wei: bigint): string
{
    const negative = wei < 0n;
    const abs = negative ? -wei : wei;
    const whole = abs / 10n ** 18n;
    const fraction = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    const text = fraction === '' ? whole.toString() : `${ whole }.${ fraction.slice(0, 6) }`;
    return `${ negative ? '-' : '' }${ groupDigits(text || '0') }`;
}

/** Gas as a grouped integer; undefined-safe. */
export function fmtGas(gas: bigint | null): string
{
    if (gas === null)
    {
        return '';
    }
    return groupDigits(gas.toString());
}
