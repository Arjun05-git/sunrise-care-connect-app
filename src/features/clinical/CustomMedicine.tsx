import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { checkCustomMedicine, type CustomCheck, type RxItem } from './api';

type Status = 'idle' | 'checking' | 'ok' | 'catalogue' | 'disabled' | 'invalid' | 'failed';

/**
 * "Add a medicine that is not in the list". The server decides (check_custom_medicine): a name that matches a catalogue
 * medicine is refused so the prescribing rules cannot be bypassed by retyping it; anything else needs the doctor's own
 * acknowledgement, because no rule check is possible. Dosing is filled in on the prescription line afterwards.
 * In `direct` mode (the demo) none of that happens: the medicine is added exactly as typed.
 */
export function CustomMedicineDialog({ appointmentId, open, direct = false, onOpenChange, onAdd, onUseCatalogue }: {
  appointmentId: string;
  open: boolean;
  direct?: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (item: RxItem) => void;
  /** the doctor chose to use the catalogue entry instead: search for this name */
  onUseCatalogue: (term: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [generic, setGeneric] = useState('');
  const [strength, setStrength] = useState('');
  const [form, setForm] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<CustomCheck | null>(null);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (open) return;
    setName(''); setGeneric(''); setStrength(''); setForm(''); setStatus('idle'); setResult(null); setAck(false);
  }, [open]);

  // any edit invalidates an earlier check
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setStatus('idle'); setResult(null); setAck(false); };

  const check = async () => {
    setStatus('checking');
    try {
      const res = await checkCustomMedicine(appointmentId, name.trim(), generic.trim());
      setResult(res);
      setStatus(res.ok ? 'ok' : res.code === 'use_catalogue_entry' ? 'catalogue' : res.code === 'custom_disabled' ? 'disabled' : 'invalid');
    } catch {
      setStatus('failed');
    }
  };

  const add = () => {
    onAdd({ drug_id: null, is_custom: true, custom_acknowledged: true, drug_name: name.trim(), generic_name: generic.trim(), strength: strength.trim(), form: form.trim(),
      dose: '', frequency: '', duration: '', route: '', instructions: '' });
    onOpenChange(false);
  };

  const useCatalogue = () => {
    if (result?.match) onUseCatalogue(result.match.name);
    onOpenChange(false);
  };

  const canAdd = direct ? name.trim().length >= 2 : status === 'ok' && ack;
  const problem = status === 'disabled' ? t('clinical.rx.custom.disabled') : status === 'invalid' ? t('clinical.rx.custom.invalid') : status === 'failed' ? t('clinical.rx.custom.checkFailed') : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('clinical.rx.custom.title')}</DialogTitle>
          <DialogDescription>{t('clinical.rx.custom.intro')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="cm-name">{t('clinical.rx.custom.name')}</Label>
            <Input id="cm-name" value={name} maxLength={80} autoComplete="off" onChange={(e) => edit(setName)(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cm-generic">{t('clinical.rx.custom.generic')}</Label>
            <Input id="cm-generic" value={generic} maxLength={120} autoComplete="off" onChange={(e) => edit(setGeneric)(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cm-strength">{t('clinical.rx.custom.strength')}</Label>
              <Input id="cm-strength" value={strength} maxLength={40} onChange={(e) => edit(setStrength)(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cm-form">{t('clinical.rx.custom.form')}</Label>
              <Input id="cm-form" value={form} maxLength={40} onChange={(e) => edit(setForm)(e.target.value)} />
            </div>
          </div>
        </div>

        {direct && <p className="text-xs text-muted-foreground">{t('clinical.rx.custom.badgeHint')}</p>}

        {!direct && status === 'catalogue' && result?.match && (
          <div role="alert" className="space-y-2 rounded-xl border border-warning/50 bg-warning-soft p-3 text-sm">
            <p className="flex gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />{t('clinical.rx.custom.inCatalogue', { name: result.match.name })}</p>
            <Button size="sm" variant="outline" onClick={useCatalogue}>{t('clinical.rx.custom.searchFor', { name: result.match.name })}</Button>
          </div>
        )}
        {!direct && problem && <p role="alert" className="flex gap-2 rounded-xl bg-destructive-soft p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{problem}</p>}

        {!direct && status === 'ok' && result && (
          <div className="space-y-3 rounded-xl border p-3 text-sm">
            <p role="note" className="flex gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />{t('clinical.rx.custom.notChecked')}</p>
            {result.warnings.map((w, i) => (
              <p key={i} className="flex gap-2 font-medium"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />{t('clinical.rx.custom.allergy', { allergy: w.allergy })}</p>
            ))}
            <div className="flex items-start gap-2">
              <Checkbox id="cm-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
              <Label htmlFor="cm-ack" className="leading-snug">{t('clinical.rx.custom.ack')}</Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          {direct || status === 'ok'
            ? <Button disabled={!canAdd} onClick={add}>{t('clinical.rx.custom.add')}</Button>
            : <Button disabled={name.trim().length < 2 || status === 'checking'} onClick={() => void check()}>{status === 'checking' ? t('clinical.rx.custom.checking') : t('clinical.rx.custom.check')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
