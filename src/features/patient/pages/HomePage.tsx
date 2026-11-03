import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarCheck, ChevronRight, Gift, Search, Video, Phone } from 'lucide-react';
import { formatDate, formatDateTime, formatTime } from '@/domain/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CardSkeleton, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useAuth } from '@/auth/AuthProvider';
import { JoinLink } from '@/features/consult/JoinLink';
import { myApptsKey, needsFallbackChoice, pendingProposal, useFamily, useFreeFollowUps, useMasters, useMyAppointments, useSettings, useUpcoming, qk } from '../api';
import { useRealtime } from '@/lib/realtime';
import { PersonAvatar, QueryError } from '../components/common';
import { DeptIcon } from '../components/DeptIcon';

const greetingKey = () => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

export function HomePage() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const { session } = useAuth();
  const family = useFamily();
  const upcoming = useUpcoming();
  const followUps = useFreeFollowUps();
  const masters = useMasters();
  const settings = useSettings();
  const joinMin = settings.data?.join_window_minutes ?? 10;
  const [q, setQ] = useState('');
  const mine = useMyAppointments();
  useRealtime('patient-home', [{ table: 'appointments' }, { table: 'reschedule_requests' }], [myApptsKey, qk.upcoming]);
  const ready = !upcoming.isPending && !followUps.isPending && !mine.isPending && !masters.isPending;
  const needsAnswer = (mine.data ?? []).filter((a) => pendingProposal(a) || needsFallbackChoice(a)).length;
  const me = family.data?.find((m) => m.is_primary);
  const firstName = (me?.full_name ?? session?.user.name ?? '').split(' ')[0];

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm text-muted-foreground">{t(`patient.home.greeting.${greetingKey()}`)}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">{firstName ? t('patient.home.hello', { name: firstName }) : t('patient.home.helloAnon')}</h1>
        <form role="search" className="relative mt-4" onSubmit={(e) => { e.preventDefault(); nav(`/p/doctors${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`); }}>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="h-12 rounded-2xl pl-11 shadow-soft" placeholder={t('patient.home.searchPh')} aria-label={t('patient.home.searchPh')} />
        </form>
      </section>

      {/* Everything below the search box arrives together: banners that load later would otherwise push
          the upcoming list down while the patient is reading it (layout shift on slow connections). */}
      {!ready ? <ListSkeleton rows={2} /> : (<>
      {needsAnswer > 0 && (
        <Link to="/p/appointments" data-testid="needs-answer" className="flex items-center gap-3 rounded-lg border border-highlight/60 bg-highlight-soft p-4 text-sm font-semibold">
          <AlertCircle className="h-5 w-5 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">{t('patient.home.needsAnswer', { count: needsAnswer })}</span>
          <ChevronRight className="h-5 w-5 shrink-0" aria-hidden />
        </Link>
      )}

      {followUps.data && followUps.data.length > 0 && (
        <section aria-label={t('patient.home.freeFollowUps')} className="space-y-2">
          {followUps.data.map((f) => (
            <Link key={`${f.patient_id}-${f.doctor_id}`} to={`/p/doctors/${f.doctor_id}?patient=${f.patient_id}`}
              className="flex items-center gap-3 rounded-lg border border-highlight/50 bg-highlight-soft/70 p-4 transition-colors hover:bg-highlight-soft">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-card"><Gift className="h-5 w-5 text-warning" aria-hidden /></span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-semibold">{t('patient.home.freeFollowUpTitle', { doctor: f.doctor_name })}</span>
                <span className="block text-muted-foreground">{t('patient.home.freeFollowUpBody', { patient: f.patient_name, date: formatDate(f.window_ends_at, i18n.language) })}</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          ))}
        </section>
      )}

      <section aria-labelledby="up-h">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="up-h" className="text-lg font-bold">{t('patient.home.upcoming')}</h2>
          <Link to="/p/appointments" className="text-sm font-semibold text-primary">{t('patient.home.seeAll')}</Link>
        </div>
        {upcoming.isPending ? <CardSkeleton /> : upcoming.isError ? <QueryError onRetry={() => void upcoming.refetch()} /> : upcoming.data.length === 0 ? (
          <Card><EmptyState className="py-6" title={t('styleGuide.emptyTitle')} body={t('styleGuide.emptyBody')} action={<Button asChild><Link to="/p/doctors">{t('patient.home.findDoctor')}</Link></Button>} /></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {upcoming.data.map((a) => (
              <Card key={a.id} className="min-w-0">
                <CardContent className="flex gap-3 p-4">
                  <PersonAvatar name={a.doctors?.full_name ?? ''} src={a.doctors?.photo_url} className="h-14 w-14" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{a.doctors?.full_name}</p>
                    <p className="truncate text-sm text-muted-foreground">{i18n.language === 'ml' ? a.departments?.name_ml : a.departments?.name} · {t('patient.forName', { name: a.patients?.full_name })}</p>
                    <p className="mt-1.5 flex items-center gap-1.5 text-sm font-medium"><CalendarCheck className="h-4 w-4 text-primary" aria-hidden />{formatDateTime(a.start_at, i18n.language)}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant="success">{t(`patient.status.${a.status}`)}</Badge>
                      <Badge variant="outline">{a.mode === 'video' ? <Video className="h-3 w-3" aria-hidden /> : <Phone className="h-3 w-3" aria-hidden />}{t(`patient.mode.${a.mode}`)}</Badge>
                      {a.is_free && <Badge variant="highlight">{t('styleGuide.freeFollowUp')}</Badge>}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{t('patient.home.joinHint', { time: formatTime(new Date(new Date(a.start_at).getTime() - joinMin * 60_000).toISOString(), i18n.language) })}</p>
                    <div className="mt-2"><JoinLink appt={a} who="p" joinMin={joinMin} /></div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="sp-h">
        <h2 id="sp-h" className="mb-2 text-lg font-bold">{t('patient.home.specialities')}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {masters.isPending
            ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
            : masters.data?.departments.map((d) => (
                <Link key={d.id} to={`/p/doctors?dept=${d.id}`} className="flex min-h-20 flex-col justify-between rounded-lg border bg-card p-3 shadow-soft transition-colors hover:border-primary/40 hover:bg-primary-soft/30">
                  <DeptIcon name={d.icon} className="h-6 w-6 text-primary" />
                  <span className="mt-2 text-sm font-semibold leading-tight">{i18n.language === 'ml' ? d.name_ml : d.name}</span>
                </Link>
              ))}
        </div>
      </section>
      </>)}
    </div>
  );
}
