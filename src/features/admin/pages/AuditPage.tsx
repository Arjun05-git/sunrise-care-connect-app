import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, FileSpreadsheet, Search } from 'lucide-react';
import { addDaysKey, formatDateTime, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ReadOnlyNote, useAdminError, useHasRole } from '../components';
import { auditPage, useAudit, type AuditFilters, type AuditRow } from '../console-api';
import { downloadText, toCsv } from '../csv';

const ENTITIES = ['appointments', 'doctors', 'user_roles', 'payments', 'refunds', 'fee_config', 'app_settings', 'consents', 'content_versions', 'consultations', 'prescriptions',
  'patients', 'documents', 'support_tickets', 'notification_templates', 'hospitals', 'departments', 'holidays', 'drug_master', 'icd10_master', 'doctor_credentials'];
const PAGE = 50;

/** Audit log (admins): who changed what, when and why. Append-only; clinical free text is redacted in the log itself. */
export function AuditPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const isAdmin = useHasRole('admin');
  const errText = useAdminError();
  const today = istDateKey();
  const [from, setFrom] = useState(addDaysKey(today, -6));
  const [to, setTo] = useState(today);
  const [entity, setEntity] = useState('all');
  const [role, setRole] = useState('all');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [entityId, setEntityId] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { const h = setTimeout(() => { setTerm(q.trim()); setPage(0); }, 300); return () => clearTimeout(h); }, [q]);
  const f: AuditFilters = { from, to: from <= to ? to : from, entity: entity === 'all' ? undefined : entity, actor_role: role === 'all' ? undefined : role, q: term || undefined, entity_id: entityId.trim() || undefined, limit: PAGE, offset: page * PAGE };
  const audit = useAudit(f);
  if (!isAdmin) return <div className="space-y-4"><PageHeader title={t('admin.audit')} /><ReadOnlyNote>{t('adm.audit.adminOnly')}</ReadOnlyNote></div>;
  const rows = audit.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((audit.data?.total ?? 0) / PAGE));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: AuditRow[] = [];
      for (let off = 0; off < 10_000; off += 500) {
        const r = await auditPage({ ...f, limit: 500, offset: off });
        all.push(...r.rows);
        if (r.rows.length < 500) break;
      }
      downloadText(`sunrise-audit_${f.from}_${f.to}.csv`, toCsv(['time_ist', 'actor', 'actor_role', 'action', 'entity', 'entity_id', 'reason', 'before', 'after'],
        all.map((r) => [new Date(r.created_at).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }), r.actor_name ?? r.actor_user_id ?? 'system', r.actor_role, r.action, r.entity, r.entity_id, r.reason, JSON.stringify(r.before ?? {}), JSON.stringify(r.after ?? {})])));
      toast.success(t('adm.rep.exported', { count: all.length }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.audit')} subtitle={t('adm.audit.subtitle')}
        actions={<Button variant="outline" loading={exporting} onClick={() => void exportCsv()}><FileSpreadsheet aria-hidden /><span className="hidden sm:inline">{t('adm.rep.csv')}</span></Button>} />
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="space-y-1.5"><Label htmlFor="a-from">{t('admin.pay.from')}</Label><Input id="a-from" type="date" max={to} value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></div>
        <div className="space-y-1.5"><Label htmlFor="a-to">{t('admin.pay.to')}</Label><Input id="a-to" type="date" max={today} value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></div>
        <div className="space-y-1.5"><Label htmlFor="a-ent">{t('adm.audit.entity')}</Label>
          <Select value={entity} onValueChange={(v) => { setEntity(v); setPage(0); }}><SelectTrigger id="a-ent"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{ENTITIES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="a-role">{t('adm.audit.role')}</Label>
          <Select value={role} onValueChange={(v) => { setRole(v); setPage(0); }}><SelectTrigger id="a-role"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{['admin', 'coordinator', 'finance', 'doctor', 'patient', 'system'].map((r) => <SelectItem key={r} value={r}>{r === 'system' ? t('adm.audit.system') : t(`roles.${r}`)}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="a-id">{t('adm.audit.entityId')}</Label><Input id="a-id" value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(0); }} placeholder="uuid" /></div>
        <div className="space-y-1.5"><Label htmlFor="a-q">{t('adm.audit.reason')}</Label>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="a-q" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      </Card>
      {audit.isPending ? <ListSkeleton rows={6} /> : audit.isError ? <ErrorState onRetry={() => void audit.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="search" title={t('adm.audit.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm" data-ref="audit-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">{['time', 'actor', 'action', 'record', 'reason'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{t(`adm.audit.col.${h}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="cursor-pointer border-b last:border-0 hover:bg-accent" onClick={() => setOpen(r)}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{formatDateTime(r.created_at, lang)}</td>
                <td className="px-3 py-2">{r.actor_name ?? t('adm.audit.system')}{r.actor_role && <Badge variant="outline" className="ml-1">{r.actor_role}</Badge>}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.entity_id ? `${r.entity_id.slice(0, 8)}…` : '—'}</td>
                <td className="max-w-[18rem] truncate px-3 py-2">{r.reason ?? <span className="text-muted-foreground">—</span>}</td>
              </tr>))}</tbody>
          </table>
          <div className="flex items-center justify-between gap-2 p-3 text-sm">
            <span className="text-muted-foreground">{t('adm.audit.total', { count: audit.data?.total ?? 0 })}</span>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t('notify.admin.prev')}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{page + 1}/{pages}</span>
              <Button size="icon" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t('notify.admin.next')}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" closeLabel={t('common.close')} className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <div className="space-y-3" data-ref="audit-detail">
              <SheetTitle className="font-mono text-base">{open.action}</SheetTitle>
              <SheetDescription>{formatDateTime(open.created_at, lang)} · {open.actor_name ?? t('adm.audit.system')} {open.actor_role ? `(${open.actor_role})` : ''}</SheetDescription>
              <p className="text-sm"><span className="text-muted-foreground">{t('adm.audit.col.record')}: </span><span className="font-mono text-xs">{open.entity} · {open.entity_id}</span></p>
              {open.reason && <p className="rounded-xl bg-muted/60 p-3 text-sm">{open.reason}</p>}
              <Diff before={open.before} after={open.after} />
              <p className="text-xs text-muted-foreground">{t('adm.audit.redacted')}</p>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  if (!keys.length) return null;
  return (
    <table className="w-full table-fixed text-xs">
      <thead><tr className="border-b text-left text-muted-foreground"><th className="w-1/4 py-1 font-medium">{t('adm.audit.field')}</th><th className="py-1 font-medium">{t('adm.audit.before')}</th><th className="py-1 font-medium">{t('adm.audit.after')}</th></tr></thead>
      <tbody>{keys.map((k) => (
        <tr key={k} className="border-b align-top last:border-0">
          <td className="break-words py-1 pr-2 font-mono">{k}</td>
          <td className="break-words py-1 pr-2 text-muted-foreground line-through decoration-destructive/50">{show(before?.[k])}</td>
          <td className="break-words py-1">{show(after?.[k])}</td>
        </tr>))}</tbody>
    </table>
  );
}
