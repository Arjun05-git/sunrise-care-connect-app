import { useTranslation } from 'react-i18next';
import type { LiveState } from '@/lib/realtime';
import { cn } from '@/lib/utils';

/**
 * Small "Live" indicator for screens that update in real time. While connecting it shows the same word
 * with a grey dot (screen readers hear "Connecting…"), so the badge never changes width and the header
 * never re-wraps; only "offline" changes the text, because then the person needs to act.
 */
export function LiveBadge({ state }: { state: LiveState }) {
  const { t } = useTranslation();
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
      state === 'live' ? 'bg-success-soft text-success' : state === 'offline' ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground')}
      role="status" aria-live="polite" data-live={state}>
      <span className={cn('h-2 w-2 rounded-full', state === 'live' ? 'animate-pulse bg-success' : state === 'offline' ? 'bg-warning' : 'bg-muted-foreground/60')} aria-hidden />
      {state === 'offline' ? t('live.offline') : <><span aria-hidden={state === 'connecting'}>{t('live.live')}</span>{state === 'connecting' && <span className="sr-only">{t('live.connecting')}</span>}</>}
    </span>
  );
}
