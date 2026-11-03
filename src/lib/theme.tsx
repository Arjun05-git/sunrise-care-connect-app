import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import i18n, { loadLanguage } from '@/i18n';

/**
 * Per-device display preferences: theme (light / dark / system), text size and language.
 * Stored in localStorage (not health data). Applied to <html>: `.dark` class, `lang`, `--font-scale`.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type Language = 'en' | 'ml';
export interface Prefs {
  theme: ThemeChoice;
  fontScale: number; // 0.9 – 1.3
  language: Language;
}

const KEY = 'scc-prefs';
export const FONT_SCALE = { min: 0.9, max: 1.3, step: 0.1 } as const;
const DEFAULTS: Prefs = { theme: 'light', fontScale: 1, language: 'en' };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

interface Ctx {
  prefs: Prefs;
  resolved: 'light' | 'dark';
  setPrefs: (p: Partial<Prefs>) => void;
}
const ThemeCtx = createContext<Ctx | null>(null);

const systemDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, set] = useState<Prefs>(load);
  const [sysDark, setSysDark] = useState(systemDark);
  const resolved: 'light' | 'dark' = prefs.theme === 'system' ? (sysDark ? 'dark' : 'light') : prefs.theme;

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.setProperty('--font-scale', String(prefs.fontScale));
    root.lang = prefs.language;
    if (i18n.language !== prefs.language) void loadLanguage(prefs.language);
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  }, [prefs, resolved]);

  const setPrefs = useCallback((p: Partial<Prefs>) => set((x) => ({ ...x, ...p })), []);
  const value = useMemo(() => ({ prefs, resolved, setPrefs }), [prefs, resolved, setPrefs]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error('ThemeProvider missing');
  return c;
}
