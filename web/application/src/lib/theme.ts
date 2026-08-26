// Theme control: absent preference follows the system; a stored choice pins the
// html class. light-dark() in CSS resolves against the class via color-scheme.

import { createSignal } from 'azerothjs';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cm.theme';
const [themeSignal, setThemeSignal] = createSignal<Theme>('dark');
let initialized = false;

function systemTheme(): Theme
{
    try
    {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    catch
    {
        return 'dark';
    }
}

function initFromStorage(): void
{
    if (initialized || typeof window === 'undefined')
    {
        return;
    }
    initialized = true;
    let stored: string | null = null;
    try
    {
        stored = window.localStorage.getItem(STORAGE_KEY);
    }
    catch
    {
        // Storage unavailable - follow the system.
    }
    const theme = stored === 'light' || stored === 'dark' ? stored : systemTheme();
    setThemeSignal(theme);
    if (stored === 'light' || stored === 'dark')
    {
        document.documentElement.classList.add(theme);
    }
}

export function currentTheme(): Theme
{
    initFromStorage();
    return themeSignal();
}

export function toggleTheme(): void
{
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    setThemeSignal(next);
    try
    {
        window.localStorage.setItem(STORAGE_KEY, next);
    }
    catch
    {
        // Preference lives for the session only.
    }
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(next);
}
