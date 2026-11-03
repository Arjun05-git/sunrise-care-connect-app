import { lazy, Suspense, type ComponentType } from 'react';
import { Outlet } from 'react-router-dom';
import { FullPageLoader } from '@/components/feedback/states';
import { isDemo } from '@/lib/config';
import { BookingDraftProvider } from './BookingDraft';
import { BackendRequired } from './components/common';

// Route-level code splitting: patient screens load on demand.
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
export const HomePage = named(() => import('./pages/HomePage'), 'HomePage');
export const FindDoctorsPage = named(() => import('./pages/FindDoctorsPage'), 'FindDoctorsPage');
export const DoctorProfilePage = named(() => import('./pages/DoctorProfilePage'), 'DoctorProfilePage');
export const PreConsultPage = named(() => import('./pages/PreConsultPage'), 'PreConsultPage');
export const ReviewPage = named(() => import('./pages/ReviewPage'), 'ReviewPage');
export const ProfilePage = named(() => import('./pages/ProfilePage'), 'ProfilePage');
export const MemberPage = named(() => import('./pages/MemberPage'), 'MemberPage');
export const ConsentPage = named(() => import('./pages/ConsentPage'), 'ConsentPage');
export const AppointmentsPage = named(() => import('./pages/AppointmentsPage'), 'AppointmentsPage');
export const ChooseTimePage = named(() => import('./pages/ChooseTimePage'), 'ChooseTimePage');
export const WelcomePage = named(() => import('./pages/WelcomePage'), 'WelcomePage');
export const RecordsPage = named(() => import('@/features/clinical/pages/RecordsPage'), 'RecordsPage');
export const HelpPage = named(() => import('@/features/help/pages/HelpPage'), 'HelpPage');
export const TicketPage = named(() => import('@/features/help/pages/TicketPage'), 'TicketPage');
export const FeedbackPage = named(() => import('@/features/notifications/pages/FeedbackPage'), 'FeedbackPage');
export const PrescriptionPage = named(() => import('@/features/clinical/pages/PrescriptionPage'), 'PrescriptionPage');

/** Wraps a patient screen: lazy loading, and the "start the database" notice in demo mode. */
export function patientPage(Page: ComponentType, titleKey: string) {
  return isDemo ? <BackendRequired titleKey={titleKey} /> : <Suspense fallback={<FullPageLoader />}><Page /></Suspense>;
}

/** Holds the in-memory booking draft for every patient route. */
export function PatientRoot() {
  return (
    <BookingDraftProvider>
      <Outlet />
    </BookingDraftProvider>
  );
}
