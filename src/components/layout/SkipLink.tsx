import { useTranslation } from 'react-i18next';

export function SkipLink() {
  const { t } = useTranslation();
  return (
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
      {t('common.skip')}
    </a>
  );
}
