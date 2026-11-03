import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { STAFF_ROLES, type Role } from './types';
import { BootLoader } from '@/components/feedback/states';

/** Landing route for each role. */
export function homeFor(role: Role): string {
  if (role === 'patient') return '/p';
  if (role === 'doctor') return '/d';
  return '/a';
}

/** Pure decision used by the guard (unit-tested). */
export function guardDecision(session: { user: { role: Role }; stepUpPending: boolean } | null, allowed: Role[]): { kind: 'allow' } | { kind: 'login' } | { kind: 'redirect'; to: string } {
  if (!session) return { kind: 'login' };
  if (session.stepUpPending) return { kind: 'redirect', to: '/mfa' };
  if (!allowed.includes(session.user.role)) return { kind: 'redirect', to: homeFor(session.user.role) };
  return { kind: 'allow' };
}

/**
 * Role-based route guard. Unauthenticated → /login (remembering where they were going);
 * wrong role → that user's own home (no information about other areas is revealed).
 */
export function RequireRole({ roles }: { roles: Role[] }) {
  const { session, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <BootLoader />;
  const d = guardDecision(session, roles);
  if (d.kind === 'login') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (d.kind === 'redirect') return <Navigate to={d.to} replace />;
  return <Outlet />;
}

export const ROLE_GROUPS = { patient: ['patient'] as Role[], doctor: ['doctor'] as Role[], staff: STAFF_ROLES };
