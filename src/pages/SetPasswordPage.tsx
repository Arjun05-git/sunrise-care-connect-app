import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { KeyRound, Loader2 } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupabase } from '@/lib/supabase';

/**
 * Staff invite / password reset landing (/set-password). Supabase Auth puts a one-time session in the
 * link; the new staff member chooses a password, is signed out, and signs in with email + password.
 */
export function SetPasswordPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [state, setState] = useState<'checking' | 'ready' | 'expired'>('checking');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const sb = getSupabase();
    let done = false;
    const ready = (e: string | undefined) => { done = true; setEmail(e ?? ''); setState('ready'); };
    const { data: sub } = sb.auth.onAuthStateChange((_ev, s) => { if (s?.user) ready(s.user.email); });
    void sb.auth.getSession().then(({ data }) => { if (data.session) ready(data.session.user.email); });
    const timer = setTimeout(() => { if (!done) setState('expired'); }, 4000);
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer); };
  }, []);
  const strong = pw.length >= 12 && /[a-z]/i.test(pw) && /\d/.test(pw);
  const submit = async () => {
    setBusy(true);
    const sb = getSupabase();
    const { error } = await sb.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return void toast.error(t('setpw.failed'));
    await sb.auth.signOut();
    toast.success(t('setpw.done'));
    nav('/login', { replace: true, state: { staffEmail: email } });
  };
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-4">
      <Logo />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" aria-hidden />{t('setpw.title')}</CardTitle>
          <CardDescription>{state === 'ready' ? t('setpw.for', { email }) : state === 'expired' ? t('setpw.expired') : t('common.loading')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {state === 'checking' && <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />}
          {state === 'expired' && <Button asChild variant="outline"><Link to="/login">{t('setpw.toLogin')}</Link></Button>}
          {state === 'ready' && (
            <>
              <div className="space-y-1.5"><Label htmlFor="pw1">{t('setpw.new')}</Label><Input id="pw1" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t('setpw.rule')}</p></div>
              <div className="space-y-1.5"><Label htmlFor="pw2">{t('setpw.repeat')}</Label><Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
              {pw2 && pw !== pw2 && <p role="alert" className="text-sm text-destructive">{t('setpw.mismatch')}</p>}
              <Button block disabled={!strong || pw !== pw2} loading={busy} onClick={() => void submit()}>{t('setpw.save')}</Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
