import { lazy, Suspense, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarCog, ChevronRight, PenLine } from 'lucide-react';
import { FullPageLoader } from '@/components/feedback/states';
import { isDemo } from '@/lib/config';
import { BackendRequired } from '@/features/patient/components/common';
import { SettingsPanel } from '@/pages/SettingsPanel';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/PageHeader';

const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
export const TodayPage = named(() => import('./pages/TodayPage'), 'TodayPage');
export const AppointmentPage = named(() => import('./pages/AppointmentPage'), 'AppointmentPage');
export const CalendarPage = named(() => import('./pages/CalendarPage'), 'CalendarPage');
export const AvailabilityPage = named(() => import('./pages/AvailabilityPage'), 'AvailabilityPage');
export const PatientsPage = named(() => import('./pages/PatientsPage'), 'PatientsPage');
export const PatientTimelinePage = named(() => import('./pages/PatientTimelinePage'), 'PatientTimelinePage');
export const WriteUpPage = named(() => import('@/features/clinical/pages/WriteUpPage'), 'WriteUpPage');
export const SignaturePage = named(() => import('@/features/clinical/pages/SignaturePage'), 'SignaturePage');

const PrefsCard = named(() => import('@/features/notifications/PrefsCard'), 'NotificationPrefsCard');

export function doctorPage(Page: ComponentType, titleKey: string) {
  return isDemo ? <BackendRequired titleKey={titleKey} /> : <Suspense fallback={<FullPageLoader />}><Page /></Suspense>;
}

/** Doctor profile tab: availability shortcut + display preferences. */
export function DoctorProfileTab() {
  const { t } = useTranslation();
  const { session } = useAuth();
  // same shape as the patient profile: heading first, one centred column
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t('nav.profile')} subtitle={session?.user.name || undefined} />
      {!isDemo && (
        <Link to="/d/availability" className="flex items-center gap-3 rounded-lg border bg-card p-4 font-semibold shadow-soft hover:bg-accent">
          <CalendarCog className="h-5 w-5 text-primary" aria-hidden />{t('doctor.avail.title')}<ChevronRight className="ml-auto h-4 w-4" aria-hidden />
        </Link>
      )}
      {!isDemo && (
        <Link to="/d/profile/signature" className="flex items-center gap-3 rounded-lg border bg-card p-4 font-semibold shadow-soft hover:bg-accent">
          <PenLine className="h-5 w-5 text-primary" aria-hidden />{t('clinical.sig.title')}<ChevronRight className="ml-auto h-4 w-4" aria-hidden />
        </Link>
      )}
      {!isDemo && <Suspense fallback={null}><PrefsCard /></Suspense>}
      <SettingsPanel withHeader={false} />
    </div>
  );
}
