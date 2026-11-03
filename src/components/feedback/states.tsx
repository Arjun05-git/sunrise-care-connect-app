import { useEffect, useState } from 'react';
import { CloudOff, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Skeleton for list rows (avatar + text lines). */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn('space-y-3', className)} role="status" aria-live="polite">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-lg border border-border/70 bg-card p-4 shadow-soft">
          <Skeleton className="h-14 w-14 rounded-2xl" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a content card (title, body, action). */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-3 rounded-lg border border-border/70 bg-card p-5 shadow-soft', className)} aria-hidden>
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="mt-2 h-11 w-full rounded-xl" />
    </div>
  );
}

/**
 * Something couldn't be loaded. Says what happened in plain words, suggests the likely fix (the
 * connection, which is almost always the cause on a phone) and offers one action. `message` replaces
 * the suggestion when a screen knows better.
 */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const Icon = offline ? WifiOff : CloudOff;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border bg-card px-6 py-8 text-center shadow-soft">
      <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-muted"><Icon className="h-6 w-6 text-muted-foreground" aria-hidden /></span>
      <p className="font-semibold">{t(offline ? 'common.offlineTitle' : 'common.loadErrorTitle')}</p>
      <p className="max-w-xs text-sm text-muted-foreground">{message ?? t(offline ? 'common.offlineBody' : 'common.loadErrorBody')}</p>
      {onRetry && <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

/**
 * Session restore at start-up: the same branded shell index.html paints before JavaScript arrives.
 * If it takes unusually long (a weak signal, or the service is down) it says so after 8 s and offers
 * a retry, instead of spinning forever.
 */
export function BootLoader() {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(id); }, []);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center" role="status">
      <Logo className="flex-col gap-3 text-center [&_svg]:h-14 [&_svg]:w-14" />
      <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary motion-reduce:[animation-duration:3s]" aria-hidden />
      <span className="sr-only">{t('common.loading')}</span>
      {slow && (
        <div className="max-w-xs space-y-3" data-ref="boot-slow">
          <p className="text-sm text-muted-foreground">{t('common.slowBody')}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>{t('common.retry')}</Button>
        </div>
      )}
    </div>
  );
}

export function FullPageLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60dvh] items-center justify-center" role="status">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary-soft border-t-primary" aria-hidden />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}
