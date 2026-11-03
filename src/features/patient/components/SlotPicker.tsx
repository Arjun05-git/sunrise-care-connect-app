import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import { Moon, Sun, Sunrise } from 'lucide-react';
import type { Slot } from '@/domain/types';
import { formatDate, formatDayNum, formatMonthShort, formatTime, formatWeekdayShort, istDateKey } from '@/domain/time';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { cn } from '@/lib/utils';
import { dayStrip, groupByDayPart, isBookable, type DayPart } from '../slots';
import { QueryError } from './common';

const PART_ICON: Record<DayPart, typeof Sun> = { morning: Sunrise, afternoon: Sun, evening: Moon };

/**
 * 14-day IST date strip + morning / afternoon / evening slot grid. Taken slots are shown struck
 * through; a selected slot that someone else takes meanwhile (refetch / realtime) is deselected.
 */
export function SlotPicker({ slots, value, onChange, exclude }: { slots: UseQueryResult<Slot[]>; value?: string; onChange: (id: string | undefined) => void; exclude?: string[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [day, setDay] = useState<string | undefined>();
  const data = useMemo(() => slots.data?.filter((s) => !exclude?.includes(s.id)), [slots.data, exclude]);
  const strip = useMemo(() => (data ? dayStrip(data) : []), [data]);
  useEffect(() => {
    if (!day && strip.length) setDay(strip.find((d) => d.available > 0)?.key ?? strip[0]!.key);
  }, [strip, day]);
  const groups = useMemo(() => (data && day ? groupByDayPart(data, day) : null), [data, day]);
  const selected = data?.find((s) => s.id === value);
  useEffect(() => {
    if (selected && !isBookable(selected)) onChange(undefined);
  }, [selected, onChange]);

  if (slots.isPending) return <Skeleton className="h-20 w-full" />;
  if (slots.isError) return <QueryError onRetry={() => void slots.refetch()} />;
  return (
    <>
      <div role="listbox" aria-label={t('patient.book.date')} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
        {strip.map((b) => (
          <button key={b.key} role="option" aria-selected={day === b.key} disabled={b.available === 0} onClick={() => { setDay(b.key); onChange(undefined); }}
            aria-label={`${formatDate(`${b.key}T12:00:00+05:30`, lang)} – ${t('patient.book.slotsLeft', { count: b.available })}`}
            className={cn('flex w-16 shrink-0 flex-col items-center rounded-2xl border py-2 transition-colors disabled:opacity-40',
              day === b.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent')}>
            <span className="text-xs">{b.key === istDateKey() ? t('patient.today') : formatWeekdayShort(b.key, lang)}</span>
            <span className="text-lg font-bold leading-tight">{formatDayNum(b.key)}</span>
            <span className="text-[11px]">{formatMonthShort(b.key, lang)}</span>
          </button>
        ))}
      </div>
      {groups && (Object.keys(groups) as DayPart[]).every((p) => groups[p].length === 0) ? (
        <EmptyState className="py-6" art="calendar" title={t('patient.book.noSlotsDay')} />
      ) : groups && (
        <div className="mt-3 space-y-4">
          {(Object.keys(groups) as DayPart[]).filter((p) => groups[p].length).map((p) => {
            const Icon = PART_ICON[p];
            return (
              <div key={p}>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><Icon className="h-4 w-4" aria-hidden />{t(`patient.book.${p}`)}</h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                  {groups[p].map((s) => {
                    const ok = isBookable(s);
                    return (
                      <button key={s.id} type="button" disabled={!ok} aria-pressed={value === s.id} onClick={() => onChange(s.id)}
                        aria-label={`${formatTime(s.start_at, lang)}${ok ? '' : ` – ${t('patient.book.unavailable')}`}`}
                        className={cn('min-h-11 rounded-xl border text-sm font-medium transition-colors',
                          value === s.id ? 'border-primary bg-primary text-primary-foreground' : ok ? 'bg-card hover:border-primary/50 hover:bg-primary-soft/40' : 'cursor-not-allowed bg-muted text-muted-foreground line-through')}>
                        {formatTime(s.start_at, lang)}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t('patient.book.istNote')}</p>
    </>
  );
}
