import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Logo } from '@/components/brand/Logo';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/auth/AuthProvider';
import { useSavePatient } from '../api';
import { MemberForm } from '../components/MemberForm';
import { useRpcErrorText } from '../components/common';
import { rpcErrorCode } from '@/lib/supabase';

/** First-run profile: the account holder's own patient record. */
export function WelcomePage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { session, setSession } = useAuth();
  const save = useSavePatient();
  const errText = useRpcErrorText();
  return (
    <div className="min-h-dvh bg-gradient-to-b from-primary-soft/60 via-background to-background">
      <div className="mx-auto max-w-lg px-4 py-6">
        <Logo />
        <h1 className="mt-8 text-2xl font-extrabold tracking-tight">{t('patient.welcome.title')}</h1>
        <p className="mb-5 mt-1 text-muted-foreground">{t('patient.welcome.subtitle')}</p>
        <Card>
          <CardContent className="p-5">
            <MemberForm
              isSelf
              busy={save.isPending}
              submitLabel={t('patient.welcome.continue')}
              onSubmit={async (v) => {
                try {
                  await save.mutateAsync(v);
                  if (session) setSession({ ...session, user: { ...session.user, name: v.full_name } });
                  const next = params.get('next');
                  nav(next && next.startsWith('/p') && !next.startsWith('/p/welcome') ? next : '/p', { replace: true });
                } catch (e) {
                  toast.error(errText(rpcErrorCode(e)));
                }
              }}
            />
          </CardContent>
        </Card>
        <EmergencyNotice compact className="mt-6" />
      </div>
    </div>
  );
}
