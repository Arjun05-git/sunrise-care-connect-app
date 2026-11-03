import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showDemoHints } from '@/lib/config';

export function DemoBanner() {
  const { t } = useTranslation();
  if (!showDemoHints) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-highlight-soft px-3 py-1 text-xs font-semibold text-warning">
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{t('demo.banner')}</span>
    </div>
  );
}
