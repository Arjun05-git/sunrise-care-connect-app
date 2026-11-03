import { useTranslation } from 'react-i18next';
import { CategoryBadge } from './rx';

/** What List O / A / B / Prohibited mean (Telemedicine Practice Guidelines 2020). */
export function CategoryLegend() {
  const { t } = useTranslation();
  return (
    <details className="rounded-xl border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('clinical.list.legend')}</summary>
      <ul className="mt-2 space-y-1.5">
        {(['O', 'A', 'B', 'prohibited'] as const).map((c) => <li key={c} className="flex gap-2"><CategoryBadge category={c} /><span>{t(`clinical.list.${c}Hint`)}</span></li>)}
      </ul>
    </details>
  );
}
