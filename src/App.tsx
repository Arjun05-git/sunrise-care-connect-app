import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { isDemo } from '@/lib/config';
import { RequireRole, ROLE_GROUPS, homeFor } from '@/auth/guards';
import { MobileTabShell, SidebarShell } from '@/components/layout/Shells';
import { BootLoader, FullPageLoader } from '@/components/feedback/states';
import { LoginPage } from '@/pages/LoginPage';
import { Placeholder } from '@/pages/Placeholder';
import { SettingsPanel } from '@/pages/SettingsPanel';
import { NotFound } from '@/pages/NotFound';
import { ADMIN_NAV, DOCTOR_NAV, PATIENT_NAV } from '@/routes/navigation';

import * as P from '@/features/patient/routes';
import { ADMIN_PAGES, adminPage, DoctorPage } from '@/features/admin/routes';
import { BackendRequired } from '@/features/patient/components/common';
import * as D from '@/features/doctor/routes';
import { consultPage } from '@/features/consult/routes';

// the onboarding gate reads Supabase – loaded lazily (demo mode never needs it)
const LivePatientGate = lazy(() => import('@/features/patient/components/PatientGate').then((m) => ({ default: m.PatientGate })));
const VerifyPage = lazy(() => import('@/pages/VerifyPage').then((m) => ({ default: m.VerifyPage })));
const LinkPage = lazy(() => import('@/features/notifications/pages/LinkPage').then((m) => ({ default: m.LinkPage })));
const LegalPage = lazy(() => import('@/pages/LegalPage').then((m) => ({ default: m.LegalPage })));
const StyleGuidePage = lazy(() => import('@/pages/StyleGuidePage').then((m) => ({ default: m.StyleGuidePage })));
const SetPasswordPage = lazy(() => import('@/pages/SetPasswordPage').then((m) => ({ default: m.SetPasswordPage })));
const MfaPage = lazy(() => import('@/pages/MfaPage').then((m) => ({ default: m.MfaPage })));
const ALL_ROLES = [...ROLE_GROUPS.patient, ...ROLE_GROUPS.doctor, ...ROLE_GROUPS.staff];
const PatientGate = () => (isDemo ? <Outlet /> : <Suspense fallback={<FullPageLoader />}><LivePatientGate /></Suspense>);

function RootRedirect() {
  const { session, loading } = useAuth();
  if (loading) return <BootLoader />;
  return <Navigate to={session ? homeFor(session.user.role) : '/login'} replace />;
}

/**
 * Route map for the three roles. Screens marked Placeholder are not built yet; consultation rooms
 * (/p/consult/:id, /d/consult/:id) are full-screen, outside the tab shells.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/style-guide" element={<Suspense fallback={<FullPageLoader />}><StyleGuidePage /></Suspense>} />
      {/* public prescription verification (QR target) – no sign-in */}
      <Route path="/verify" element={<Suspense fallback={<FullPageLoader />}><VerifyPage /></Suspense>} />
      <Route path="/verify/:code" element={<Suspense fallback={<FullPageLoader />}><VerifyPage /></Suspense>} />
      {/* public legal pages (linked from the consent screen) and the staff invite landing */}
      <Route path="/legal/:key" element={isDemo ? <BackendRequired titleKey="legal.title" /> : <Suspense fallback={<FullPageLoader />}><LegalPage /></Suspense>} />
      <Route path="/mfa" element={isDemo ? <Navigate to="/" replace /> : <Suspense fallback={<FullPageLoader />}><MfaPage /></Suspense>} />
      <Route path="/set-password" element={isDemo ? <BackendRequired titleKey="setpw.title" /> : <Suspense fallback={<FullPageLoader />}><SetPasswordPage /></Suspense>} />

      {/* secure links from WhatsApp / SMS / push: any signed-in account, resolved server-side */}
      <Route element={<RequireRole roles={ALL_ROLES} />}>
        <Route path="/l/:token" element={<Suspense fallback={<FullPageLoader />}><LinkPage /></Suspense>} />
      </Route>

      <Route element={<RequireRole roles={ROLE_GROUPS.patient} />}>
        <Route element={<P.PatientRoot />}>
          {/* onboarding: consent first, then the account holder's own details */}
          <Route path="/p/consent" element={P.patientPage(P.ConsentPage, 'patient.consent.title')} />
          <Route path="/p/welcome" element={P.patientPage(P.WelcomePage, 'patient.welcome.title')} />
          <Route element={<PatientGate />}>
            {/* full-screen call: outside the tab shell */}
            <Route path="/p/consult/:id" element={consultPage()} />
            <Route element={<MobileTabShell items={PATIENT_NAV} homeTo="/p" emergencyNotice />}>
              <Route path="/p" element={P.patientPage(P.HomePage, 'nav.home')} />
              <Route path="/p/doctors" element={P.patientPage(P.FindDoctorsPage, 'patient.doctors.title')} />
              <Route path="/p/doctors/:id" element={P.patientPage(P.DoctorProfilePage, 'patient.doctors.title')} />
              <Route path="/p/book/details" element={P.patientPage(P.PreConsultPage, 'patient.pre.title')} />
              <Route path="/p/book/review/:id" element={P.patientPage(P.ReviewPage, 'patient.review.title')} />
              <Route path="/p/appointments" element={P.patientPage(P.AppointmentsPage, 'nav.appointments')} />
              <Route path="/p/appointments/:id/choose" element={P.patientPage(P.ChooseTimePage, 'nav.appointments')} />
              <Route path="/p/records" element={P.patientPage(P.RecordsPage, 'nav.records')} />
              <Route path="/p/help" element={P.patientPage(P.HelpPage, 'help.title')} />
              <Route path="/p/help/:id" element={P.patientPage(P.TicketPage, 'help.title')} />
              <Route path="/p/feedback/:id" element={P.patientPage(P.FeedbackPage, 'notify.feedback.title')} />
              <Route path="/p/records/:id" element={P.patientPage(P.PrescriptionPage, 'clinical.records.rx')} />
              <Route path="/p/profile" element={isDemo ? <SettingsPanel /> : P.patientPage(P.ProfilePage, 'nav.profile')} />
              <Route path="/p/profile/family/:id" element={P.patientPage(P.MemberPage, 'patient.family.title')} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route element={<RequireRole roles={ROLE_GROUPS.doctor} />}>
        <Route path="/d/consult/:id" element={consultPage()} />
        <Route element={<MobileTabShell items={DOCTOR_NAV} homeTo="/d" />}>
          <Route path="/d" element={D.doctorPage(D.TodayPage, 'nav.today')} />
          <Route path="/d/appointments/:id" element={D.doctorPage(D.AppointmentPage, 'doctor.appt.title')} />
          <Route path="/d/appointments/:id/write" element={D.doctorPage(D.WriteUpPage, 'clinical.page.title')} />
          <Route path="/d/profile/signature" element={D.doctorPage(D.SignaturePage, 'clinical.sig.title')} />
          <Route path="/d/calendar" element={D.doctorPage(D.CalendarPage, 'nav.calendar')} />
          <Route path="/d/availability" element={D.doctorPage(D.AvailabilityPage, 'doctor.avail.title')} />
          <Route path="/d/patients" element={D.doctorPage(D.PatientsPage, 'nav.patients')} />
          <Route path="/d/patients/:id" element={D.doctorPage(D.PatientTimelinePage, 'doctor.tl.title')} />
          <Route path="/d/profile" element={<D.DoctorProfileTab />} />
        </Route>
      </Route>

      <Route element={<RequireRole roles={ROLE_GROUPS.staff} />}>
        <Route element={<SidebarShell items={ADMIN_NAV} homeTo="/a" />}>
          {ADMIN_NAV.filter((n) => n.to !== '/a/settings').map((n) => (
            <Route key={n.to} path={n.to} element={ADMIN_PAGES[n.to] ? adminPage(ADMIN_PAGES[n.to]!.page, ADMIN_PAGES[n.to]!.titleKey) : <Placeholder titleKey={n.labelKey} />} />
          ))}
          <Route path="/a/doctors/:id" element={adminPage(DoctorPage, 'admin.doctors')} />
          <Route path="/a/settings" element={<SettingsPanel titleKey="admin.settings" />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
