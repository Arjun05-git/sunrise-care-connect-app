import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '@/App';
import { AuthProvider } from '@/auth/AuthProvider';
import { ThemeProvider } from '@/lib/theme';
import type { AuthService, Session } from '@/auth/types';
import en from '@/i18n/locales/en.json';
import ml from '@/i18n/locales/ml.json';

const fakeAuth = (session: Session | null): AuthService => ({
  mode: 'demo',
  requestOtp: async () => ({ retryAfterSec: 30 }),
  verifyOtp: async () => session!,
  signInWithPassword: async () => session!,
  getSession: async () => session,
  signOut: async () => undefined,
});
const as = (role: Session['user']['role']): Session => ({ user: { id: 'x', role, name: 'Test User', phone: null, email: null }, stepUpPending: false, issuedAt: '' });

function renderAt(path: string, session: Session | null) {
  window.matchMedia = window.matchMedia ?? ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never);
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider service={fakeAuth(session)}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('routing & guards', () => {
  it('redirects anonymous users from /p to the login page', async () => {
    renderAt('/p', null);
    expect(await screen.findByRole('button', { name: 'Get OTP' })).toBeInTheDocument();
  });
  it('shows the patient shell with tab bar and emergency notice', async () => {
    renderAt('/p/records', as('patient'));
    expect(await screen.findByRole('heading', { name: 'Records' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Appointments' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/not for emergencies/)).toBeInTheDocument();
  });
  it('keeps a patient out of the admin area', async () => {
    renderAt('/a/payments', as('patient'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument());
  });
  it('lets finance staff into the admin shell with the sidebar', async () => {
    renderAt('/a/payments', as('finance'));
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Audit log' }).length).toBeGreaterThan(0);
  });
  it('sends a doctor to /d from the root', async () => {
    renderAt('/', as('doctor'));
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });
});

describe('i18n', () => {
  const flat = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  it('English and Malayalam have identical keys', () => expect(flat(ml).sort()).toEqual(flat(en).sort()));
});
