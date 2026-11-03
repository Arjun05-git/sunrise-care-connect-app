import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, IdCard } from 'lucide-react';
import { formatDateLong } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { FunctionError } from '@/lib/functions';
import { confirmAbha, startAbha, unlinkAbha, useAbha, useAbdmEnabled } from './api';

/**
 * Optional ABHA (Ayushman Bharat Health Account) linking for one family member: verify with an OTP from
 * ABDM, then link. Never needed to book. Hidden entirely while app_settings.abdm_enabled is off.
 */
export function AbhaCard({ patientId }: { patientId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const flag = useAbdmEnabled();
  const abha = useAbha(patientId);
  const [id, setId] = useState('');
  const [method, setMethod] = useState<'mobile_otp' | 'aadhaar_otp'>('mobile_otp');
  const [txn, setTxn] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  if (!flag.data || !abha.data) return null;
  const err = (e: unknown) => {
    const code = e instanceof FunctionError ? e.code : '';
    toast.error(i18n.exists(`abha.err.${code}`) ? t(`abha.err.${code}`) : t('common.error'));
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const linked = abha.data.abha_number;
  return (
    <Card data-ref="abha-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><IdCard className="h-5 w-5 text-primary" aria-hidden />{t('abha.title')}</CardTitle>
        <CardDescription>{t('abha.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {linked ? (
          <>
            <p className="flex items-center gap-2 font-semibold" data-ref="abha-linked"><BadgeCheck className="h-4 w-4 text-success" aria-hidden />{linked}{abha.data.abha_address ? ` · ${abha.data.abha_address}` : ''}</p>
            {abha.data.abha_verified_at && <p className="text-xs text-muted-foreground">{t('abha.verifiedOn', { date: formatDateLong(abha.data.abha_verified_at, i18n.language) })}</p>}
            <Button size="sm" variant="outline" loading={busy} onClick={() => void run(async () => {
              await unlinkAbha(patientId);
              toast.success(t('abha.unlinked'));
              await qc.invalidateQueries({ queryKey: ['abdm', 'patient', patientId] });
            })}>{t('abha.unlink')}</Button>
          </>
        ) : !txn ? (
          <>
            <div className="space-y-1.5"><Label htmlFor="abha-id">{t('abha.id')}</Label>
              <Input id="abha-id" value={id} autoComplete="off" onChange={(e) => setId(e.target.value)} placeholder="91-1234-5678-9012 / name@abdm" /></div>
            <RadioGroup value={method} onValueChange={(v) => setMethod(v as typeof method)} className="flex gap-4" aria-label={t('abha.method')}>
              <label className="flex items-center gap-2"><RadioGroupItem value="mobile_otp" />{t('abha.mobileOtp')}</label>
              <label className="flex items-center gap-2"><RadioGroupItem value="aadhaar_otp" />{t('abha.aadhaarOtp')}</label>
            </RadioGroup>
            <Button size="sm" disabled={id.trim().length < 6} loading={busy} data-ref="abha-start"
              onClick={() => void run(async () => { setTxn((await startAbha(patientId, id.trim(), method)).txn); toast.success(t('abha.otpSent')); })}>{t('abha.sendOtp')}</Button>
            <p className="text-xs text-muted-foreground">{t('abha.optional')}</p>
          </>
        ) : (
          <>
            <div className="space-y-1.5"><Label htmlFor="abha-otp">{t('abha.otp')}</Label>
              <Input id="abha-otp" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { setTxn(null); setOtp(''); }}>{t('common.cancel')}</Button>
              <Button size="sm" disabled={otp.length !== 6} loading={busy} data-ref="abha-confirm" onClick={() => void run(async () => {
                const r = await confirmAbha(txn, otp);
                toast.success(t('abha.linked', { number: r.abha_number }));
                setTxn(null);
                setOtp('');
                await qc.invalidateQueries({ queryKey: ['abdm', 'patient', patientId] });
              })}>{t('abha.verify')}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
