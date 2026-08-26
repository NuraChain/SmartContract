// App-wide toast queue. Pending toasts stay until resolved; the rest expire.

import { createSignal } from 'azerothjs';

export type ToastKind = 'pending' | 'success' | 'error' | 'info';

export interface Toast
{
    id: number;
    kind: ToastKind;
    text: string;
    link?: { href: string; label: string };
}

const [toastsSignal, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export function toasts(): Toast[]
{
    return toastsSignal();
}

export function pushToast(kind: ToastKind, text: string, link?: Toast['link']): number
{
    const id = nextId++;
    setToasts([...toastsSignal(), { id, kind, text, link }]);
    if (kind !== 'pending')
    {
        setTimeout(() => dismissToast(id), 6000);
    }
    return id;
}

// Flips a pending toast in place (tx confirmed/failed) and starts its timeout.
export function resolveToast(id: number, kind: ToastKind, text: string, link?: Toast['link']): void
{
    setToasts(toastsSignal().map((toast) => (toast.id === id ? { ...toast, kind, text, link: link ?? toast.link } : toast)));
    setTimeout(() => dismissToast(id), 8000);
}

export function dismissToast(id: number): void
{
    setToasts(toastsSignal().filter((toast) => toast.id !== id));
}
