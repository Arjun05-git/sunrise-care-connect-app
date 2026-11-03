import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
import { resolveLink } from '../api';

/** /l/<token>: the only kind of link we send. Opens the page for the account it was sent to. */
export function LinkPage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const { session, signOut } = useAuth();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!/^[0-9a-f]{32}$/.test(token)) return void setFailed(true);
    resolveLink(token).then((path) => nav(path, { replace: true })).catch(() => setFailed(true));
  }, [token, nav]);
  if (!failed) return <div className="flex min-h-dvh items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" aria-label={t('common.loading')} /></div>;
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <ShieldAlert className="h-12 w-12 text-warning" aria-hidden />
      <h1 className="text-xl font-bold">{t('notify.link.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('notify.link.body')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild><Link to={session ? homeFor(session.user.role) : '/'}>{t('notify.link.home')}</Link></Button>
        <Button variant="outline" onClick={() => void signOut().then(() => nav('/login', { state: { from: `/l/${token}` } }))}>{t('notify.link.switch')}</Button>
      </div>
    </main>
  );
}
