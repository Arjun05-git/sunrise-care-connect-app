import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';
import { SystemStatusCard } from '../SystemStatusCard';
import { retryIntegration, setIntegrations, useIntegrationEvents, useIntegrationStats, type IntegrationSystem } from '@/features/integrations/api';

const SYSTEMS: IntegrationSystem[] = ['his', 'leadsquared', 'abdm'];
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = { queued: 'outline', sending: 'outline', sent: 'success', failed: 'destructive', skipped: 'neutral' };

/** Admin → Integrations: switches, what was sent where, failures to retry. Payloads are never shown (they hold patient data). */
export function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const isAdmin = useHasRole('admin');
  const qc = useQueryClient();
  const errText = useAdminError();
  const stats = useIntegrationStats();
  const [system, setSystem] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const events = useIntegrationEvents({ system: system === 'all' ? undefined : system, status: status === 'all' ? undefined : status, page });
  const [draft, setDraft] = useState<Record<IntegrationSystem, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPage(0); }, [system, status]);
  if (!isAdmin) return <div className="space-y-4"><PageHeader title={t('admin.integrations')} /><ReadOnlyNote>{t('intg.adminOnly')}</ReadOnlyNote></div>;
  const flags = stats.data?.flags;
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations'] });
  const rows = events.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));
  const sync = stats.data?.doctor_sync;

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.integrations')} subtitle={t('intg.subtitle')} />
      <SystemStatusCard />
      {stats.isPending ? <ListSkeleton rows={2} /> : stats.isError || !flags ? <ErrorState onRetry={() => void stats.refetch()} /> : (
        <div className="grid gap-3 md:grid-cols-3" data-ref="integration-cards">
          {SYSTEMS.map((s) => {
            const c = stats.data!.by_system[s];
            return (
              <Card key={s}>
                <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                  <div><CardTitle className="text-base">{t(`intg.sys.${s}`)}</CardTitle><CardDescription>{t(`intg.desc.${s}`)}</CardDescription></div>
                  <Switch checked={flags[s]} aria-label={t('intg.toggle', { name: t(`intg.sys.${s}`) })} data-ref={`flag-${s}`}
                    onCheckedChange={(v) => setDraft({ ...flags, [s]: v })} />
                </CardHeader>
                <CardContent className="text-sm">
                  <p className="text-muted-foreground">{flags[s] ? t('intg.on') : t('intg.off')}</p>
                  {s !== 'abdm' && (
                    <p className="mt-1 tabular-nums">{t('intg.counts', { sent: c?.sent ?? 0, queued: c?.queued ?? 0, failed: c?.failed ?? 0, skipped: c?.skipped ?? 0 })}</p>
                  )}
                  {c?.last_sent_at && <p className="text-xs text-muted-foreground">{t('intg.lastSent', { at: formatDateTime(c.last_sent_at, lang) })}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {sync && (
        <Card data-ref="doctor-sync">
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('intg.doctorSync')}</CardTitle>
            <CardDescription>{t('intg.doctorSyncHint')}</CardDescription></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{t('intg.syncLine', { at: formatDateTime(sync.at, lang), rows: sync.rows, matched: sync.matched, linked: sync.linked })}</p>
            {sync.unmatched.length > 0 && <p className="text-muted-foreground">{t('intg.unmatched', { list: sync.unmatched.join(', ') })}</p>}
            {sync.conflicts.length > 0 && <p className="text-destructive">{t('intg.conflicts', { list: sync.conflicts.map((c) => c.his_doctor_code).join(', ') })}</p>}
          </CardContent>
        </Card>
      )}

      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="i-sys">{t('intg.system')}</Label>
          <Select value={system} onValueChange={setSystem}><SelectTrigger id="i-sys"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{(['his', 'leadsquared'] as const).map((s) => <SelectItem key={s} value={s}>{t(`intg.sys.${s}`)}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="i-st">{t('intg.status')}</Label>
          <Select value={status} onValueChange={setStatus}><SelectTrigger id="i-st"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{['queued', 'sent', 'failed', 'skipped'].map((s) => <SelectItem key={s} value={s}>{t(`intg.st.${s}`)}</SelectItem>)}</SelectContent></Select></div>
      </Card>
      {events.isPending ? <ListSkeleton rows={4} /> : events.isError ? <ErrorState onRetry={() => void events.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="search" title={t('intg.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm" data-ref="integration-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">{['time', 'system', 'kind', 'status', 'attempts', 'ref', ''].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h && t(`intg.col.${h}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0" data-ref="integration-row">
                <td className="whitespace-nowrap px-3 py-2 text-xs">{formatDateTime(r.created_at, lang)}</td>
                <td className="px-3 py-2">{t(`intg.sys.${r.system}`)}</td>
                <td className="px-3 py-2">{t(`intg.kind.${r.kind}`)}{r.event && <span className="text-muted-foreground"> · {t(`intg.ev.${r.event}`)}</span>}</td>
                <td className="px-3 py-2"><Badge variant={STATUS_VARIANT[r.status]}>{t(`intg.st.${r.status}`)}</Badge>
                  {r.last_error && <span className="block text-xs text-muted-foreground">{i18n.exists(`intg.err.${r.last_error.split(':')[0]}`) ? t(`intg.err.${r.last_error.split(':')[0]}`) : r.last_error}</span>}</td>
                <td className="px-3 py-2 tabular-nums">{r.attempts}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.external_ref ?? '—'}</td>
                <td className="px-3 py-2 text-right">{r.status === 'failed' && (
                  <Button size="sm" variant="ghost" onClick={() => void retryIntegration(r.id).then(() => { toast.success(t('intg.retried')); return refresh(); }).catch((e) => toast.error(errText(e)))}>
                    <RotateCw aria-hidden />{t('intg.retry')}</Button>)}</td>
              </tr>))}</tbody>
          </table>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 p-3 text-sm">
              <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t('notify.admin.prev')}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{page + 1}/{pages}</span>
              <Button size="icon" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t('notify.admin.next')}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
        </Card>
      )}
      <p className="text-xs text-muted-foreground">{t('intg.privacy')}</p>

      <ReasonDialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={t('intg.flagsTitle')} description={draft?.abdm && !flags?.abdm ? t('intg.abdmWarn') : undefined}
        confirmLabel={t('common.save')} busy={busy}
        onConfirm={(reason) => {
          if (!draft) return;
          setBusy(true);
          void setIntegrations(draft.his, draft.leadsquared, draft.abdm, reason)
            .then(() => { toast.success(t('intg.saved')); setDraft(null); return Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['abdm'] })]); })
            .catch((e) => toast.error(errText(e))).finally(() => setBusy(false));
        }}>
        {draft && <ul className="space-y-1 text-sm">{SYSTEMS.map((s) => <li key={s}>{t(`intg.sys.${s}`)}: <strong>{draft[s] ? t('intg.on') : t('intg.off')}</strong></li>)}</ul>}
      </ReasonDialog>
    </div>
  );
}
