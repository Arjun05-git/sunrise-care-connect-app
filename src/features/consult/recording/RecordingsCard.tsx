import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic } from 'lucide-react';
import { formatTime } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { playRecording, useRecordingState } from './api';

const mmss = (s: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** The doctor's recordings of one consultation. Playing asks the server for a short-lived link (each play is audited). */
export function RecordingsCard({ appointmentId }: { appointmentId: string }) {
  const { t, i18n } = useTranslation();
  const rows = (useRecordingState(appointmentId).data?.recordings ?? []).filter((r) => r.status === 'ready');
  const [src, setSrc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!rows.length) return null;

  const play = async (id: string) => {
    setBusy(id); setFailed(null);
    try { setSrc((s) => ({ ...s, [id]: '' })); const r = await playRecording(id); setSrc((s) => ({ ...s, [id]: r.url })); }
    catch { setFailed(id); setSrc((s) => { const { [id]: _drop, ...rest } = s; return rest; }); }
    finally { setBusy(null); }
  };

  return (
    <Card data-ref="recordings">
      <CardHeader><CardTitle className="flex items-center gap-2"><Mic className="h-4 w-4 text-primary" aria-hidden />{t('consult.rec.cardTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.map((r) => (
          <div key={r.id} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span>{formatTime(r.started_at, i18n.language)} · {mmss(r.duration_seconds)}</span>
              {!src[r.id] && <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void play(r.id)}>{t('consult.rec.play')}</Button>}
            </div>
            {src[r.id] && <audio controls autoPlay src={src[r.id]} className="w-full" />}
            {failed === r.id && <p className="text-xs text-destructive" role="alert">{t('consult.rec.playFailed')}</p>}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t('consult.rec.auditNote')}</p>
      </CardContent>
    </Card>
  );
}
