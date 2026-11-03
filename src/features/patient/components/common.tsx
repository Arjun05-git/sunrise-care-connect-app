import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/feedback/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';

export const initials = (name: string) =>
  name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export function PersonAvatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  return (
    <Avatar className={className}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

export { inr as rupees } from '@/lib/format';

/** Demo mode has no database: patient features explain how to start one. */
export function BackendRequired({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t(titleKey)} />
      <EmptyState art="construction" title={t('patient.backend.title')} body={t('patient.backend.body')} action={<code className="inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm"><Database className="h-4 w-4" aria-hidden />npm run stack:up</code>} />
    </>
  );
}

/** Step indicator for the booking flow. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const { t } = useTranslation();
  const labels = [t('patient.steps.slot'), t('patient.steps.details'), t('patient.steps.review')];
  return (
    <ol className="mb-4 flex gap-2" aria-label={t('patient.steps.label', { current, total: 3 })}>
      {labels.map((l, i) => (
        <li key={l} className="flex-1" aria-current={i + 1 === current ? 'step' : undefined}>
          <div className={cn('h-1.5 rounded-full', i + 1 <= current ? 'bg-primary' : 'bg-muted')} />
          <span className={cn('mt-1 block text-xs', i + 1 === current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{l}</span>
        </li>
      ))}
    </ol>
  );
}

export function QueryError({ onRetry, message }: { onRetry?: () => void; message?: ReactNode }) {
  return <ErrorState message={typeof message === 'string' ? message : undefined} onRetry={onRetry} />;
}

/** Translate a stable RPC error code (slot_taken, consent_required, …) with a generic fallback. */
export function useRpcErrorText() {
  const { t, i18n } = useTranslation();
  return (code: string) => (i18n.exists(`patient.err.${code}`) ? t(`patient.err.${code}`) : t('common.error'));
}

/** Action bar pinned above the phone tab bar (bottom of the screen on md+, where there is no tab bar). */
export function StickyBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-[calc(56px+max(env(safe-area-inset-bottom),0.25rem))] z-30 border-t bg-card/95 shadow-lift backdrop-blur md:bottom-0">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">{children}</div>
    </div>
  );
}
