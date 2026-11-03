import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

// All user-facing text lives in locales/*.json; `npm run i18n:check` keeps en and ml in sync.
// English ships with the app (it is also the fallback); Malayalam (~40 KB gzipped) loads only when chosen.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  ml: () => import('./locales/ml.json'),
};

/** Loads the language's strings if needed, then switches to it. */
export async function loadLanguage(lng: string) {
  if (!i18n.hasResourceBundle(lng, 'translation') && loaders[lng]) {
    i18n.addResourceBundle(lng, 'translation', (await loaders[lng]!()).default);
  }
  if (i18n.language !== lng) await i18n.changeLanguage(lng);
}

export default i18n;
