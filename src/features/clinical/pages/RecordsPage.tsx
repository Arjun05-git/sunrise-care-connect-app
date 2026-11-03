import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText } from 'lucide-react';
import { formatDate } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ListSkeleton, ErrorState } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { groupVersions, useMyPrescriptions } from '../api';
import { diagLabel } from '../notes';

/** Patient: prescriptions for the whole family (latest version of each). */
export function RecordsPage() {
  const { t, i18n } = useTranslation();
  const rx = useMyPrescriptions();
  const groups = groupVersions(rx.data ?? []);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t('nav.records')} subtitle={t('clinical.records.subtitle')} />
      {rx.isPending ? <ListSkeleton rows={3} /> : rx.isError ? <ErrorState onRetry={() => void rx.refetch()} /> : groups.length === 0 ? (
        <Card><EmptyState art="folder" title={t('clinical.records.empty')} body={t('clinical.records.emptyBody')} /></Card>
      ) : (
        <ul className="space-y-3">
          {groups.map(([latest]) => {
            const r = latest!;
            const dept = r.doctors?.departments;
            return (
              <li key={r.id}>
                <Link to={`/p/records/${r.id}`} className="flex gap-3 rounded-2xl border bg-card p-4 shadow-soft hover:bg-accent" data-ref="rx-card">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft"><FileText className="h-5 w-5 text-primary" aria-hidden /></span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">{r.doctors?.full_name}</span>
                    <span className="block truncate text-muted-foreground">{dept ? `${i18n.language === 'ml' ? dept.name_ml : dept.name} · ` : ''}{t('patient.forName', { name: r.patients?.full_name })}</span>
                    <span className="mt-1 block truncate">{r.diagnoses.map(diagLabel).join('; ')}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="font-mono text-[10px]">{r.rx_no}</Badge>
                      {r.finalized_at && <span className="text-xs text-muted-foreground">{formatDate(r.finalized_at, i18n.language)}</span>}
                      {r.version > 1 && <Badge variant="highlight" className="text-[10px]">{t('clinical.records.updated')}</Badge>}
                    </span>
                  </span>
                  <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
