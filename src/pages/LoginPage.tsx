import { useEffect, useState } from 'react';
import { useForm, type FieldErrors, type FieldValues, type Resolver } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { HeartPulse, Languages, Shield, Stethoscope, UserRound } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputOTP } from '@/components/ui/input-otp';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
import { AuthError, type Session } from '@/auth/types';
import { DEMO } from '@/auth/demoAuth';
import { useTheme } from '@/lib/theme';
import { showDemoHints } from '@/lib/config';

type Tab = 'patient' | 'doctor' | 'staff';

const maskPhone = (p: string) => `+91 ${p.slice(-10, -8)}•••••${p.slice(-3)}`;
const authErrorKey = (e: unknown) => (e instanceof AuthError ? `auth.err.${e.code}` : 'common.error');

export function LoginPage() {
  const { t } = useTranslation();
  const { session, setSession } = useAuth();
  const { prefs, setPrefs } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [tab, setTab] = useState<Tab>('patient');

  // where to go after sign-in: the page they were sent away from (e.g. a /l/<token> message link), else home
  const from = (loc.state as { from?: string } | null)?.from;
  useEffect(() => {
    if (session) nav(from ?? homeFor(session.user.role), { replace: true });
  }, [session, nav, from]);

  const done = (s: Session) => {
    setSession(s);
    toast.success(t('auth.welcome'));
    nav(from ?? homeFor(s.user.role), { replace: true });
  };

  return (
    <div className="min-h-dvh bg-gradient-to-b from-primary-soft/70 via-background to-background">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-6">
        <div className="flex items-center justify-between">
          <Logo />
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => setPrefs({ language: prefs.language === 'en' ? 'ml' : 'en' })} aria-label={t('settings.switchLanguage')}>
            <Languages />
            {prefs.language === 'en' ? 'മലയാളം' : 'English'}
          </Button>
        </div>
        <div className="mb-6 mt-10">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-card shadow-soft">
            <HeartPulse className="h-7 w-7 text-primary" aria-hidden />
          </div>
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{t('auth.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('auth.subtitle')}</p>
        </div>

        <Card>
          <CardContent className="p-5">
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList>
                <TabsTrigger value="patient"><UserRound aria-hidden className="max-[359px]:hidden" />{t('roles.patient')}</TabsTrigger>
                <TabsTrigger value="doctor"><Stethoscope aria-hidden className="max-[359px]:hidden" />{t('roles.doctor')}</TabsTrigger>
                <TabsTrigger value="staff"><Shield aria-hidden className="max-[359px]:hidden" />{t('auth.staff')}</TabsTrigger>
              </TabsList>
              <TabsContent value="patient"><PhoneOtpForm role="patient" onDone={done} /></TabsContent>
              <TabsContent value="doctor"><PhoneOtpForm role="doctor" onDone={done} /></TabsContent>
              <TabsContent value="staff"><StaffForm onDone={done} /></TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {showDemoHints && (
          <div className="mt-4 rounded-lg border border-dashed border-highlight bg-highlight-soft/60 p-4 text-sm">
            <p className="font-semibold text-warning">{t('auth.demoTitle')}</p>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li><b className="text-foreground">{t('roles.patient')}:</b> {DEMO.patientPhone.slice(3)} · OTP {DEMO.otp}</li>
              <li><b className="text-foreground">{t('roles.doctor')}:</b> {DEMO.doctorPhone.slice(3)} · OTP {DEMO.otp}</li>
              <li><b className="text-foreground">{t('roles.admin')}:</b> {DEMO.adminEmail} · {DEMO.password}</li>
            </ul>
          </div>
        )}

        <div className="mt-auto space-y-3 pt-6">
          <EmergencyNotice compact />
          <p className="text-center text-xs text-muted-foreground"><Link to="/style-guide" className="underline underline-offset-2">{t('styleGuide.title')}</Link></p>
        </div>
      </div>
    </div>
  );
}

// Two tiny hand-written resolvers instead of zod: the sign-in screen is on every cold start, and zod
// (~13 KB gzipped) would otherwise ship in the main bundle for every signed-in page too.
function resolver<T extends FieldValues>(check: (v: T) => Partial<Record<keyof T, string>>): Resolver<T> {
  return async (values) => {
    const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) as T;
    const found = Object.entries(check(trimmed)).filter(([, m]) => m);
    if (!found.length) return { values: trimmed, errors: {} };
    return { values: {}, errors: Object.fromEntries(found.map(([k, m]) => [k, { type: 'validate', message: m }])) as FieldErrors<T> };
  };
}
type PhoneForm = { phone: string };
const phoneResolver = resolver<PhoneForm>((v) => ({ phone: /^[6-9]\d{9}$/.test(v.phone) ? undefined : 'auth.err.invalid_phone' }));

function PhoneOtpForm({ role, onDone }: { role: 'patient' | 'doctor'; onDone: (s: Session) => void }) {
  const { t } = useTranslation();
  const { service } = useAuth();
  const [phone, setPhone] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const form = useForm<PhoneForm>({ resolver: phoneResolver, defaultValues: { phone: showDemoHints ? (role === 'patient' ? DEMO.patientPhone : DEMO.doctorPhone).slice(3) : '' } });

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const send = async (p: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await service.requestOtp(`+91${p}`);
      setPhone(p);
      setWait(r.retryAfterSec);
      toast.success(t('auth.otpSent', { phone: maskPhone(p) }));
    } catch (e) {
      setErr(t(authErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!phone) return;
    setBusy(true);
    setErr(null);
    try {
      onDone(await service.verifyOtp(`+91${phone}`, otp, role));
    } catch (e) {
      setErr(t(authErrorKey(e)));
      setOtp('');
    } finally {
      setBusy(false);
    }
  };

  if (!phone)
    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit((v) => send(v.phone))} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>{t('auth.mobile')}</FormLabel>
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-xl border border-r-0 border-input bg-muted px-3 text-muted-foreground">+91</span>
                  <FormControl>
                    <Input className="rounded-l-none" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} {...field} />
                  </FormControl>
                </div>
                <FormDescription>{role === 'doctor' ? t('auth.doctorHint') : t('auth.patientHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <Button type="submit" block size="lg" loading={busy}>{t('auth.getOtp')}</Button>
        </form>
      </Form>
    );

  return (
    <div className="space-y-4">
      <p className="text-center text-sm text-muted-foreground">
        {t('auth.enterOtp', { phone: maskPhone(phone) })}{' '}
        <button type="button" className="font-semibold text-primary underline" onClick={() => { setPhone(null); setOtp(''); }}>{t('auth.change')}</button>
      </p>
      <InputOTP value={otp} onChange={setOtp} label={t('auth.otpDigit')} invalid={!!err} autoFocus />
      {err && <p role="alert" className="text-center text-sm text-destructive">{err}</p>}
      <Button block size="lg" disabled={otp.length !== 6} loading={busy} onClick={verify}>{t('auth.verify')}</Button>
      <p className="text-center text-sm">
        {wait > 0 ? <span className="text-muted-foreground">{t('auth.resendIn', { s: wait })}</span> : <button type="button" className="font-semibold text-primary" onClick={() => send(phone)}>{t('auth.resend')}</button>}
      </p>
    </div>
  );
}

type StaffForm = { email: string; password: string };
const staffResolver = resolver<StaffForm>((v) => ({
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? undefined : 'auth.err.email',
  password: v.password.length >= 8 ? undefined : 'auth.err.password',
}));

function StaffForm({ onDone }: { onDone: (s: Session) => void }) {
  const { t } = useTranslation();
  const { service } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const form = useForm<StaffForm>({ resolver: staffResolver, defaultValues: showDemoHints ? { email: DEMO.adminEmail, password: DEMO.password } : { email: '', password: '' } });
  const submit = form.handleSubmit(async (v) => {
    setErr(null);
    try {
      onDone(await service.signInWithPassword(v.email, v.password));
    } catch (e) {
      setErr(t(authErrorKey(e)));
    }
  });
  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormField control={form.control} name="email" render={({ field }) => (
          <FormItem>
            <FormLabel required>{t('auth.email')}</FormLabel>
            <FormControl><Input type="email" autoComplete="username" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="password" render={({ field }) => (
          <FormItem>
            <FormLabel required>{t('auth.password')}</FormLabel>
            <FormControl><Input type="password" autoComplete="current-password" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>{t('auth.signIn')}</Button>
        <p className="text-center text-xs text-muted-foreground">{t('auth.mfaNote')}</p>
      </form>
    </Form>
  );
}
