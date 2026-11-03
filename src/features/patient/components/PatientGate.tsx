import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageLoader } from '@/components/feedback/states';
import { isDemo } from '@/lib/config';
import { missingConsents, useConsents, useFamily, useSettings } from '../api';
import { QueryError } from './common';

/**
 * Patient onboarding gate: required consents (terms, data processing, teleconsultation – current
 * version) first, then the account holder's own patient record. Only then the patient app.
 */
export function PatientGate() {
  return isDemo ? <Outlet /> : <LiveGate />;
}

function LiveGate() {
  const loc = useLocation();
  const settings = useSettings();
  const consents = useConsents();
  const family = useFamily();
  if (settings.isPending || consents.isPending || family.isPending) return <FullPageLoader />;
  if (settings.isError || consents.isError || family.isError)
    return <div className="mx-auto max-w-md p-4"><QueryError onRetry={() => { void settings.refetch(); void consents.refetch(); void family.refetch(); }} /></div>;
  const next = encodeURIComponent(loc.pathname + loc.search);
  if (missingConsents(consents.data, settings.data.consent_versions).length) return <Navigate to={`/p/consent?next=${next}`} replace />;
  if (!family.data.some((p) => p.is_primary)) return <Navigate to={`/p/welcome?next=${next}`} replace />;
  return <Outlet />;
}
