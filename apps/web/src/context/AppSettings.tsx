import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type AppLocale = 'zh-TW' | 'en-US';
export type ColorMode = 'light' | 'dark';

interface AppSettingsValue {
  locale: AppLocale;
  colorMode: ColorMode;
  reducedMotion: boolean;
  setLocale: (locale: AppLocale) => void;
  setColorMode: (mode: ColorMode) => void;
  toggleColorMode: () => void;
  tr: (zh: string, en: string) => string;
}

const AppSettingsContext = createContext<AppSettingsValue | undefined>(undefined);

function readPreference<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function AppSettingsProvider({ children }: PropsWithChildren) {
  const [locale, setLocaleState] = useState<AppLocale>(() => readPreference('swr-locale', 'zh-TW'));
  const [colorMode, setColorModeState] = useState<ColorMode>(() =>
    readPreference(
      'swr-color-mode',
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    ),
  );
  const [reducedMotion, setReducedMotion] = useState(() =>
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mediaQuery) return;

    const updateReducedMotion = () => setReducedMotion(mediaQuery.matches);
    updateReducedMotion();
    mediaQuery.addEventListener('change', updateReducedMotion);
    return () => mediaQuery.removeEventListener('change', updateReducedMotion);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant' : 'en';
    document.documentElement.dataset.theme = colorMode;
  }, [colorMode, locale]);

  const setLocale = (next: AppLocale) => {
    try {
      window.localStorage.setItem('swr-locale', next);
    } catch {
      // Preference persistence may be disabled by the browser; the live UI must still update.
    }
    document.documentElement.lang = next === 'zh-TW' ? 'zh-Hant' : 'en';
    setLocaleState(next);
  };
  const setColorMode = (next: ColorMode) => {
    try {
      window.localStorage.setItem('swr-color-mode', next);
    } catch {
      // Preference persistence may be disabled by the browser; the live UI must still update.
    }
    document.documentElement.dataset.theme = next;
    setColorModeState(next);
  };

  const value = useMemo<AppSettingsValue>(
    () => ({
      locale,
      colorMode,
      reducedMotion,
      setLocale,
      setColorMode,
      toggleColorMode: () => setColorMode(colorMode === 'dark' ? 'light' : 'dark'),
      tr: (zh, en) => (locale === 'zh-TW' ? zh : en),
    }),
    [colorMode, locale, reducedMotion],
  );

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings(): AppSettingsValue {
  const value = useContext(AppSettingsContext);
  if (!value) throw new Error('AppSettingsProvider is missing');
  return value;
}
