import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Download, Eye, FlaskConical, Info, Share2 } from 'lucide-react';
import { formatDate, formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { downloadRxPdf, groupVersions, rxPdfFile, useMyPrescriptions } from '../api';
import { diagLabel } from '../notes';
import { openFile } from '../rx';

/** Patient: one prescription – what to take, advice, follow-up – with PDF download and share. */
export function PrescriptionPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const rx = useMyPrescriptions();
  const [busy, setBusy] = useState<null | 'download' | 'open' | 'share'>(null);
  if (rx.isPending) return <><PageHeader back="/p/records" title={t('clinical.records.rx')} /><CardSkeleton /></>;
  const group = groupVersions(rx.data ?? []).find((g) => g.some((v) => v.id === id));
  const r = group?.find((v) => v.id === id);
  if (!group || !r) return <><PageHeader back="/p/records" title={t('clinical.records.rx')} /><EmptyState art="search" title={t('clinical.records.notFound')} /></>;
  const latest = group[0]!;
  const items = [...r.prescription_items].sort((a, b) => a.position - b.position);

  const run = async (kind: 'download' | 'open' | 'share') => {
    setBusy(kind);
    try {
      if (kind === 'download') await downloadRxPdf(r.id);
      else {
        const file = await rxPdfFile(r.id);
        if (kind === 'open') openFile(file);
        else if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: file.name }).catch((e: Error) => { if (e.name !== 'AbortError') throw e; });
        } else {
          openFile(file);
          toast.info(t('clinical.records.shareFallback'));
        }
      }
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader back="/p/records" title={r.doctors?.full_name ?? t('clinical.records.rx')} subtitle={`${t('patient.forName', { name: r.patients?.full_name })} · ${r.finalized_at ? formatDateTime(r.finalized_at, lang) : ''}`} />
      {r.id !== latest.id && (
        <Link to={`/p/records/${latest.id}`} className="flex items-center gap-2 rounded-xl border border-warning/50 bg-warning-soft p-3 text-sm font-medium" data-ref="newer-version">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />{t('clinical.records.newer', { no: latest.rx_no })}
        </Link>
      )}
      {r.version > 1 && <p className="flex gap-2 rounded-xl bg-highlight-soft/60 p-3 text-sm"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('clinical.records.addendum', { reason: r.addendum_reason })}</p>}

      <Card>
        <CardContent className="space-y-1 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono" data-ref="rx-no">{r.rx_no}</Badge>
            {r.version > 1 && <Badge variant="highlight">{t('clinical.records.version', { v: r.version })}</Badge>}
          </div>
          <p className="text-sm">{r.diagnoses.map(diagLabel).join('; ')}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button loading={busy === 'download'} onClick={() => void run('download')} data-ref="rx-download"><Download aria-hidden />{t('clinical.rx.download')}</Button>
            <Button variant="outline" loading={busy === 'share'} onClick={() => void run('share')} data-ref="rx-share"><Share2 aria-hidden />{t('clinical.records.share')}</Button>
            <Button variant="ghost" loading={busy === 'open'} onClick={() => void run('open')}><Eye aria-hidden />{t('clinical.rx.open')}</Button>
          </div>
          <p className="pt-1 text-xs text-muted-foreground">{t('clinical.records.shareHint')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('clinical.records.medicines')}</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('clinical.records.noMedicines')}</p> : (
            <ol className="space-y-3">
              {items.map((it, i) => (
                <li key={i} className="rounded-xl border p-3 text-sm">
                  <p className="font-semibold">{it.drug_name} <span className="font-normal text-muted-foreground">{it.strength} · {it.form}</span></p>
                  <dl className="mt-1 grid grid-cols-3 gap-2">
                    <div><dt className="text-xs text-muted-foreground">{t('clinical.rx.dose')}</dt><dd>{it.dose || '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('clinical.rx.frequency')}</dt><dd>{it.frequency || '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t('clinical.rx.duration')}</dt><dd>{it.duration || '—'}</dd></div>
                  </dl>
                  {it.instructions && <p className="mt-1 text-muted-foreground">{it.instructions}</p>}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      {(r.advice || r.investigations || r.follow_up_date) && (
        <Card>
          <CardContent className="space-y-3 p-4 text-sm">
            {r.advice && <div><p className="font-semibold">{t('consult.notes.advice')}</p><p className="whitespace-pre-line">{r.advice}</p></div>}
            {r.investigations && <div><p className="flex items-center gap-1.5 font-semibold"><FlaskConical className="h-4 w-4" aria-hidden />{t('consult.notes.investigations')}</p><p className="whitespace-pre-line">{r.investigations}</p></div>}
            {r.follow_up_date && <p className="flex items-center gap-1.5"><CalendarClock className="h-4 w-4 text-primary" aria-hidden /><b>{t('consult.notes.follow_up_date')}:</b> {formatDate(`${r.follow_up_date}T12:00:00+05:30`, lang)}</p>}
          </CardContent>
        </Card>
      )}
      {group.length > 1 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('clinical.rx.versions')}</p>
          {group.map((v) => (
            <Link key={v.id} to={`/p/records/${v.id}`} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${v.id === r.id ? 'bg-accent' : ''}`}>
              <span className="font-mono text-xs">{v.rx_no}</span><span className="text-xs text-muted-foreground">v{v.version} · {v.finalized_at && formatDate(v.finalized_at, lang)}</span>
              {v.id === latest.id && <Badge variant="success" className="ml-auto text-[10px]">{t('clinical.records.current')}</Badge>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
