import { useTranslation } from 'react-i18next';
import { Activity, ShieldCheck } from 'lucide-react';
import { formatTime } from '@/domain/time';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { useCallSummary } from './api';

const PROVIDER_NAMES: Record<string, string> = { livekit: 'LiveKit', jitsi: 'Jitsi' };
const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Call log for the doctor: who joined when, start / end / duration, quality, reconnects, failures. */
export function CallLogCard({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const s = useCallSummary(id);
  if (s.isPending) return <CardSkeleton />;
  if (!s.data) return null;
  const d = s.data;
  const time = (iso: string | null) => (iso ? formatTime(iso, lang) : '—');
  return (
    <Card data-ref="call-log">
      <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" aria-hidden />{t('consult.log.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.doctorJoined')}</dt><dd className="font-medium">{time(d.doctor_joined_at)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.patientJoined')}</dt><dd className="font-medium">{time(d.patient_joined_at)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.started')}</dt><dd className="font-medium">{time(d.started_at)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.ended')}</dt><dd className="font-medium">{time(d.ended_at)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.duration')}</dt><dd className="font-medium" data-ref="call-duration">{d.duration_seconds != null ? duration(d.duration_seconds) : '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.quality')}</dt>
            <dd className="font-medium">{d.quality?.samples ? `${t(`consult.quality.${d.quality.worst ?? 'unknown'}`)}${d.quality.poor_share ? ` · ${t('consult.log.poorShare', { pct: Math.round(d.quality.poor_share * 100) })}` : ''}` : '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.reconnects')}</dt><dd className="font-medium">{d.reconnects}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('consult.log.provider')}</dt><dd className="font-medium">{d.provider ? PROVIDER_NAMES[d.provider] ?? d.provider : '—'}</dd></div>
        </dl>
        {d.failures.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground">{t('consult.log.failures')}</p>
            <ul className="mt-1 space-y-1">
              {d.failures.map((f, i) => (
                <li key={i} className="rounded-lg bg-warning-soft px-2 py-1 text-xs">
                  {formatTime(f.at, lang)} · {f.who ? t(`consult.role.${f.who}`, { defaultValue: f.who }) : '—'} · {t(`consult.reason.${f.reason ?? 'unknown'}`, { defaultValue: f.reason ?? '—' })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t('consult.notRecorded')}</p>
      </CardContent>
    </Card>
  );
}
