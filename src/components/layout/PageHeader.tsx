import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/**
 * Page title row. Titles and subtitles wrap (up to two lines) instead of being cut off on small phones,
 * and the actions move under the title when there isn't room beside it.
 */
export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: boolean | string; actions?: ReactNode }) {
  const nav = useNavigate();
  const { t } = useTranslation();
  return (
    <header className="mb-5 flex flex-wrap items-start gap-x-2 gap-y-3">
      <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-2">
        {back && (
          <Button variant="ghost" size="icon" className="-ml-2 shrink-0 rounded-full" onClick={() => (typeof back === 'string' ? nav(back) : nav(-1))} aria-label={t('common.back')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="min-w-0 flex-1 pt-1">
          <h1 className="line-clamp-2 break-words text-2xl font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">{actions}</div>}
    </header>
  );
}
