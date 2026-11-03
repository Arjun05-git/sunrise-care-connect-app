import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pencil, Search } from 'lucide-react';
import type { ConsultMode, ConsultType } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ListSkeleton, ErrorState } from '@/components/feedback/states';
import { inr } from '@/lib/format';
import { effectiveFee, useDeleteFee, useFeeData, useSaveFee, type DepartmentLite, type DoctorLite, type FeeRow } from '../api';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';

const COLS: { mode: ConsultMode; type: ConsultType }[] = [
  { mode: 'video', type: 'first' }, { mode: 'video', type: 'follow_up' }, { mode: 'audio', type: 'first' }, { mode: 'audio', type: 'follow_up' },
];

type Editing = { scope: 'department'; dept: DepartmentLite; mode: ConsultMode; type: ConsultType; current?: FeeRow } | { scope: 'doctor'; doctor: DoctorLite; mode: ConsultMode; type: ConsultType; current?: FeeRow; inherited: number | null };

/**
 * Fee configuration. Department fees are the defaults; a doctor-specific fee overrides them.
 * Changes apply to new bookings only – a held or booked appointment keeps the fee it was quoted.
 */
export function FeesPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const data = useFeeData();
  const save = useSaveFee();
  const del = useDeleteFee();
  const canEdit = useHasRole('admin', 'finance');
  const errText = useAdminError();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [amount, setAmount] = useState('');
  const [q, setQ] = useState('');
  const [revert, setRevert] = useState(false);

  const deptName = (id: string) => { const d = data.data?.departments.find((x) => x.id === id); return d ? (lang === 'ml' ? d.name_ml : d.name) : ''; };
  const doctors = useMemo(() => (data.data?.doctors ?? []).filter((d) => !q || `${d.full_name} ${deptName(d.department_id)}`.toLowerCase().includes(q.toLowerCase())), [data.data, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (e: Editing) => { setEditing(e); setRevert(false); setAmount(e.current ? String(e.current.amount) : e.scope === 'doctor' && e.inherited != null ? String(e.inherited) : ''); };
  const amountOk = /^\d{1,6}$/.test(amount) && Number(amount) <= 100000;
  const colLabel = (c: (typeof COLS)[number]) => `${t(`patient.mode.${c.mode}`)} · ${t(c.type === 'first' ? 'admin.fee.first' : 'admin.fee.followUp')}`;

  if (data.isPending) return <><PageHeader title={t('admin.fees')} /><ListSkeleton rows={4} /></>;
  if (data.isError) return <><PageHeader title={t('admin.fees')} /><ErrorState onRetry={() => void data.refetch()} /></>;
  const { fees, departments } = data.data;

  const cell = (label: string, value: number | null, badge: ReactNode, onEdit: () => void, aria: string) => (
    <td className="px-3 py-2">
      <div className="flex items-center justify-end gap-1.5">
        <span className={value == null ? 'text-destructive' : 'font-medium tabular-nums'}>{value == null ? t('admin.fee.notSet') : inr(value, lang)}</span>
        {badge}
        {canEdit && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={aria} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>}
      </div>
      <span className="sr-only">{label}</span>
    </td>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.fees')} subtitle={t('admin.fee.subtitle')} />
      {!canEdit && <ReadOnlyNote>{t('admin.readOnly')}</ReadOnlyNote>}

      <Card>
        <CardHeader><CardTitle>{t('admin.fee.deptTitle')}</CardTitle><CardDescription>{t('admin.fee.deptDesc')}</CardDescription></CardHeader>
        <CardContent className="relative overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-5 py-2 font-medium">{t('admin.fee.department')}</th>{COLS.map((c) => <th key={c.mode + c.type} className="px-3 py-2 text-right font-medium">{colLabel(c)}</th>)}</tr></thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <th scope="row" className="px-5 py-2 text-left font-medium">{lang === 'ml' ? d.name_ml : d.name}</th>
                  {COLS.map((c) => {
                    const row = fees.find((f) => f.scope === 'department' && f.department_id === d.id && f.mode === c.mode && f.consult_type === c.type);
                    return <FragmentCell key={c.mode + c.type}>{cell(colLabel(c), row?.amount ?? null, null, () => open({ scope: 'department', dept: d, mode: c.mode, type: c.type, current: row }), t('admin.fee.editFor', { what: `${d.name} – ${colLabel(c)}` }))}</FragmentCell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between sm:space-y-0">
          <div><CardTitle>{t('admin.fee.doctorTitle')}</CardTitle><CardDescription>{t('admin.fee.doctorDesc')}</CardDescription></div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" placeholder={t('admin.fee.searchDoctor')} aria-label={t('admin.fee.searchDoctor')} />
          </div>
        </CardHeader>
        <CardContent className="relative overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-5 py-2 font-medium">{t('admin.fee.doctor')}</th>{COLS.map((c) => <th key={c.mode + c.type} className="px-3 py-2 text-right font-medium">{colLabel(c)}</th>)}</tr></thead>
            <tbody>
              {doctors.map((doc) => (
                <tr key={doc.id} className="border-b last:border-0">
                  <th scope="row" className="px-5 py-2 text-left font-normal">
                    <span className="font-medium">{doc.full_name}</span>
                    <span className="block text-xs text-muted-foreground">{deptName(doc.department_id)}{doc.verification_status !== 'verified' ? ` · ${t('admin.fee.unverified')}` : ''}</span>
                  </th>
                  {COLS.map((c) => {
                    const eff = effectiveFee(fees, doc, c.mode, c.type);
                    const offered = doc.modes.includes(c.mode);
                    const badge = eff.source === 'doctor' ? <Badge variant="default" className="px-1.5 py-0 text-[10px]">{t('admin.fee.own')}</Badge>
                      : eff.source === 'fallback' ? <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">{t('admin.fee.asFirst')}</Badge>
                      : <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{t('admin.fee.dept')}</Badge>;
                    if (!offered) return <td key={c.mode + c.type} className="px-3 py-2 text-right text-xs text-muted-foreground">{t('admin.fee.notOffered')}</td>;
                    const own = eff.source === 'doctor' ? eff.row : undefined;
                    return <FragmentCell key={c.mode + c.type}>{cell(colLabel(c), eff.amount, badge, () => open({ scope: 'doctor', doctor: doc, mode: c.mode, type: c.type, current: own, inherited: own ? effectiveFee(fees.filter((f) => f.id !== own.id), doc, c.mode, c.type).amount : eff.amount }), t('admin.fee.editFor', { what: `${doc.full_name} – ${colLabel(c)}` }))}</FragmentCell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">{t('admin.fee.note')}</p>

      <ReasonDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? t('admin.fee.editTitle', { what: editing.scope === 'doctor' ? editing.doctor.full_name : (lang === 'ml' ? editing.dept.name_ml : editing.dept.name) }) : ''}
        description={editing ? `${colLabel(editing)}${editing.scope === 'doctor' && editing.inherited != null ? ` · ${t('admin.fee.inherits', { fee: inr(editing.inherited, lang) })}` : ''}` : ''}
        confirmLabel={t('common.save')}
        busy={save.isPending || del.isPending}
        valid={revert || amountOk}
        onConfirm={(reason) => {
          if (!editing) return;
          if (revert && editing.current) {
            del.mutate({ id: editing.current.id, reason }, { onSuccess: () => { toast.success(t('admin.fee.reverted')); setEditing(null); }, onError: (e) => toast.error(errText(e)) });
            return;
          }
          save.mutate(
            { scope: editing.scope, doctor_id: editing.scope === 'doctor' ? editing.doctor.id : null, department_id: editing.scope === 'department' ? editing.dept.id : null, mode: editing.mode, consult_type: editing.type, amount: Number(amount), reason },
            { onSuccess: () => { toast.success(t('admin.fee.saved')); setEditing(null); }, onError: (e) => toast.error(errText(e)) },
          );
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="fee-amount">{t('admin.fee.amount')}</Label>
          <div className="flex"><span className="inline-flex items-center rounded-l-xl border border-r-0 bg-muted px-3 text-sm">₹</span>
            <Input id="fee-amount" inputMode="numeric" className="rounded-l-none" disabled={revert} value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} aria-invalid={!amountOk && amount !== ''} /></div>
          {editing?.scope === 'doctor' && editing.current && (
            <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
              {t('admin.fee.revert')}
              <Switch checked={revert} onCheckedChange={setRevert} />
            </label>
          )}
        </div>
      </ReasonDialog>
    </div>
  );
}

const FragmentCell = ({ children }: { children: ReactNode }) => <>{children}</>;
