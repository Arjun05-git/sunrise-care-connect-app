// NotificationService: claims due outbox rows, checks them, sends through the channel adapters, and
// records the result (provider id, cost, delivered / retry / failed). Runs every minute (scheduler).
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.ts';
import { checkMessage } from './guard.ts';
import { MockAdapter } from './mock.ts';
import { Msg91Adapter } from './msg91.ts';
import type { Channel, ChannelAdapter, OutboundMessage, Rates, SendResult } from './types.ts';
import { WebPushAdapter } from './webpush.ts';
import { CombinedPushAdapter, FcmAdapter } from './fcm.ts';
import { WhatsAppCloudAdapter } from './whatsapp.ts';

/**
 * Real providers where their keys are configured; `NOTIFY_PROVIDER=mock` (local stack, tests) uses the
 * mock adapters for every channel. A channel without configuration fails its messages permanently
 * ("channel_not_configured") so the Outbox shows it instead of silently dropping messages.
 */
export function adaptersFromEnv(): Partial<Record<Channel, ChannelAdapter>> {
  if (env('NOTIFY_PROVIDER') === 'mock') return { whatsapp: new MockAdapter('whatsapp'), sms: new MockAdapter('sms'), push: new MockAdapter('push') };
  const a: Partial<Record<Channel, ChannelAdapter>> = {};
  if (env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID')) a.whatsapp = new WhatsAppCloudAdapter({ token: env('WHATSAPP_TOKEN')!, phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID')!, apiVersion: env('WHATSAPP_API_VERSION') });
  if (env('MSG91_AUTH_KEY')) a.sms = new Msg91Adapter({ authKey: env('MSG91_AUTH_KEY')! });
  const web = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
    ? new WebPushAdapter({ publicKey: env('VAPID_PUBLIC_KEY')!, privateKey: env('VAPID_PRIVATE_KEY')!, subject: env('VAPID_SUBJECT') ?? 'mailto:care@sunrise.example' }) : undefined;
  // FCM_SERVICE_ACCOUNT: the Firebase service-account JSON (project_id, client_email, private_key)
  const sa = env('FCM_SERVICE_ACCOUNT') ? (JSON.parse(env('FCM_SERVICE_ACCOUNT')!) as { project_id: string; client_email: string; private_key: string }) : null;
  const fcm = sa ? new FcmAdapter({ projectId: sa.project_id, clientEmail: sa.client_email, privateKeyPem: sa.private_key }) : undefined;
  if (web || fcm) a.push = new CombinedPushAdapter(web, fcm);
  return a;
}

export async function rates(svc: SupabaseClient): Promise<Rates> {
  const { data } = await svc.from('app_settings').select('value').eq('key', 'notification_costs').maybeSingle();
  const v = (data?.value ?? {}) as Partial<Rates>;
  return { whatsapp: v.whatsapp ?? 13, sms: v.sms ?? 25, push: v.push ?? 0 };
}

export interface DispatchReport { claimed: number; sent: number; retry: number; failed: number }

export async function dispatch(svc: SupabaseClient, adapters = adaptersFromEnv(), batch = 100): Promise<DispatchReport> {
  const report: DispatchReport = { claimed: 0, sent: 0, retry: 0, failed: 0 };
  const { data, error } = await svc.rpc('claim_notifications', { p_limit: batch });
  if (error) throw new Error(`claim: ${error.message}`);
  const msgs = (data ?? []) as OutboundMessage[];
  report.claimed = msgs.length;
  if (!msgs.length) return report;
  const r = await rates(svc);

  await Promise.all(msgs.map(async (m) => {
    let res: SendResult;
    const bad = checkMessage(m);
    if (bad) res = { ok: false, provider: 'guard', error: bad, permanent: true };
    else if (m.channel === 'in_app') res = { ok: true, provider: 'app', delivered: true, costPaise: 0 };
    else if (!adapters[m.channel]) res = { ok: false, provider: 'none', error: 'channel_not_configured', permanent: true };
    else {
      try {
        res = await adapters[m.channel]!.send(m, r);
      } catch (e) {
        res = { ok: false, provider: adapters[m.channel]!.provider, error: `exception:${(e as Error).message}`.slice(0, 120), permanent: false };
      }
    }
    for (const ep of res.goneEndpoints ?? []) await svc.rpc('push_subscription_result', { p_endpoint: ep, p_ok: false, p_gone: true });
    for (const tok of res.goneTokens ?? []) await svc.rpc('device_token_result', { p_token: tok, p_ok: false, p_gone: true });
    if (res.ok) {
      await svc.rpc('mark_notification_sent', { p_id: m.id, p_provider: res.provider, p_message_id: res.providerMessageId ?? null, p_cost_paise: res.costPaise ?? 0, p_delivered: !!res.delivered });
      report.sent++;
    } else {
      const { data: outcome } = await svc.rpc('mark_notification_failed', { p_id: m.id, p_provider: res.provider, p_error: res.error ?? 'error', p_permanent: !!res.permanent });
      if (outcome === 'retry') report.retry++;
      else report.failed++;
    }
  }));
  return report;
}
