import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarX, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { formatDateLong, fromIst, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';
import {
  cqk, deleteHoliday, saveDepartment, saveDrug, saveHoliday, saveHospital, saveIcd, searchDrugs, searchIcd, useMasters,
  type Department, type Drug, type Hospital, type Icd,
} from '../console-api';

/** Masters: hospitals, departments, holidays, drug formulary, ICD-10. Admins edit; every change needs a reason. */
export function MastersPage() {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const m = useMasters();
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.masters')} subtitle={t('adm.mast.subtitle')} />
      {!isAdmin && <ReadOnlyNote>{t('adm.mast.readOnly')}</ReadOnlyNote>}
      <Tabs defaultValue="hospitals">
        <TabsList className="h-auto flex-wrap">
          {['hospitals', 'departments', 'holidays', 'drugs', 'icd'].map((k) => <TabsTrigger key={k} value={k}>{t(`adm.mast.tab.${k}`)}</TabsTrigger>)}
        </TabsList>
        {m.isPending ? <ListSkeleton rows={4} /> : m.isError || !m.data ? <ErrorState onRetry={() => void m.refetch()} /> : (
          <>
            <TabsContent value="hospitals"><Hospitals rows={m.data.hospitals} /></TabsContent>
            <TabsContent value="departments"><Departments rows={m.data.departments} /></TabsContent>
            <TabsContent value="holidays"><Holidays hospitals={m.data.hospitals} /></TabsContent>
            <TabsContent value="drugs"><Drugs /></TabsContent>
            <TabsContent value="icd"><Icds /></TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

/** Edit form in a reason dialog; `valid` gates the confirm button. */
function useEditor<T>(save: (v: T, reason: string) => Promise<unknown>, okKey = 'adm.mast.saved') {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const [draft, setDraft] = useState<{ v: T; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async (reason: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      await save(draft.v, reason);
      toast.success(t(okKey));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['console'] });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { draft, setDraft, busy, confirm, patch: (p: Partial<T>) => draft && setDraft({ ...draft, v: { ...draft.v, ...p } }) };
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{children}</div>;
}
function ListCard({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <Card className="overflow-x-auto">{action && <div className="flex justify-end border-b p-3">{action}</div>}{children}</Card>;
}

// ---------------------------------------------------------------- hospitals
function Hospitals({ rows }: { rows: Hospital[] }) {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const ed = useEditor<Hospital>((v, r) => saveHospital(v.id || null, { name: v.name, city: v.city, address: v.address, phone: v.phone, emergency_phone: v.emergency_phone, his_code: v.his_code, active: v.active }, r));
  const v = ed.draft?.v;
  return (
    <ListCard action={isAdmin && <Button size="sm" onClick={() => ed.setDraft({ isNew: true, v: { id: '', name: '', city: '', address: '', phone: '+91', emergency_phone: '+91', his_code: '', active: true } })}><Plus aria-hidden />{t('adm.mast.addHospital')}</Button>}>
      <table className="w-full min-w-[640px] text-sm">
        <thead><tr className="border-b text-left text-xs text-muted-foreground">{['name', 'city', 'phone', 'emergency', 'status', ''].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h && t(`adm.mast.col.${h}`)}</th>)}</tr></thead>
        <tbody>{rows.map((h) => (
          <tr key={h.id} className="border-b last:border-0">
            <td className="px-4 py-2.5 font-medium">{h.name}</td><td className="px-4 py-2.5">{h.city}</td><td className="px-4 py-2.5 tabular-nums">{h.phone}</td><td className="px-4 py-2.5 tabular-nums">{h.emergency_phone}</td>
            <td className="px-4 py-2.5"><Badge variant={h.active ? 'success' : 'neutral'}>{h.active ? t('adm.mast.active') : t('adm.mast.inactive')}</Badge></td>
            <td className="px-4 py-2.5 text-right">{isAdmin && <Button size="icon" variant="ghost" aria-label={t('adm.mast.edit', { name: h.name })} onClick={() => ed.setDraft({ isNew: false, v: { ...h, address: h.address ?? '', his_code: h.his_code ?? '' } })}><Pencil className="h-4 w-4" /></Button>}</td>
          </tr>))}</tbody>
      </table>
      <ReasonDialog open={!!ed.draft} onOpenChange={(o) => !o && ed.setDraft(null)} title={ed.draft?.isNew ? t('adm.mast.addHospital') : t('adm.mast.editHospital')} confirmLabel={t('common.save')} busy={ed.busy}
        valid={!!v && v.name.trim().length >= 3 && v.city.trim().length >= 2 && /^\+91\d{10}$/.test(v.phone) && /^(\+91\d{10}|1\d{2})$/.test(v.emergency_phone)} onConfirm={(r) => void ed.confirm(r)}>
        {v && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field id="h-name" label={t('adm.mast.col.name')}><Input id="h-name" value={v.name} onChange={(e) => ed.patch({ name: e.target.value })} /></Field>
            <Field id="h-city" label={t('adm.mast.col.city')}><Input id="h-city" value={v.city} onChange={(e) => ed.patch({ city: e.target.value })} /></Field>
            <Field id="h-phone" label={t('adm.mast.col.phone')}><Input id="h-phone" value={v.phone} onChange={(e) => ed.patch({ phone: e.target.value })} /></Field>
            <Field id="h-em" label={t('adm.mast.col.emergency')}><Input id="h-em" value={v.emergency_phone} onChange={(e) => ed.patch({ emergency_phone: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field id="h-addr" label={t('adm.mast.address')}><Input id="h-addr" value={v.address ?? ''} onChange={(e) => ed.patch({ address: e.target.value })} /></Field></div>
            <Field id="h-his" label={t('adm.mast.his')}><Input id="h-his" value={v.his_code ?? ''} onChange={(e) => ed.patch({ his_code: e.target.value })} /></Field>
            <label className="flex items-center justify-between gap-2 self-end text-sm">{t('adm.mast.active')}<Switch checked={v.active} onCheckedChange={(x) => ed.patch({ active: x })} /></label>
            {!v.active && !ed.draft?.isNew && <p className="text-xs text-muted-foreground sm:col-span-2">{t('adm.mast.deactivateHint')}</p>}
          </div>
        )}
      </ReasonDialog>
    </ListCard>
  );
}

// ---------------------------------------------------------------- departments
function Departments({ rows }: { rows: Department[] }) {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const ed = useEditor<Department>((v, r) => saveDepartment(v.id || null, { name: v.name, name_ml: v.name_ml, icon: v.icon, active: v.active }, r));
  const v = ed.draft?.v;
  return (
    <ListCard action={isAdmin && <Button size="sm" onClick={() => ed.setDraft({ isNew: true, v: { id: '', name: '', name_ml: '', icon: 'stethoscope', active: true } })}><Plus aria-hidden />{t('adm.mast.addDepartment')}</Button>}>
      <table className="w-full min-w-[520px] text-sm">
        <thead><tr className="border-b text-left text-xs text-muted-foreground">{['name', 'nameMl', 'status', ''].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h && t(`adm.mast.col.${h}`)}</th>)}</tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.id} className="border-b last:border-0">
            <td className="px-4 py-2.5 font-medium">{x.name}</td><td className="px-4 py-2.5" lang="ml">{x.name_ml}</td>
            <td className="px-4 py-2.5"><Badge variant={x.active ? 'success' : 'neutral'}>{x.active ? t('adm.mast.active') : t('adm.mast.inactive')}</Badge></td>
            <td className="px-4 py-2.5 text-right">{isAdmin && <Button size="icon" variant="ghost" aria-label={t('adm.mast.edit', { name: x.name })} onClick={() => ed.setDraft({ isNew: false, v: x })}><Pencil className="h-4 w-4" /></Button>}</td>
          </tr>))}</tbody>
      </table>
      <ReasonDialog open={!!ed.draft} onOpenChange={(o) => !o && ed.setDraft(null)} title={ed.draft?.isNew ? t('adm.mast.addDepartment') : t('adm.mast.editDepartment')} confirmLabel={t('common.save')} busy={ed.busy}
        valid={!!v && v.name.trim().length >= 2 && v.name_ml.trim().length >= 2 && /^[a-z0-9-]{1,40}$/.test(v.icon)} onConfirm={(r) => void ed.confirm(r)}>
        {v && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field id="dp-name" label={t('adm.mast.col.name')}><Input id="dp-name" value={v.name} onChange={(e) => ed.patch({ name: e.target.value })} /></Field>
            <Field id="dp-ml" label={t('adm.mast.col.nameMl')}><Input id="dp-ml" lang="ml" value={v.name_ml} onChange={(e) => ed.patch({ name_ml: e.target.value })} /></Field>
            <Field id="dp-icon" label={t('adm.mast.icon')}><Input id="dp-icon" value={v.icon} onChange={(e) => ed.patch({ icon: e.target.value.toLowerCase() })} /></Field>
            <label className="flex items-center justify-between gap-2 self-end text-sm">{t('adm.mast.active')}<Switch checked={v.active} onCheckedChange={(x) => ed.patch({ active: x })} /></label>
          </div>
        )}
      </ReasonDialog>
    </ListCard>
  );
}

// ---------------------------------------------------------------- holidays
function Holidays({ hospitals }: { hospitals: Hospital[] }) {
  const { t, i18n } = useTranslation();
  const isAdmin = useHasRole('admin');
  const m = useMasters();
  const qc = useQueryClient();
  const errText = useAdminError();
  const today = istDateKey();
  const [draft, setDraft] = useState<{ hospital: string; date: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = (m.data?.holidays ?? []).filter((h) => h.date >= today);
  const hospName = (id: string | null) => (id ? hospitals.find((h) => h.id === id)?.name ?? '—' : t('adm.mast.allHospitals'));
  const add = async (reason: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await saveHoliday(draft.hospital === 'all' ? null : draft.hospital, draft.date, draft.name, reason);
      toast.success(r.bookings_that_day ? t('adm.mast.holidayBookings', { count: r.bookings_that_day }) : t('adm.mast.saved'));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: cqk.masters });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ListCard action={isAdmin && <Button size="sm" onClick={() => setDraft({ hospital: 'all', date: today, name: '' })}><Plus aria-hidden />{t('adm.mast.addHoliday')}</Button>}>
      <p className="border-b px-4 py-2 text-xs text-muted-foreground">{t('adm.mast.holidayHint')}</p>
      {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('adm.mast.noHolidays')}</p> : (
        <ul className="divide-y">{rows.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <CalendarX className="h-4 w-4 text-muted-foreground" aria-hidden />
            <div className="flex-1"><p className="font-medium">{h.name}</p><p className="text-xs text-muted-foreground">{formatDateLong(fromIst(h.date, '12:00').toISOString(), i18n.language)} · {hospName(h.hospital_id)}</p></div>
            {isAdmin && <Button size="icon" variant="ghost" aria-label={t('adm.mast.removeHoliday', { name: h.name })} onClick={() => setRemoving(h.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
          </li>))}</ul>
      )}
      <ReasonDialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={t('adm.mast.addHoliday')} description={t('adm.mast.holidayHint')} confirmLabel={t('common.save')} busy={busy}
        valid={!!draft && draft.name.trim().length >= 2 && draft.date >= today} onConfirm={(r) => void add(r)}>
        {draft && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field id="ho-date" label={t('adm.mast.date')}><Input id="ho-date" type="date" min={today} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></Field>
            <Field id="ho-h" label={t('adm.mast.hospital')}>
              <Select value={draft.hospital} onValueChange={(x) => setDraft({ ...draft, hospital: x })}><SelectTrigger id="ho-h"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">{t('adm.mast.allHospitals')}</SelectItem>{hospitals.filter((h) => h.active).map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}</SelectContent></Select></Field>
            <div className="sm:col-span-2"><Field id="ho-name" label={t('adm.mast.holidayName')}><Input id="ho-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
          </div>
        )}
      </ReasonDialog>
      <ReasonDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive title={t('adm.mast.removeHolidayTitle')} confirmLabel={t('adm.mast.remove')} busy={busy}
        onConfirm={(r) => { setBusy(true); void deleteHoliday(removing!, r).then(() => { toast.success(t('adm.mast.saved')); setRemoving(null); return qc.invalidateQueries({ queryKey: cqk.masters }); }).catch((e) => toast.error(errText(e))).finally(() => setBusy(false)); }} />
    </ListCard>
  );
}

// ---------------------------------------------------------------- drugs
const BLANK_DRUG: Drug = { id: '', name: '', generic_name: '', form: 'Tablet', strength: '', category: 'O', schedule: 'OTC', interaction_groups: [], allergy_class: null, default_dose: '', default_frequency: '', default_route: 'Oral', active: true };
function Drugs() {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(h); }, [q]);
  const list = useQuery({ queryKey: ['console', 'drugs', term], queryFn: () => searchDrugs(term.replace(/[%,()]/g, '')) });
  const ed = useEditor<Drug>((v, r) => saveDrug(v, r));
  const v = ed.draft?.v;
  return (
    <ListCard action={
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.mast.searchDrug')} aria-label={t('adm.mast.searchDrug')} /></div>
        {isAdmin && <Button size="sm" onClick={() => ed.setDraft({ isNew: true, v: BLANK_DRUG })}><Plus aria-hidden />{t('adm.mast.addDrug')}</Button>}
      </div>}>
      {list.isPending ? <ListSkeleton rows={3} /> : (
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground">{['drug', 'generic', 'list', 'schedule', 'status', ''].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h && t(`adm.mast.col.${h}`)}</th>)}</tr></thead>
          <tbody>{(list.data ?? []).map((x) => (
            <tr key={x.id} className="border-b last:border-0">
              <td className="px-4 py-2.5 font-medium">{x.name} <span className="text-xs text-muted-foreground">{x.form} {x.strength}</span></td>
              <td className="px-4 py-2.5">{x.generic_name}</td>
              <td className="px-4 py-2.5"><Badge variant={x.category === 'prohibited' ? 'destructive' : 'outline'}>{t(`clinical.list.${x.category}`)}</Badge></td>
              <td className="px-4 py-2.5">{x.schedule}</td>
              <td className="px-4 py-2.5"><Badge variant={x.active ? 'success' : 'neutral'}>{x.active ? t('adm.mast.active') : t('adm.mast.inactive')}</Badge></td>
              <td className="px-4 py-2.5 text-right">{isAdmin && <Button size="icon" variant="ghost" aria-label={t('adm.mast.edit', { name: x.name })} onClick={() => ed.setDraft({ isNew: false, v: x })}><Pencil className="h-4 w-4" /></Button>}</td>
            </tr>))}</tbody>
        </table>
      )}
      <ReasonDialog open={!!ed.draft} onOpenChange={(o) => !o && ed.setDraft(null)} title={ed.draft?.isNew ? t('adm.mast.addDrug') : t('adm.mast.editDrug')} confirmLabel={t('common.save')} busy={ed.busy}
        description={t('adm.mast.drugHint')}
        valid={!!v && /^[a-z0-9-]{2,40}$/.test(v.id.toLowerCase()) && v.name.trim().length >= 2 && v.generic_name.trim().length >= 2 && !(v.schedule === 'X' && v.category !== 'prohibited')} onConfirm={(r) => void ed.confirm(r)}>
        {v && (
          <div className="grid max-h-[50vh] gap-3 overflow-y-auto sm:grid-cols-2">
            <Field id="dr-id" label={t('adm.mast.drugId')}><Input id="dr-id" value={v.id} disabled={!ed.draft?.isNew} onChange={(e) => ed.patch({ id: e.target.value.toLowerCase() })} /></Field>
            <Field id="dr-name" label={t('adm.mast.col.drug')}><Input id="dr-name" value={v.name} onChange={(e) => ed.patch({ name: e.target.value })} /></Field>
            <Field id="dr-gen" label={t('adm.mast.col.generic')}><Input id="dr-gen" value={v.generic_name} onChange={(e) => ed.patch({ generic_name: e.target.value })} /></Field>
            <Field id="dr-form" label={t('adm.mast.form')}><Input id="dr-form" value={v.form} onChange={(e) => ed.patch({ form: e.target.value })} /></Field>
            <Field id="dr-str" label={t('adm.mast.strength')}><Input id="dr-str" value={v.strength} onChange={(e) => ed.patch({ strength: e.target.value })} /></Field>
            <Field id="dr-cat" label={t('adm.mast.col.list')}>
              <Select value={v.category} onValueChange={(x) => ed.patch({ category: x as Drug['category'] })}><SelectTrigger id="dr-cat"><SelectValue /></SelectTrigger>
                <SelectContent>{(['O', 'A', 'B', 'prohibited'] as const).map((c) => <SelectItem key={c} value={c}>{t(`clinical.list.${c}`)}</SelectItem>)}</SelectContent></Select></Field>
            <Field id="dr-sch" label={t('adm.mast.col.schedule')}>
              <Select value={v.schedule} onValueChange={(x) => ed.patch({ schedule: x as Drug['schedule'] })}><SelectTrigger id="dr-sch"><SelectValue /></SelectTrigger>
                <SelectContent>{(['OTC', 'G', 'H', 'H1', 'X', 'narcotic'] as const).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></Field>
            <Field id="dr-grp" label={t('adm.mast.groups')}><Input id="dr-grp" value={v.interaction_groups.join(', ')} onChange={(e) => ed.patch({ interaction_groups: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
            <Field id="dr-all" label={t('adm.mast.allergy')}><Input id="dr-all" value={v.allergy_class ?? ''} onChange={(e) => ed.patch({ allergy_class: e.target.value || null })} /></Field>
            <Field id="dr-dose" label={t('adm.mast.dose')}><Input id="dr-dose" value={v.default_dose} onChange={(e) => ed.patch({ default_dose: e.target.value })} /></Field>
            <Field id="dr-freq" label={t('adm.mast.frequency')}><Input id="dr-freq" value={v.default_frequency} onChange={(e) => ed.patch({ default_frequency: e.target.value })} /></Field>
            <label className="flex items-center justify-between gap-2 self-end text-sm">{t('adm.mast.active')}<Switch checked={v.active} onCheckedChange={(x) => ed.patch({ active: x })} /></label>
            {v.schedule === 'X' && v.category !== 'prohibited' && <p role="alert" className="text-xs text-destructive sm:col-span-2">{t('adm.mast.scheduleX')}</p>}
          </div>
        )}
      </ReasonDialog>
    </ListCard>
  );
}

// ---------------------------------------------------------------- ICD-10
function Icds() {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(h); }, [q]);
  const list = useQuery({ queryKey: ['console', 'icd', term], queryFn: () => searchIcd(term.replace(/[%,()]/g, '')) });
  const ed = useEditor<Icd>((v, r) => saveIcd(v.code, v.description, v.active, r));
  const v = ed.draft?.v;
  return (
    <ListCard action={
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.mast.searchIcd')} aria-label={t('adm.mast.searchIcd')} /></div>
        {isAdmin && <Button size="sm" onClick={() => ed.setDraft({ isNew: true, v: { code: '', description: '', active: true } })}><Plus aria-hidden />{t('adm.mast.addIcd')}</Button>}
      </div>}>
      {list.isPending ? <ListSkeleton rows={3} /> : (
        <ul className="divide-y">{(list.data ?? []).map((x) => (
          <li key={x.code} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="w-16 font-mono font-semibold">{x.code}</span><span className="flex-1">{x.description}</span>
            {!x.active && <Badge variant="neutral">{t('adm.mast.inactive')}</Badge>}
            {isAdmin && <Button size="icon" variant="ghost" aria-label={t('adm.mast.edit', { name: x.code })} onClick={() => ed.setDraft({ isNew: false, v: x })}><Pencil className="h-4 w-4" /></Button>}
          </li>))}</ul>
      )}
      <ReasonDialog open={!!ed.draft} onOpenChange={(o) => !o && ed.setDraft(null)} title={ed.draft?.isNew ? t('adm.mast.addIcd') : t('adm.mast.editIcd')} confirmLabel={t('common.save')} busy={ed.busy}
        valid={!!v && /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(v.code.toUpperCase()) && v.description.trim().length >= 3} onConfirm={(r) => void ed.confirm(r)}>
        {v && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[8rem_1fr]">
            <Field id="icd-code" label={t('adm.mast.code')}><Input id="icd-code" value={v.code} disabled={!ed.draft?.isNew} onChange={(e) => ed.patch({ code: e.target.value.toUpperCase() })} /></Field>
            <Field id="icd-desc" label={t('adm.mast.description')}><Input id="icd-desc" value={v.description} onChange={(e) => ed.patch({ description: e.target.value })} /></Field>
            <label className="flex items-center justify-between gap-2 text-sm sm:col-span-2">{t('adm.mast.icdActive')}<Switch checked={v.active} onCheckedChange={(x) => ed.patch({ active: x })} /></label>
          </div>
        )}
      </ReasonDialog>
    </ListCard>
  );
}
