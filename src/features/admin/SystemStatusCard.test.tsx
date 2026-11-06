import { render, screen, within } from '@testing-library/react';
import { SystemStatusView } from './SystemStatusCard';
import type { SystemStatus } from './system-status';

const providers: SystemStatus['providers'] = [
  { id: 'payments', area: 'payments', mode: 'sandbox', detail: 'razorpay' },
  { id: 'whatsapp', area: 'notifications', mode: 'mock' },
  { id: 'sms', area: 'notifications', mode: 'live' },
  { id: 'push', area: 'notifications', mode: 'unconfigured' },
  { id: 'video', area: 'video', mode: 'sandbox', detail: 'jitsi_public' },
  { id: 'his', area: 'integrations', mode: 'live', note: 'unverified_adapter' },
  { id: 'leadsquared', area: 'integrations', mode: 'unconfigured' },
  { id: 'abdm', area: 'integrations', mode: 'mock' },
];
const view = (s: Partial<SystemStatus> = {}) => render(<SystemStatusView status={{ environment: 'demo', providers, warnings: [], ...s }} />);
const row = (id: string) => within(document.querySelector(`[data-ref="provider-${id}"]`) as HTMLElement);

describe('SystemStatusView', () => {
  it('shows every provider with a clear MOCK / SANDBOX / LIVE / NOT SET UP badge', () => {
    view();
    expect(row('payments').getByText('SANDBOX')).toBeInTheDocument();
    expect(row('whatsapp').getByText('MOCK')).toBeInTheDocument();
    expect(row('sms').getByText('LIVE')).toBeInTheDocument();
    expect(row('push').getByText('NOT SET UP')).toBeInTheDocument();
    expect(row('video').getByText('SANDBOX')).toBeInTheDocument();
    expect(row('abdm').getByText('MOCK')).toBeInTheDocument();
  });

  it('names the providers and groups them', () => {
    view();
    for (const name of ['Payment gateway', 'WhatsApp', 'SMS', 'Push notifications', 'Video calls']) expect(screen.getByText(name)).toBeInTheDocument();
    for (const area of ['Payments', 'Notifications', 'Video', 'Integrations']) expect(screen.getAllByText(area).length).toBeGreaterThan(0);
  });

  it('says which environment the database reports', () => {
    view({ environment: 'demo' });
    expect(screen.getByText('Demo environment')).toBeInTheDocument();
  });

  it('flags a live integration whose adapter was never run against the real system', () => {
    view();
    expect(row('his').getByText(/not yet tested against the real system/i)).toBeInTheDocument();
    expect(row('sms').queryByText(/not yet tested/i)).not.toBeInTheDocument();
  });

  it('a demo environment shows no warning, even with everything simulated', () => {
    view({ environment: 'demo', warnings: [] });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a production environment that is not fully live shows a prominent warning listing each problem', () => {
    view({ environment: 'production', warnings: ['mock:whatsapp', 'sandbox:video', 'sandbox:payments', 'unconfigured:push', 'open_cors'] });
    const alert = within(screen.getByRole('alert'));
    expect(alert.getByText(/production environment is not fully live/i)).toBeInTheDocument();
    expect(alert.getByText(/WhatsApp is simulated/i)).toBeInTheDocument();
    expect(alert.getByText(/Video calls is a test service/i)).toBeInTheDocument();
    expect(alert.getByText(/Payment gateway is a test service/i)).toBeInTheDocument();
    expect(alert.getByText(/Push notifications is not set up/i)).toBeInTheDocument();
    expect(alert.getByText(/any website/i)).toBeInTheDocument();
  });

  it('a fully live production environment shows no warning', () => {
    view({ environment: 'production', providers: providers.map((p) => ({ ...p, mode: 'live' as const })), warnings: [] });
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
