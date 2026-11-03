import { Siren } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Mandatory notice: shown on every patient screen and the login page. */
export function EmergencyNotice({ compact, className }: { compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="note" className={cn('flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive-soft px-3 py-2 text-destructive', compact ? 'text-xs' : 'text-sm', className)}>
      <Siren className={cn('mt-0.5 shrink-0', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden />
      <p>
        {t('emergency.text')}{' '}
        <a href="tel:112" className="font-bold underline underline-offset-2">{t('emergency.call')}</a>
      </p>
    </div>
  );
}
