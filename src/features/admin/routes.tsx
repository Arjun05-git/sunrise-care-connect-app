import { lazy, Suspense, type ComponentType } from 'react';
import { FullPageLoader } from '@/components/feedback/states';
import { isDemo } from '@/lib/config';
import { BackendRequired } from '@/features/patient/components/common';

const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
export const FeesPage = named(() => import('./pages/FeesPage'), 'FeesPage');
export const PoliciesPage = named(() => import('./pages/PoliciesPage'), 'PoliciesPage');
export const PaymentsPage = named(() => import('./pages/PaymentsPage'), 'PaymentsPage');
export const NotificationsPage = named(() => import('./pages/NotificationsPage'), 'NotificationsPage');
export const DashboardPage = named(() => import('./pages/DashboardPage'), 'DashboardPage');
export const AppointmentsPage = named(() => import('./pages/AppointmentsPage'), 'AppointmentsPage');
export const DoctorsPage = named(() => import('./pages/DoctorsPage'), 'DoctorsPage');
export const DoctorPage = named(() => import('./pages/DoctorPage'), 'DoctorPage');
export const MastersPage = named(() => import('./pages/MastersPage'), 'MastersPage');
export const ContentPage = named(() => import('./pages/ContentPage'), 'ContentPage');
export const UsersPage = named(() => import('./pages/UsersPage'), 'UsersPage');
export const SupportPage = named(() => import('./pages/SupportPage'), 'SupportPage');
export const AuditPage = named(() => import('./pages/AuditPage'), 'AuditPage');
export const ReportsPage = named(() => import('./pages/ReportsPage'), 'ReportsPage');
export const IntegrationsPage = named(() => import('./pages/IntegrationsPage'), 'IntegrationsPage');

/** Live admin screens (path → page). Anything else in the admin nav is still a placeholder. */
export const ADMIN_PAGES: Record<string, { page: ComponentType; titleKey: string }> = {
  '/a/fees': { page: FeesPage, titleKey: 'admin.fees' },
  '/a/policies': { page: PoliciesPage, titleKey: 'admin.policies' },
  '/a/payments': { page: PaymentsPage, titleKey: 'admin.payments' },
  '/a/notifications': { page: NotificationsPage, titleKey: 'admin.notifications' },
  '/a': { page: DashboardPage, titleKey: 'admin.dashboard' },
  '/a/appointments': { page: AppointmentsPage, titleKey: 'admin.appointments' },
  '/a/doctors': { page: DoctorsPage, titleKey: 'admin.doctors' },
  '/a/masters': { page: MastersPage, titleKey: 'admin.masters' },
  '/a/content': { page: ContentPage, titleKey: 'admin.content' },
  '/a/users': { page: UsersPage, titleKey: 'admin.users' },
  '/a/support': { page: SupportPage, titleKey: 'admin.support' },
  '/a/audit': { page: AuditPage, titleKey: 'admin.audit' },
  '/a/reports': { page: ReportsPage, titleKey: 'admin.reports' },
  '/a/integrations': { page: IntegrationsPage, titleKey: 'admin.integrations' },
};

export function adminPage(Page: ComponentType, titleKey: string) {
  return isDemo ? <BackendRequired titleKey={titleKey} /> : <Suspense fallback={<FullPageLoader />}><Page /></Suspense>;
}
