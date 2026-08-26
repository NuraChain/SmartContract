// Variant maps as FULL literal class lists - a Tailwind scanner constraint, not
// a style choice: composed class names are invisible to it. The ice and ghost
// looks live in styles.css component classes; sizes and tones live here.

export type ButtonVariant = 'ice' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_BASE = 'select-none disabled:pointer-events-none';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
    ice: 'btn-ice',
    ghost: 'btn-ghost',
    danger: 'inline-flex items-center justify-center gap-2 rounded-[0.65rem] bg-fall font-medium text-white hover:brightness-110'
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
    sm: 'h-9 px-3 text-[13px]',
    md: 'h-11 px-4 text-sm',
    lg: 'h-12 px-6 text-sm'
};

export function buttonClass(variant: ButtonVariant, size: ButtonSize, block: boolean): string
{
    return `${ BUTTON_BASE } ${ BUTTON_VARIANT[variant] } ${ BUTTON_SIZE[size] }${ block ? ' w-full' : '' }`;
}
