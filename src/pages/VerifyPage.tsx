import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, ShieldQuestion, TriangleAlert, XCircle } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { config } from '@/lib/config';
import { formatDateLong, formatTime } from '@/domain/time';

type Result = { status: 'valid' | 'superseded' | 'not_found'; doctor?: string; registration_no?: string; council?: string; issued_at?: string } | { error: string };

/**
 * Public QR target (/verify/:code), no sign-in. Shows only whether the prescription is genuine and
 * current, the prescribing doctor and the date – never the patient, diagnosis or medicines.
 */
export function VerifyPage() {
  const { code = '' } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [res, setRes] = useState<Result | null>(null);
  const [input, setInput] = useState(code);

  useEffect(() => {
    const meta = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' });
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    if (!code) return;
    setRes(null);
    let alive = true;
    fetch(`${config.supabaseUrl}/functions/v1/prescription-verify?code=${encodeURIComponent(code)}`)
      .then(async (r) => (await r.json()) as Result)
      .catch(() => ({ error: 'network' }))
      .then((r) => alive && setRes(r));
    return () => { alive = false; };
  }, [code]);

  const ok = res && 'status' in res;
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center bg-background px-4 py-8">
      <Logo />
      <h1 className="mt-6 text-xl font-bold">{t('verify.title')}</h1>
      <p className="mt-1 max-w-md text-center text-sm text-muted-foreground">{t('verify.subtitle')}</p>
      <Card className="mt-6 w-full max-w-md">
        <CardContent className="space-y-4 p-6">
          {code && !res && <div className="flex justify-center py-6"><Loader2 className="h-8 w-8 animate-spin text-primary" aria-label={t('common.loading')} /></div>}
          {res && !ok && <Status icon={<TriangleAlert className="h-10 w-10 text-warning" aria-hidden />} title={t((res as { error: string }).error === 'rate_limited' ? 'verify.rateLimited' : 'verify.error')} />}
          {ok && res.status === 'not_found' && <Status icon={<XCircle className="h-10 w-10 text-destructive" aria-hidden />} title={t('verify.notFound')} body={t('verify.notFoundBody')} />}
          {ok && res.status !== 'not_found' && (
            <>
              {res.status === 'valid'
                ? <Status icon={<CheckCircle2 className="h-10 w-10 text-success" aria-hidden />} title={t('verify.valid')} body={t('verify.validBody')} />
                : <Status icon={<ShieldQuestion className="h-10 w-10 text-warning" aria-hidden />} title={t('verify.superseded')} body={t('verify.supersededBody')} />}
              <dl className="space-y-2 rounded-xl bg-muted/60 p-4 text-sm" data-ref="verify-details">
                <div><dt className="text-xs text-muted-foreground">{t('verify.doctor')}</dt><dd className="font-semibold">{res.doctor}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('verify.registration')}</dt><dd>{res.registration_no}{res.council ? ` · ${res.council}` : ''}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('verify.issued')}</dt><dd>{res.issued_at && `${formatDateLong(res.issued_at, i18n.language)}, ${formatTime(res.issued_at, i18n.language)}`}</dd></div>
              </dl>
            </>
          )}
          <form className="space-y-1.5 border-t pt-4" onSubmit={(e) => { e.preventDefault(); const c = input.trim().toUpperCase(); if (c) navigate(`/verify/${encodeURIComponent(c)}`); }}>
            <Label htmlFor="verify-code">{t('verify.enterCode')}</Label>
            <div className="flex gap-2">
              <Input id="verify-code" value={input} maxLength={12} autoCapitalize="characters" className="font-mono uppercase tracking-widest" onChange={(e) => setInput(e.target.value)} />
              <Button type="submit">{t('verify.check')}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <p className="mt-6 max-w-md text-center text-xs text-muted-foreground">{t('verify.privacy')}</p>
    </main>
  );
}

function Status({ icon, title, body }: { icon: React.ReactNode; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center" role="status" data-ref="verify-status">
      {icon}
      <p className="text-lg font-bold">{title}</p>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
    </div>
  );
}
