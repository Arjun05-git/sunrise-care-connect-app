// Which providers are simulated and which are real. Pure (the environment is passed in) so it is easy to test.
// It reports modes and short codes only - never a configured value - so it can be shown to an admin safely.
//
//   mock          simulated: nothing real is sent or charged
//   sandbox       a real service used for testing: Razorpay test keys, the free public Jitsi server
//   live          real
//   unconfigured  missing its settings; the feature does not work (payments) or messages fail (channels)

export type Mode = 'mock' | 'sandbox' | 'live' | 'unconfigured';
export type ProviderId = 'payments' | 'whatsapp' | 'sms' | 'push' | 'video' | 'his' | 'leadsquared' | 'abdm';
export type Area = 'payments' | 'notifications' | 'video' | 'integrations';

export interface ProviderStatus {
  id: ProviderId;
  area: Area;
  mode: Mode;
  /** short code, e.g. 'razorpay', 'jitsi_public' */
  detail?: string;
  /** the HTTP adapter exists but has not been run against the real system yet */
  note?: 'unverified_adapter';
}

export interface SystemStatus {
  environment: 'demo' | 'production';
  providers: ProviderStatus[];
  /** only in production: `<mode>:<provider>` for every provider that is not live, and `open_cors` */
  warnings: string[];
}

type Get = (key: string) => string | undefined;

function payments(get: Get): ProviderStatus {
  const wanted = get('PAYMENTS_PROVIDER') ?? (get('RAZORPAY_KEY_ID') ? 'razorpay' : 'mock');
  if (wanted === 'razorpay') {
    const id = get('RAZORPAY_KEY_ID');
    if (!id || !get('RAZORPAY_KEY_SECRET')) return { id: 'payments', area: 'payments', mode: 'unconfigured', detail: 'razorpay_keys_missing' };
    return { id: 'payments', area: 'payments', mode: id.startsWith('rzp_live_') ? 'live' : 'sandbox', detail: 'razorpay' };
  }
  // same rule as activeProviderName(): the mock gateway only exists where PAYMENTS_ALLOW_MOCK=true
  return get('PAYMENTS_ALLOW_MOCK') === 'true'
    ? { id: 'payments', area: 'payments', mode: 'mock', detail: 'mock_gateway' }
    : { id: 'payments', area: 'payments', mode: 'unconfigured', detail: 'mock_payments_disabled' };
}

function notifications(get: Get): ProviderStatus[] {
  const mock = get('NOTIFY_PROVIDER') === 'mock';
  const live = {
    whatsapp: !!(get('WHATSAPP_TOKEN') && get('WHATSAPP_PHONE_NUMBER_ID')),
    sms: !!get('MSG91_AUTH_KEY'),
    push: !!((get('VAPID_PUBLIC_KEY') && get('VAPID_PRIVATE_KEY')) || get('FCM_SERVICE_ACCOUNT')),
  };
  return (['whatsapp', 'sms', 'push'] as const).map((id) => ({ id, area: 'notifications' as const, mode: mock ? ('mock' as const) : live[id] ? ('live' as const) : ('unconfigured' as const) }));
}

function video(get: Get): ProviderStatus {
  // same rule as activeVideoProvider(): LiveKit needs all three settings, otherwise the app falls back to Jitsi
  if (get('VIDEO_PROVIDER') === 'livekit' && get('LIVEKIT_URL') && get('LIVEKIT_API_KEY') && get('LIVEKIT_API_SECRET')) return { id: 'video', area: 'video', mode: 'live', detail: 'livekit' };
  return (get('JITSI_DOMAIN') ?? 'meet.jit.si') === 'meet.jit.si'
    ? { id: 'video', area: 'video', mode: 'sandbox', detail: 'jitsi_public' }
    : { id: 'video', area: 'video', mode: 'live', detail: 'jitsi_own_domain' };
}

function integrations(get: Get): ProviderStatus[] {
  const mock = get('INTEGRATIONS_PROVIDER') === 'mock';
  const configured = {
    his: !!(get('HIS_BASE_URL') && get('HIS_API_KEY')),
    leadsquared: !!(get('LSQ_HOST') && get('LSQ_ACCESS_KEY') && get('LSQ_SECRET_KEY')),
    abdm: !!(get('ABDM_CLIENT_ID') && get('ABDM_CLIENT_SECRET') && get('ABDM_PUBLIC_KEY_PEM')),
  };
  return (['his', 'leadsquared', 'abdm'] as const).map((id): ProviderStatus =>
    mock ? { id, area: 'integrations', mode: 'mock' }
      : configured[id] ? { id, area: 'integrations', mode: 'live', note: 'unverified_adapter' }
      : { id, area: 'integrations', mode: 'unconfigured' });
}

/** Channels and payments are expected to work in production; an unset integration is normal (they are switched off). */
const MUST_BE_SET = new Set<ProviderId>(['payments', 'whatsapp', 'sms', 'push']);

export function systemStatus(get: Get, environment: 'demo' | 'production'): SystemStatus {
  const providers = [payments(get), ...notifications(get), video(get), ...integrations(get)];
  const warnings: string[] = [];
  if (environment === 'production') {
    for (const p of providers) {
      if (p.mode === 'mock' || p.mode === 'sandbox') warnings.push(`${p.mode}:${p.id}`);
      else if (p.mode === 'unconfigured' && MUST_BE_SET.has(p.id)) warnings.push(`unconfigured:${p.id}`);
    }
    const origins = (get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.length === 0 || origins.includes('*')) warnings.push('open_cors');
  }
  return { environment, providers, warnings };
}
