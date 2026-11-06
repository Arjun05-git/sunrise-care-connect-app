import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Ban, CheckCircle2, Download, Eye, FilePlus2, Loader2, Lock, PenLine, Pill, Plus, Search, ShieldAlert, Trash2, X } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  catalogueIds, checkDrugs, clk, discardDraft, useCustomMedicineMode, downloadRxPdf, finalizeRx, hasUnacknowledgedCustom, rxPdfFile, saveRxDraft, searchDrugs, startAddendum, useNotes, useRx, useSigningStatus,
  type DrugCategory, type DrugHit, type Reason, type Rx, type RxFields, type RxItem, type Verdict, type Warning,
} from './api';
import { CustomMedicineDialog } from './CustomMedicine';
import { DiagnosisPicker, diagLabel, useDebounced } from './notes';

// ---------------------------------------------------------------- rule texts (the reason the server enforces)
export function reasonText(t: TFunction, r: Reason): string {
  if (r.code === 'list') {
    const ctx = { mode: t(`patient.mode.${r.mode}`).toLocaleLowerCase(), type: t(r.consult_type === 'first' ? 'clinical.rx.first' : 'clinical.rx.followUp') };
    return t(`clinical.reason.list_${r.category}`, { ...ctx, defaultValue: t('clinical.reason.list_other', ctx) });
  }
  if (r.code === 'schedule') return t(r.schedule === 'X' ? 'clinical.reason.schedule_x' : 'clinical.reason.narcotic');
  return t(`clinical.reason.${r.code}`);
}
export function warningText(t: TFunction, w: Warning): string {
  if (w.code === 'interaction') return t(`clinical.interaction.${w.key}`, { with: w.with, defaultValue: t('clinical.interaction.other', { with: w.with }) });
  if (w.code === 'allergy') return t('clinical.warn.allergy', { allergy: w.allergy });
  return t('clinical.warn.duplicate');
}
export function CategoryBadge({ category }: { category: DrugCategory }) {
  const { t } = useTranslation();
  return (
    <Badge variant={category === 'prohibited' ? 'destructive' : category === 'B' ? 'warning' : category === 'A' ? 'neutral' : 'outline'} className="shrink-0 text-[10px]" title={t(`clinical.list.${category}Hint`)}>
      {t(`clinical.list.${category}`)}
    </Badge>
  );
}

const FREQ = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'OD at night', 'Once weekly'];
const DUR = ['3 days', '5 days', '7 days', '10 days', '14 days', '1 month', '3 months'];

// ---------------------------------------------------------------- builder
/**
 * E-prescription for one consultation. Version 1 takes diagnosis / advice / investigations / follow-up
 * from the notes; an addendum edits its own copy. Drafts autosave; blocked drugs can't be added (the
 * server refuses them too); signing needs the PIN and an uploaded signature.
 */
export function RxBuilder({ appointmentId, compact }: { appointmentId: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const rx = useRx(appointmentId);
  const [addendumFor, setAddendumFor] = useState<Rx | null>(null);
  if (rx.isPending) return <Loader2 className="h-5 w-5 animate-spin" aria-label={t('common.loading')} />;
  if (rx.isError) return <p className="text-sm text-destructive">{t('common.error')}</p>;
  const versions = rx.data;
  const draft = versions.find((v) => v.status === 'draft');
  const finals = versions.filter((v) => v.status === 'final');
  const latest = finals.at(-1);

  return (
    <div className="space-y-4" data-ref="rx-builder">
      {(draft || !latest) && <DraftEditor key={draft?.version ?? 1} /* same editor when the first save creates the v1 draft */ appointmentId={appointmentId} draft={draft ?? null} compact={compact} />}
      {latest && !draft && <FinalView rx={latest} onAmend={() => setAddendumFor(latest)} />}
      {finals.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('clinical.rx.versions')}</p>
          <ul className="space-y-1 text-sm">
            {[...finals].reverse().map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                <span className="font-mono text-xs font-semibold">{v.rx_no}</span>
                <span className="text-xs text-muted-foreground">v{v.version} · {v.finalized_at && formatDateTime(v.finalized_at, i18n.language)}</span>
                {v !== latest && <Badge variant="outline" className="text-[10px]">{t('clinical.rx.superseded')}</Badge>}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void downloadRxPdf(v.id).catch(() => toast.error(t('common.error')))} aria-label={t('clinical.rx.downloadVersion', { v: v.version })}><Download aria-hidden />PDF</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AddendumDialog rx={addendumFor} onClose={() => setAddendumFor(null)} appointmentId={appointmentId} />
    </div>
  );
}

type EditItem = RxItem & { key: string; category?: DrugCategory };
const toEdit = (it: RxItem): EditItem => ({ ...it, key: crypto.randomUUID() });

function DraftEditor({ appointmentId, draft, compact }: { appointmentId: string; draft: Rx | null; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isAddendum = !!draft && draft.version > 1;
  const notes = useNotes(appointmentId);
  const [items, setItems] = useState<EditItem[]>(() => [...(draft?.prescription_items ?? [])].sort((a, b) => a.position - b.position).map(toEdit));
  const [fields, setFields] = useState<RxFields>(() => ({ diagnoses: draft?.diagnoses ?? [], advice: draft?.advice ?? '', investigations: draft?.investigations ?? '', follow_up_date: draft?.follow_up_date ?? null }));
  const [state, setState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [signOpen, setSignOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'preview' | 'discard'>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const customMode = useCustomMedicineMode();
  const [seed, setSeed] = useState<{ term: string; n: number } | null>(null);
  const ids = useMemo(() => catalogueIds(items), [items]);
  const verdicts = useQuery({ queryKey: ['clinical', 'check', appointmentId, ids.join(',')], queryFn: () => checkDrugs(appointmentId, ids), placeholderData: keepPreviousData });
  const latest = useRef({ items, fields });
  latest.current = { items, fields };
  const dirty = useRef(false);

  const save = async () => {
    if (!dirty.current) return true;
    dirty.current = false;
    setState('saving');
    try {
      await saveRxDraft(appointmentId, latest.current.items, isAddendum ? latest.current.fields : undefined);
      setState('saved');
      if (!draft) await qc.invalidateQueries({ queryKey: clk.rx(appointmentId) });
      return true;
    } catch (e) {
      dirty.current = true;
      setState('error');
      const code = (e as { message?: string }).message;
      toast.error(i18nError(t, code));
      if (code === 'use_addendum') void qc.invalidateQueries({ queryKey: clk.rx(appointmentId) });
      return false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (state !== 'dirty') return;
    const id = setTimeout(() => void saveRef.current(), 1200);
    return () => clearTimeout(id);
  }, [items, fields, state]);
  useEffect(() => () => void saveRef.current(), []);

  const touch = () => { dirty.current = true; setState('dirty'); };
  const update = (key: string, patch: Partial<EditItem>) => { setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x))); touch(); };
  const add = (h: DrugHit) => {
    if (items.length >= 20) return void toast.error(t('clinical.rx.max'));
    setItems((xs) => [...xs, { key: crypto.randomUUID(), drug_id: h.drug_id, drug_name: h.name, strength: h.strength, form: h.form, category: h.category,
      dose: h.default_dose === '—' ? '' : h.default_dose, frequency: h.default_frequency === '—' ? '' : h.default_frequency, duration: '', route: h.default_route, instructions: '' }]);
    touch();
  };
  // a medicine that is not in the catalogue: the dialog has already had it checked by the server and acknowledged by the doctor
  const addCustom = (item: RxItem) => {
    if (items.length >= 20) return void toast.error(t('clinical.rx.max'));
    setItems((xs) => [...xs, { ...item, key: crypto.randomUUID() }]);
    touch();
  };
  const byDrug = new Map<string, Verdict>((verdicts.data ?? []).map((v) => [v.drug_id, v]));
  const blocked = items.some((i) => !!i.drug_id && byDrug.get(i.drug_id)?.blocked);
  const hasUnack = hasUnacknowledgedCustom(items);

  const dx = isAddendum ? fields.diagnoses : notes.data?.diagnoses ?? [];
  const preview = async () => {
    setBusy('preview');
    try {
      if (!(await save())) return;
      const latestRx = draft ?? (qc.getQueryData<Rx[]>(clk.rx(appointmentId)) ?? []).find((v) => v.status === 'draft');
      if (!latestRx) return void toast.error(t('clinical.rx.addFirst'));
      openFile(await rxPdfFile(latestRx.id));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    if (!draft) return;
    setBusy('discard');
    try {
      dirty.current = false;
      await discardDraft(draft.id);
      await qc.invalidateQueries({ queryKey: clk.rx(appointmentId) });
      toast.success(t('clinical.rx.discarded'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {isAddendum ? t('clinical.rx.addendumTitle', { v: draft!.version }) : t('clinical.rx.draftTitle')}
          <Badge variant="outline" className="ml-2 align-middle text-[10px]">{t('clinical.rx.draft')}</Badge>
        </p>
        <span role="status" aria-live="polite" className={cn('text-xs', state === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-ref="rx-state">
          {state === 'saving' || state === 'dirty' ? t('common.saving') : state === 'saved' ? t('common.saved') : state === 'error' ? t('consult.notes.failed') : ''}
        </span>
      </div>
      {isAddendum && <p className="rounded-lg bg-highlight-soft/60 p-2 text-sm">{t('clinical.rx.addendumReason', { reason: draft!.addendum_reason })}</p>}

      <DrugSearch appointmentId={appointmentId} current={ids} onAdd={add} seed={seed} onCustom={() => setCustomOpen(true)} />

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground"><Pill className="mx-auto mb-1 h-5 w-5" aria-hidden />{t('clinical.rx.empty')}</p>
      ) : (
        <ol className="space-y-2">
          {items.map((it, n) => {
            const v = it.drug_id ? byDrug.get(it.drug_id) : undefined;
            return (
              <li key={it.key} className={cn('rounded-xl border p-3', v?.blocked && 'border-destructive bg-destructive-soft/40')} data-ref="rx-item">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 text-sm font-semibold text-muted-foreground">{n + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{it.drug_name} <span className="font-normal text-muted-foreground">{it.strength} · {it.form}</span></p>
                    {v && <div className="mt-1 flex flex-wrap gap-1"><CategoryBadge category={v.category} /></div>}
                    {it.is_custom && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" data-ref="rx-custom">
                        <Badge variant="warning" title={t('clinical.rx.custom.badgeHint')}>{t('clinical.rx.custom.badge')}</Badge>
                        {it.generic_name && <span className="text-xs text-muted-foreground">{it.generic_name}</span>}
                        {it.custom_acknowledged
                          ? <span className="text-xs text-muted-foreground">{t('clinical.rx.custom.checkedByYou')}</span>
                          : <label className="flex items-center gap-1.5 text-xs font-medium text-destructive"><Checkbox checked={false} onCheckedChange={(c) => c === true && update(it.key, { custom_acknowledged: true })} />{t('clinical.rx.custom.ack')}</label>}
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => { setItems((xs) => xs.filter((x) => x.key !== it.key)); touch(); }} aria-label={t('clinical.rx.remove', { name: it.drug_name })}><X className="h-4 w-4" /></Button>
                </div>
                {v?.reasons.map((r, i) => <p key={i} className="mt-2 flex gap-1.5 text-sm font-medium text-destructive"><Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{reasonText(t, r)}</p>)}
                {v?.warnings.map((w, i) => <p key={i} className="mt-2 flex gap-1.5 text-sm" data-ref="rx-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />{warningText(t, w)}</p>)}
                <div className={cn('mt-2 grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4')}>
                  <Small label={t('clinical.rx.dose')} value={it.dose} max={60} onChange={(dose) => update(it.key, { dose })} />
                  <Small label={t('clinical.rx.frequency')} value={it.frequency} max={60} list="rx-freq" onChange={(frequency) => update(it.key, { frequency })} />
                  <Small label={t('clinical.rx.duration')} value={it.duration} max={40} list="rx-dur" onChange={(duration) => update(it.key, { duration })} />
                  <Small label={t('clinical.rx.route')} value={it.route} max={30} onChange={(route) => update(it.key, { route })} />
                </div>
                <Small className="mt-2" label={t('clinical.rx.instructions')} value={it.instructions} max={200} placeholder={t('clinical.rx.instructionsPh')} onChange={(instructions) => update(it.key, { instructions })} />
              </li>
            );
          })}
        </ol>
      )}
      <datalist id="rx-freq">{FREQ.map((f) => <option key={f} value={f} />)}</datalist>
      <datalist id="rx-dur">{DUR.map((f) => <option key={f} value={f} />)}</datalist>

      {isAddendum ? (
        <div className="space-y-3 rounded-xl border p-3">
          <p className="text-sm font-semibold">{t('clinical.rx.addendumFields')}</p>
          <div className="space-y-1"><Label htmlFor="adx">{t('clinical.dx.label')}</Label><DiagnosisPicker id="adx" value={fields.diagnoses} onChange={(diagnoses) => { setFields((f) => ({ ...f, diagnoses })); touch(); }} /></div>
          <div className="space-y-1"><Label htmlFor="ainv">{t('consult.notes.investigations')}</Label><Textarea id="ainv" rows={2} maxLength={2000} value={fields.investigations} onChange={(e) => { setFields((f) => ({ ...f, investigations: e.target.value })); touch(); }} /></div>
          <div className="space-y-1"><Label htmlFor="aadv">{t('consult.notes.advice')}</Label><Textarea id="aadv" rows={3} maxLength={4000} value={fields.advice} onChange={(e) => { setFields((f) => ({ ...f, advice: e.target.value })); touch(); }} /></div>
          <div className="space-y-1"><Label htmlFor="afu">{t('consult.notes.follow_up_date')}</Label><Input id="afu" type="date" className="max-w-[12rem]" value={fields.follow_up_date ?? ''} onChange={(e) => { setFields((f) => ({ ...f, follow_up_date: e.target.value || null })); touch(); }} /></div>
        </div>
      ) : (
        <div className="rounded-xl bg-muted/50 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('clinical.rx.fromNotes')}</p>
          <p className="mt-1">{dx.length ? dx.map(diagLabel).join('; ') : <span className="text-destructive">{t('clinical.dx.required')}</span>}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save().then((ok) => ok && setSignOpen(true))} disabled={blocked || hasUnack || (items.length === 0 && !draft)} data-ref="rx-sign"><PenLine aria-hidden />{t('clinical.rx.signFinalise')}</Button>
        <Button variant="outline" loading={busy === 'preview'} onClick={() => void preview()}><Eye aria-hidden />{t('clinical.rx.preview')}</Button>
        {isAddendum && <Button variant="ghost" className="text-destructive" loading={busy === 'discard'} onClick={() => void discard()}><Trash2 aria-hidden />{t('clinical.rx.discard')}</Button>}
      </div>
      {blocked && <p className="text-sm text-destructive">{t('clinical.rx.removeBlocked')}</p>}
      {hasUnack && <p className="text-sm text-destructive">{t('clinical.rx.custom.needAck')}</p>}
      <CustomMedicineDialog appointmentId={appointmentId} open={customOpen} direct={customMode.data === 'direct'} onOpenChange={setCustomOpen} onAdd={addCustom} onUseCatalogue={(term) => setSeed({ term, n: Date.now() })} />
      <SignDialog open={signOpen} onOpenChange={setSignOpen} appointmentId={appointmentId} draftId={draft?.id ?? null} diagnosisOk={dx.length > 0} />
    </div>
  );
}

function Small({ label, value, onChange, max, list, placeholder, className }: { label: string; value: string; onChange: (v: string) => void; max: number; list?: string; placeholder?: string; className?: string }) {
  return (
    <label className={cn('block text-xs', className)}>
      <span className="text-muted-foreground">{label}</span>
      <Input className="mt-0.5 h-9 text-sm" value={value} maxLength={max} list={list} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function DrugSearch({ appointmentId, current, onAdd, seed, onCustom }: { appointmentId: string; current: string[]; onAdd: (h: DrugHit) => void; seed: { term: string; n: number } | null; onCustom: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  useEffect(() => { if (seed) setQ(seed.term); }, [seed]);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ['clinical', 'drugs', appointmentId, dq, current.join(',')], enabled: dq.length >= 2, queryFn: () => searchDrugs(appointmentId, dq, current), placeholderData: keepPreviousData });
  return (
    <div className="space-y-1">
      <Label htmlFor={`drug-${appointmentId}`}>{t('clinical.rx.addMedicine')}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id={`drug-${appointmentId}`} className="pl-9" placeholder={t('clinical.rx.searchPh')} value={q} autoComplete="off" onChange={(e) => setQ(e.target.value)} data-ref="drug-search" />
      </div>
      {dq.length >= 2 && (
        <ul className="max-h-80 space-y-1 overflow-y-auto rounded-xl border p-1" aria-label={t('clinical.rx.results')} data-ref="drug-results">
          {res.isFetching && !res.data && <li className="p-2"><Loader2 className="h-4 w-4 animate-spin" /></li>}
          {res.data?.length === 0 && <li className="p-2 text-sm text-muted-foreground">{t('clinical.rx.noResults')}</li>}
          {res.data?.map((h) => (
            <li key={h.drug_id} className={cn('rounded-lg p-2', h.blocked ? 'bg-destructive-soft/40' : 'hover:bg-accent')} data-ref="drug-hit">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{h.name} <span className="font-normal text-muted-foreground">{h.strength} · {h.form}</span></p>
                  <p className="truncate text-xs text-muted-foreground">{h.generic_name}</p>
                </div>
                <CategoryBadge category={h.category} />
                <Button size="sm" variant={h.blocked ? 'ghost' : 'outline'} disabled={h.blocked} onClick={() => { onAdd(h); setQ(''); }} aria-label={t('clinical.rx.addName', { name: h.name })}>
                  {h.blocked ? <Ban aria-hidden /> : <Plus aria-hidden />}{h.blocked ? t('clinical.rx.blocked') : t('clinical.rx.add')}
                </Button>
              </div>
              {h.reasons.map((r, i) => <p key={i} className="mt-1 flex gap-1.5 text-xs font-medium text-destructive" data-ref="block-reason"><ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />{reasonText(t, r)}</p>)}
              {!h.blocked && h.warnings.map((w, i) => <p key={i} className="mt-1 flex gap-1.5 text-xs"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />{warningText(t, w)}</p>)}
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="link" size="sm" className="h-auto min-h-0 px-0 py-1" onClick={onCustom} data-ref="add-custom">{t('clinical.rx.custom.link')}</Button>
    </div>
  );
}

// ---------------------------------------------------------------- sign + finalise
function SignDialog({ open, onOpenChange, appointmentId, draftId, diagnosisOk }: { open: boolean; onOpenChange: (o: boolean) => void; appointmentId: string; draftId: string | null; diagnosisOk: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const sign = useSigningStatus();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rxId = draftId ?? (qc.getQueryData<Rx[]>(clk.rx(appointmentId)) ?? []).find((v) => v.status === 'draft')?.id ?? null;
  const ready = !!sign.data?.pin_set && !!sign.data?.signature_updated_at && diagnosisOk && !!rxId;

  useEffect(() => { if (open) { setPin(''); setErr(null); void sign.refetch(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    if (!rxId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await finalizeRx(rxId, pin);
      if (!r.ok) {
        setErr(r.error === 'pin_wrong' ? t('clinical.sign.pinWrong', { count: r.attempts_left ?? 0 })
          : r.error === 'pin_locked' ? t('clinical.sign.pinLocked', { time: r.locked_until ? formatDateTime(r.locked_until, i18n.language) : '' }) : t('clinical.sign.pinNotSet'));
        setPin('');
        return;
      }
      toast.success(t('clinical.sign.done', { no: r.rx_no }));
      onOpenChange(false);
      await Promise.all([qc.invalidateQueries({ queryKey: clk.rx(appointmentId) }), qc.invalidateQueries({ queryKey: clk.notes(appointmentId) })]);
      void rxPdfFile(r.id).catch(() => undefined); // render + store the signed PDF now
    } catch (e) {
      setErr(i18nError(t, (e as { message?: string }).message));
    } finally {
      setBusy(false);
    }
  };

  const Check = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
    <li className="flex items-start gap-2 text-sm">{ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />}<span>{children}</span></li>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('clinical.sign.title')}</DialogTitle><DialogDescription>{t('clinical.sign.body')}</DialogDescription></DialogHeader>
        {sign.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          <ul className="space-y-1.5">
            <Check ok={diagnosisOk}>{t('clinical.sign.checkDx')}</Check>
            <Check ok={!!sign.data?.signature_updated_at}>{sign.data?.signature_updated_at ? t('clinical.sign.checkSig') : <>{t('clinical.sign.noSig')} <Link to="/d/profile/signature" target="_blank" className="font-medium text-primary underline">{t('clinical.sign.setup')}</Link></>}</Check>
            <Check ok={!!sign.data?.pin_set}>{sign.data?.pin_set ? t('clinical.sign.checkPin') : <>{t('clinical.sign.noPin')} <Link to="/d/profile/signature" target="_blank" className="font-medium text-primary underline">{t('clinical.sign.setup')}</Link></>}</Check>
          </ul>
        )}
        <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (ready && pin.length >= 4) void go(); }}>
          <Label htmlFor="sign-pin">{t('clinical.sign.pin')}</Label>
          <Input id="sign-pin" type="password" inputMode="numeric" autoComplete="one-time-code" pattern="\d*" maxLength={6} value={pin} disabled={!ready}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="max-w-[10rem] font-mono tracking-widest" />
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <p className="text-xs text-muted-foreground">{t('clinical.sign.lockHint')}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!ready || pin.length < 4} loading={busy} data-ref="sign-confirm"><Lock aria-hidden />{t('clinical.sign.confirm')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FinalView({ rx, onAmend }: { rx: Rx; onAmend: () => void }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 rounded-xl border border-success/40 bg-success-soft/30 p-3" data-ref="rx-final">
      <div className="flex flex-wrap items-center gap-2">
        <Lock className="h-4 w-4 text-success" aria-hidden />
        <p className="font-semibold">{t('clinical.rx.signed')}</p>
        <span className="font-mono text-sm" data-ref="rx-no">{rx.rx_no}</span>
        <span className="text-xs text-muted-foreground">{rx.finalized_at && formatDateTime(rx.finalized_at, i18n.language)}</span>
      </div>
      <p className="text-sm">{rx.diagnoses.map(diagLabel).join('; ')}</p>
      <ul className="space-y-0.5 text-sm">
        {[...rx.prescription_items].sort((a, b) => a.position - b.position).map((it) => (
          <li key={it.position}>• <b>{it.drug_name}</b> {it.strength} – {[it.dose, it.frequency, it.duration].filter(Boolean).join(', ')}{it.instructions && ` (${it.instructions})`}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void downloadRxPdf(rx.id).catch(() => toast.error(t('common.error')))} data-ref="rx-download"><Download aria-hidden />{t('clinical.rx.download')}</Button>
        <Button size="sm" variant="outline" loading={busy} onClick={() => { setBusy(true); void rxPdfFile(rx.id).then(openFile).catch(() => toast.error(t('common.error'))).finally(() => setBusy(false)); }}><Eye aria-hidden />{t('clinical.rx.open')}</Button>
        <Button size="sm" variant="ghost" onClick={onAmend} data-ref="rx-amend"><FilePlus2 aria-hidden />{t('clinical.rx.amend')}</Button>
      </div>
    </div>
  );
}

function AddendumDialog({ rx, onClose, appointmentId }: { rx: Rx | null; onClose: () => void; appointmentId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!rx) return;
    setBusy(true);
    try {
      await startAddendum(rx.id, reason.trim());
      await qc.invalidateQueries({ queryKey: clk.rx(appointmentId) });
      setReason('');
      onClose();
    } catch (e) {
      toast.error(i18nError(t, (e as { message?: string }).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!rx} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('clinical.rx.amendTitle')}</DialogTitle><DialogDescription>{t('clinical.rx.amendBody', { no: rx?.rx_no })}</DialogDescription></DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="amend-reason">{t('clinical.rx.amendReason')}</Label>
          <Textarea id="amend-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={reason.trim().length < 5} loading={busy} onClick={() => void go()} data-ref="amend-start">{t('clinical.rx.amendStart')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function i18nError(t: TFunction, code: string | undefined) {
  return t(`clinical.err.${code ?? ''}`, { defaultValue: t('common.error') });
}

/** Opens a file in a new tab (never in place – leaving a call page would end the call). */
export function openFile(f: File) {
  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener noreferrer' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
