import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookmarkPlus, FileStack, Loader2, Lock, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { Diagnosis } from '@/domain/types';
import { formatTime } from '@/domain/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { clk, deleteTemplate, EMPTY_NOTES, saveNotes, saveTemplate, searchIcd, useNotes, useTemplates, type NoteTemplate, type Notes } from './api';

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export const diagLabel = (d: Diagnosis) => (d.code ? `${d.code} ${d.description}` : d.description);

/**
 * ICD-10 search (code or words, typo-tolerant on the server) with keyboard support; a free-text
 * provisional diagnosis can be added when nothing fits.
 */
export function DiagnosisPicker({ value, onChange, disabled, id }: { value: Diagnosis[]; onChange: (v: Diagnosis[]) => void; disabled?: boolean; id?: string }) {
  const { t } = useTranslation();
  const auto = useId();
  const inputId = id ?? `dx-${auto}`;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 200);
  const res = useQuery({ queryKey: ['icd', dq], enabled: dq.length >= 2, staleTime: 5 * 60_000, queryFn: () => searchIcd(dq) });
  const hits = (res.data ?? []).filter((h) => !value.some((v) => v.code === h.code));
  const free = q.trim().length >= 3 ? [{ code: null, description: q.trim() }] : [];
  const options: Diagnosis[] = [...hits, ...free];
  const add = (d: Diagnosis) => {
    if (value.length >= 10) return void toast.error(t('clinical.dx.max'));
    onChange([...value, d]);
    setQ('');
    setActive(0);
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('clinical.dx.selected')}>
          {value.map((d, i) => (
            <li key={`${d.code ?? 'free'}-${i}`} className="flex max-w-full items-center gap-1 rounded-full border bg-card py-1 pl-2.5 pr-1 text-sm">
              {d.code ? <b className="font-mono text-xs">{d.code}</b> : <Badge variant="outline" className="text-[10px]">{t('clinical.dx.provisional')}</Badge>}
              <span className="truncate">{d.description}</span>
              {!disabled && (
                <button type="button" className="rounded-full p-1 hover:bg-accent" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={t('clinical.dx.remove', { name: diagLabel(d) })}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id={inputId} role="combobox" aria-expanded={open && options.length > 0} aria-controls={`${inputId}-list`} aria-autocomplete="list"
            aria-activedescendant={open && options[active] ? `${inputId}-opt-${active}` : undefined}
            className="pl-9" placeholder={t('clinical.dx.placeholder')} value={q} autoComplete="off"
            onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter' && options[active]) { e.preventDefault(); add(options[active]!); }
              else if (e.key === 'Escape') setOpen(false);
            }} />
          {open && dq.length >= 2 && (
            <ul id={`${inputId}-list`} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border bg-popover p-1 text-sm shadow-lg">
              {res.isFetching && !res.data && <li className="flex items-center gap-2 p-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</li>}
              {options.map((o, i) => (
                <li key={`${o.code ?? 'free'}-${i}`} id={`${inputId}-opt-${i}`} role="option" aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); add(o); }} onMouseEnter={() => setActive(i)}
                  className={cn('flex cursor-pointer gap-2 rounded-lg px-2 py-1.5', i === active && 'bg-accent')}>
                  {o.code ? <><b className="w-14 shrink-0 font-mono text-xs leading-5">{o.code}</b><span>{o.description}</span></>
                    : <span className="text-muted-foreground">{t('clinical.dx.useFree', { text: o.description })}</span>}
                </li>
              ))}
              {!res.isFetching && res.data && options.length === 0 && <li className="p-2 text-muted-foreground">{t('clinical.dx.none')}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- templates
type Body = NoteTemplate['body'];
/** Applying a template fills empty fields and appends to filled ones; diagnoses are merged. */
export function applyTemplate(notes: Notes, body: Body): Notes {
  const merge = (cur: string, add: string) => (!add ? cur : !cur.trim() ? add : cur.includes(add) ? cur : `${cur.trimEnd()}\n${add}`);
  const dx = [...notes.diagnoses];
  for (const d of body.diagnoses ?? []) if (!dx.some((x) => x.code && x.code === d.code)) dx.push(d);
  return {
    ...notes,
    chief_complaint: merge(notes.chief_complaint, body.chief_complaint ?? ''), history: merge(notes.history, body.history ?? ''),
    examination: merge(notes.examination, body.examination ?? ''), advice: merge(notes.advice, body.advice ?? ''),
    investigations: merge(notes.investigations, body.investigations ?? ''), diagnoses: dx.slice(0, 10),
  };
}

function TemplateDialog({ open, onOpenChange, onApply }: { open: boolean; onOpenChange: (o: boolean) => void; onApply: (b: Body) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tpl = useTemplates();
  const [q, setQ] = useState('');
  const list = (tpl.data ?? []).filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase()));
  const mine = list.filter((x) => x.doctor_id);
  const sunrise = list.filter((x) => !x.doctor_id);
  const remove = async (x: NoteTemplate) => {
    try {
      await deleteTemplate(x.id);
      await qc.invalidateQueries({ queryKey: clk.templates });
      toast.success(t('clinical.tpl.deleted'));
    } catch {
      toast.error(t('common.error'));
    }
  };
  const Group = ({ title, items }: { title: string; items: NoteTemplate[] }) =>
    items.length ? (
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        <ul className="space-y-1">
          {items.map((x) => (
            <li key={x.id} className="flex items-center gap-1">
              <button type="button" onClick={() => { onApply(x.body); onOpenChange(false); }} className="min-w-0 flex-1 rounded-lg border p-2.5 text-left hover:bg-accent">
                <span className="block font-medium">{x.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{[x.body.diagnoses?.map((d) => d.code).filter(Boolean).join(', '), x.body.chief_complaint].filter(Boolean).join(' · ')}</span>
              </button>
              {x.doctor_id && <Button variant="ghost" size="icon" onClick={() => void remove(x)} aria-label={t('clinical.tpl.delete', { name: x.name })}><Trash2 className="h-4 w-4" /></Button>}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')} className="max-w-lg">
        <DialogHeader><DialogTitle>{t('clinical.tpl.title')}</DialogTitle><DialogDescription>{t('clinical.tpl.hint')}</DialogDescription></DialogHeader>
        <Input placeholder={t('clinical.tpl.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('clinical.tpl.search')} />
        <div className="max-h-[50dvh] space-y-4 overflow-y-auto">
          {tpl.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : list.length === 0 ? <p className="text-sm text-muted-foreground">{t('clinical.tpl.none')}</p> : (
            <><Group title={t('clinical.tpl.mine')} items={mine} /><Group title={t('clinical.tpl.sunrise')} items={sunrise} /></>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SaveTemplateDialog({ open, onOpenChange, notes }: { open: boolean; onOpenChange: (o: boolean) => void; notes: Notes }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { follow_up_date: _f, ...body } = notes;
      await saveTemplate(name.trim(), body);
      await qc.invalidateQueries({ queryKey: clk.templates });
      toast.success(t('clinical.tpl.saved'));
      onOpenChange(false);
      setName('');
    } catch (e) {
      toast.error((e as { message?: string }).message === 'too_many_templates' ? t('clinical.tpl.tooMany') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('clinical.tpl.saveTitle')}</DialogTitle><DialogDescription>{t('clinical.tpl.saveHint')}</DialogDescription></DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="tpl-name">{t('clinical.tpl.name')}</Label><Input id="tpl-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={name.trim().length < 2} loading={busy} onClick={() => void save()}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- notes editor
const FIELDS: { key: 'chief_complaint' | 'history' | 'examination' | 'investigations' | 'advice'; rows: number; max: number }[] = [
  { key: 'chief_complaint', rows: 2, max: 2000 }, { key: 'history', rows: 3, max: 4000 }, { key: 'examination', rows: 3, max: 4000 },
  { key: 'investigations', rows: 2, max: 2000 }, { key: 'advice', rows: 3, max: 4000 },
];

/**
 * Clinical notes for one consultation: autosaved draft (1.5 s after typing stops and on leaving),
 * ICD-10 diagnoses, templates. Locked once the prescription is signed.
 */
export function NotesEditor({ appointmentId, compact }: { appointmentId: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const notes = useNotes(appointmentId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Notes | null>(null);
  const [state, setState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'apply' | 'save'>(null);
  const latest = useRef<Notes | null>(null);
  const dirty = useRef(false);
  const final = notes.data?.status === 'final';

  useEffect(() => {
    if (notes.data !== undefined && draft === null) {
      const d: Notes = notes.data
        ? { chief_complaint: notes.data.chief_complaint, history: notes.data.history, examination: notes.data.examination, diagnoses: notes.data.diagnoses ?? [],
            advice: notes.data.advice, investigations: notes.data.investigations, follow_up_date: notes.data.follow_up_date }
        : EMPTY_NOTES;
      setDraft(d);
      latest.current = d;
      if (notes.data) setSavedAt(notes.data.updated_at);
    }
  }, [notes.data, draft]);

  const save = async () => {
    if (!dirty.current || !latest.current) return;
    dirty.current = false;
    setState('saving');
    try {
      const at = await saveNotes(appointmentId, latest.current);
      setSavedAt(at);
      setState('saved');
      qc.setQueryData(clk.notes(appointmentId), (old: unknown) => ({ ...(old as object), ...latest.current, status: 'draft', updated_at: at }));
    } catch (e) {
      const code = (e as { message?: string }).message;
      if (code === 'notes_final') {
        void qc.invalidateQueries({ queryKey: clk.notes(appointmentId) });
        setDraft(null);
      }
      dirty.current = code !== 'notes_final';
      setState('error');
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (state !== 'dirty') return;
    const id = setTimeout(() => void saveRef.current(), 1500);
    return () => clearTimeout(id);
  }, [draft, state]);
  useEffect(() => () => void saveRef.current(), []);

  if (!draft) return <Loader2 className="h-5 w-5 animate-spin" aria-label={t('common.loading')} />;
  const set = (patch: Partial<Notes>) => {
    const d = { ...draft, ...patch };
    setDraft(d);
    latest.current = d;
    dirty.current = true;
    setState('dirty');
  };

  return (
    <div className="space-y-3" data-ref="notes-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {final ? <span className="flex items-center gap-1 font-medium"><Lock className="h-3.5 w-3.5" aria-hidden />{t('clinical.notes.locked')}</span> : (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setDlg('apply')} data-ref="apply-template"><FileStack aria-hidden />{t('clinical.tpl.apply')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDlg('save')}><BookmarkPlus aria-hidden />{compact ? t('clinical.tpl.saveShort') : t('clinical.tpl.saveAs')}</Button>
          </div>
        )}
        <span role="status" aria-live="polite" className={cn(state === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-ref="notes-state">
          {state === 'saving' || state === 'dirty' ? t('common.saving') : state === 'error' ? t('consult.notes.failed') : savedAt ? t('consult.notes.savedAt', { time: formatTime(savedAt, i18n.language) }) : t('consult.notes.hint')}
        </span>
      </div>
      {state === 'error' && !final && <Button size="sm" variant="outline" onClick={() => { dirty.current = true; void save(); }}><RefreshCw aria-hidden />{t('common.retry')}</Button>}

      {FIELDS.slice(0, 3).map((f) => <Field key={f.key} f={f} value={draft[f.key]} disabled={final} onChange={(v) => set({ [f.key]: v })} />)}
      <div className="space-y-1">
        <Label htmlFor={`dx-${appointmentId}`}>{t('clinical.dx.label')}</Label>
        <DiagnosisPicker id={`dx-${appointmentId}`} value={draft.diagnoses} onChange={(diagnoses) => set({ diagnoses })} disabled={final} />
        {!final && draft.diagnoses.length === 0 && <p className="text-xs text-muted-foreground">{t('clinical.dx.required')}</p>}
      </div>
      {FIELDS.slice(3).map((f) => <Field key={f.key} f={f} value={draft[f.key]} disabled={final} onChange={(v) => set({ [f.key]: v })} />)}
      <div className="space-y-1">
        <Label htmlFor={`fu-${appointmentId}`}>{t('consult.notes.follow_up_date')}</Label>
        <Input id={`fu-${appointmentId}`} type="date" disabled={final} value={draft.follow_up_date ?? ''} onChange={(e) => set({ follow_up_date: e.target.value || null })} className="max-w-[12rem]" />
      </div>
      <p className="text-xs text-muted-foreground">{t('clinical.notes.sharedHint')}</p>

      <TemplateDialog open={dlg === 'apply'} onOpenChange={(o) => !o && setDlg(null)} onApply={(b) => { set(applyTemplate(draft, b)); toast.success(t('clinical.tpl.applied')); }} />
      <SaveTemplateDialog open={dlg === 'save'} onOpenChange={(o) => !o && setDlg(null)} notes={draft} />
    </div>
  );
}

function Field({ f, value, disabled, onChange }: { f: (typeof FIELDS)[number]; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t(`consult.notes.${f.key}`)}</Label>
      <Textarea id={id} rows={f.rows} maxLength={f.max} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} data-ref={`note-${f.key}`} />
    </div>
  );
}
