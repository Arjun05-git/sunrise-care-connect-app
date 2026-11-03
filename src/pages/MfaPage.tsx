import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LogOut, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FullPageLoader } from '@/components/feedback/states';
import { Logo } from '@/components/brand/Logo';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
import { getSupabase } from '@/lib/supabase';

type Step = { kind: 'loading' } | { kind: 'enroll'; factorId: string; qr: string; secret: string } | { kind: 'verify'; factorId: string };

/**
 * Staff second factor (TOTP, e.g. Google Authenticator or Microsoft Authenticator). First sign-in: scan the
 * QR code and confirm a code; afterwards: a code at every sign-in. Until then the session is aal1 and the
 * database refuses every staff function, so this screen is the only way into the console.
 */
export function MfaPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { session, loading, service, setSession, signOut } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // one enrolment per visit: effects can run twice (React StrictMode), and a second enrol would fail
  const job = useRef<Promise<Step> | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session) return void nav('/login', { replace: true });
    if (!session.stepUpPending) return void nav(homeFor(session.user.role), { replace: true });
    let live = true;
    job.current ??= (async (): Promise<Step> => {
      const mfa = getSupabase().auth.mfa;
      const { data, error } = await mfa.listFactors();
      if (error) throw error;
      const verified = data.totp.find((f) => f.status === 'verified');
      if (verified) return { kind: 'verify', factorId: verified.id };
      // an earlier enrolment that was never confirmed: start again so the QR code always matches the app
      for (const f of data.all.filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) await mfa.unenroll({ factorId: f.id });
      const { data: e, error: e2 } = await mfa.enroll({ factorType: 'totp', friendlyName: 'Sunrise Care Connect' });
      if (e2) throw e2;
      return { kind: 'enroll', factorId: e.id, qr: e.totp.qr_code, secret: e.totp.secret };
    })();
    job.current.then((s) => live && setStep(s)).catch(() => { job.current = null; toast.error(t('common.error')); });
    return () => { live = false; };
  }, [loading, session, nav, t]);

  const submit = async () => {
    if (step.kind === 'loading') return;
    setBusy(true);
    const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId: step.factorId, code });
    if (error) {
      setBusy(false);
      setCode('');
      return void toast.error(t('mfa.wrong'));
    }
    const s = await service.getSession();
    setSession(s);
    setBusy(false);
    if (step.kind === 'enroll') toast.success(t('mfa.enrolled'));
    if (s) nav(homeFor(s.user.role), { replace: true });
  };

  if (loading || step.kind === 'loading') return <FullPageLoader />;
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-4">
      <Logo />
      <Card data-ref="mfa-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" aria-hidden />{t(step.kind === 'enroll' ? 'mfa.enrollTitle' : 'mfa.verifyTitle')}</CardTitle>
          <CardDescription>{t(step.kind === 'enroll' ? 'mfa.enrollBody' : 'mfa.verifyBody')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step.kind === 'enroll' && (
            <div className="space-y-2 text-center">
              <img src={step.qr} alt={t('mfa.qrAlt')} className="mx-auto h-48 w-48 rounded-lg bg-white p-2" data-ref="mfa-qr" />
              <p className="text-xs text-muted-foreground">{t('mfa.manual')}</p>
              <code className="block break-all rounded-md bg-muted px-2 py-1 text-sm" data-ref="mfa-secret">{step.secret}</code>
            </div>
          )}
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="mfa-code">{t('mfa.code')}</Label>
              <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </div>
            <Button type="submit" block disabled={code.length !== 6} loading={busy}>{t('mfa.confirm')}</Button>
          </form>
        </CardContent>
      </Card>
      <Button variant="ghost" onClick={() => void signOut().then(() => nav('/login', { replace: true }))}><LogOut aria-hidden />{t('auth.signOut')}</Button>
    </main>
  );
}
