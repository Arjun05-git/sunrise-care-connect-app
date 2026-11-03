import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eraser, KeyRound, PenLine, Upload } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clk, fetchSignature, setSigningPin, uploadSignature, useSigningStatus } from '../api';

const pinText = (t: (k: string, o?: Record<string, unknown>) => string, r: { error?: string; attempts_left?: number }) =>
  r.error === 'pin_wrong' ? t('clinical.sign.pinWrong', { count: r.attempts_left ?? 0 }) : r.error === 'pin_locked' ? t('clinical.sign.pinLockedShort') : t(`clinical.err.${r.error}`, { defaultValue: t('common.error') });

/** Doctor: draw or upload the signature printed on prescriptions, and set / change the signing PIN. */
export function SignaturePage() {
  const { t, i18n } = useTranslation();
  const status = useSigningStatus();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader back="/d/profile" title={t('clinical.sig.title')} subtitle={t('clinical.sig.subtitle')} />
      {status.data?.locked_until && <p role="alert" className="rounded-xl bg-destructive-soft p-3 text-sm text-destructive">{t('clinical.sign.pinLocked', { time: formatDateTime(status.data.locked_until, i18n.language) })}</p>}
      <PinCard pinSet={!!status.data?.pin_set} />
      <SignatureCard pinSet={!!status.data?.pin_set} updatedAt={status.data?.signature_updated_at ?? null} />
    </div>
  );
}

function PinCard({ pinSet }: { pinSet: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4,6}$/.test(next) && next === again && (!pinSet || cur.length >= 4);
  const save = async () => {
    setBusy(true);
    try {
      const r = await setSigningPin(pinSet ? cur : null, next);
      if (!r.ok) return void toast.error(pinText(t, r));
      toast.success(t('clinical.sig.pinSaved'));
      setCur(''); setNext(''); setAgain('');
      await qc.invalidateQueries({ queryKey: clk.signing });
    } catch (e) {
      toast.error(t(`clinical.err.${(e as { message?: string }).message}`, { defaultValue: t('common.error') }));
    } finally {
      setBusy(false);
    }
  };
  const pinInput = (id: string, label: string, v: string, set: (s: string) => void) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={v} onChange={(e) => set(e.target.value.replace(/\D/g, ''))} className="max-w-[10rem] font-mono tracking-widest" />
    </div>
  );
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" aria-hidden />{t(pinSet ? 'clinical.sig.changePin' : 'clinical.sig.setPin')}</CardTitle></CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) void save(); }}>
          <p className="text-sm text-muted-foreground">{t('clinical.sig.pinHint')}</p>
          {pinSet && pinInput('pin-cur', t('clinical.sig.currentPin'), cur, setCur)}
          <div className="flex flex-wrap gap-3">
            {pinInput('pin-new', t('clinical.sig.newPin'), next, setNext)}
            {pinInput('pin-again', t('clinical.sig.repeatPin'), again, setAgain)}
          </div>
          {again && next !== again && <p className="text-sm text-destructive">{t('clinical.sig.mismatch')}</p>}
          <Button type="submit" disabled={!valid} loading={busy}>{t('common.save')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SignatureCard({ pinSet, updatedAt }: { pinSet: boolean; updatedAt: string | null }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [drawn, setDrawn] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [upload, setUpload] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    if (updatedAt) void fetchSignature().then((u) => { url = u; setCurrent(u); });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [updatedAt]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
  }, []);

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const clear = () => {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
    setUpload(null);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.type !== 'image/png' || f.size > 200 * 1024) return void toast.error(t('clinical.err.signature_invalid'));
    const r = new FileReader();
    r.onload = () => setUpload(String(r.result));
    r.readAsDataURL(f);
  };
  const save = async () => {
    const png = upload ?? (drawn ? canvas.current!.toDataURL('image/png') : null);
    if (!png) return;
    setBusy(true);
    try {
      const r = await uploadSignature(png, pin);
      if (!r.ok) return void toast.error(pinText(t, r));
      toast.success(t('clinical.sig.saved'));
      setPin('');
      clear();
      await qc.invalidateQueries({ queryKey: clk.signing });
    } catch (e) {
      toast.error(t(`clinical.err.${(e as { code?: string }).code}`, { defaultValue: t('common.error') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><PenLine className="h-5 w-5 text-primary" aria-hidden />{t('clinical.sig.signature')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {current ? (
          <div>
            <p className="text-xs text-muted-foreground">{t('clinical.sig.current', { time: updatedAt ? formatDateTime(updatedAt, i18n.language) : '' })}</p>
            <img src={current} alt={t('clinical.sig.currentAlt')} className="mt-1 h-16 rounded-lg border bg-white p-1" />
          </div>
        ) : <p className="text-sm text-muted-foreground">{t('clinical.sig.none')}</p>}
        <p className="text-sm">{t('clinical.sig.drawHint')}</p>
        {upload ? <img src={upload} alt={t('clinical.sig.uploadAlt')} className="h-36 w-full rounded-xl border bg-white object-contain" /> : (
          <canvas ref={canvas} className="h-36 w-full touch-none rounded-xl border bg-white" aria-label={t('clinical.sig.pad')} data-ref="sig-pad"
            onPointerDown={(e) => { drawing.current = true; const [x, y] = pos(e); const c = canvas.current!.getContext('2d')!; c.beginPath(); c.moveTo(x, y); canvas.current!.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if (!drawing.current) return; const [x, y] = pos(e); const c = canvas.current!.getContext('2d')!; c.lineTo(x, y); c.stroke(); setDrawn(true); }}
            onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={clear}><Eraser aria-hidden />{t('clinical.sig.clear')}</Button>
          <Button size="sm" variant="outline" asChild>
            <label className="cursor-pointer"><Upload aria-hidden />{t('clinical.sig.upload')}<input type="file" accept="image/png" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} /></label>
          </Button>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="space-y-1">
            <Label htmlFor="sig-pin">{t('clinical.sign.pin')}</Label>
            <Input id="sig-pin" type="password" inputMode="numeric" maxLength={6} value={pin} disabled={!pinSet} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="max-w-[10rem] font-mono tracking-widest" />
          </div>
          <Button type="submit" disabled={!pinSet || pin.length < 4 || (!drawn && !upload)} loading={busy} data-ref="sig-save">{t('clinical.sig.save')}</Button>
        </form>
        {!pinSet && <p className="text-xs text-muted-foreground">{t('clinical.sig.pinFirst')}</p>}
      </CardContent>
    </Card>
  );
}
