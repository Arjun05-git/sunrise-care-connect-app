import { useQuery } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Notifications (supabase/migrations/20261101000014_notifications.sql). Users read their own in-app
 * messages and preferences through RLS; every change is an RPC. Admins read the outbox (staff RLS).
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const nqk = {
  inbox: ['notifications', 'inbox'] as const,
  prefs: ['notifications', 'prefs'] as const,
  outbox: (f: OutboxFilters) => ['notifications', 'outbox', f] as const,
  stats: (from: string, to: string) => ['notifications', 'stats', from, to] as const,
  templates: ['notifications', 'templates'] as const,
  costs: ['notifications', 'costs'] as const,
};

export interface InAppMessage { id: string; template_key: string; rendered_text: string; link: string | null; created_at: string; read_at: string | null }
export function useInbox(enabled = true) {
  const { session } = useAuth();
  return useQuery({
    queryKey: nqk.inbox,
    enabled: enabled && !!session,
    queryFn: async () =>
      (await unwrap(sb().from('notifications').select('id, template_key, rendered_text, link, created_at, read_at').eq('channel', 'in_app')
        .in('status', ['delivered', 'read']).order('created_at', { ascending: false }).limit(30))) as InAppMessage[],
  });
}
export const markRead = async (ids?: string[]) => unwrap(sb().rpc('mark_notifications_read', { p_ids: ids ?? null }));
export const resolveLink = async (token: string) => (await unwrap(sb().rpc('resolve_notification_link', { p_token: token }))) as string;

export interface Prefs { sms: boolean; push: boolean; reminders: boolean }
export function usePrefs() {
  const { session } = useAuth();
  return useQuery({
    queryKey: nqk.prefs,
    enabled: !!session,
    queryFn: async () => {
      const row = (await unwrap(sb().from('notification_prefs').select('sms, push, reminders').maybeSingle())) as Prefs | null;
      return row ?? { sms: true, push: true, reminders: true };
    },
  });
}
export const savePrefs = async (p: Prefs) => unwrap(sb().rpc('set_notification_prefs', { p_sms: p.sms, p_push: p.push, p_reminders: p.reminders }));
export const registerPush = async (s: { endpoint: string; p256dh: string; auth: string }) =>
  unwrap(sb().rpc('register_push_subscription', { p_endpoint: s.endpoint, p_p256dh: s.p256dh, p_auth: s.auth, p_user_agent: navigator.userAgent.slice(0, 200) }));
export const removePush = async (endpoint: string) => unwrap(sb().rpc('remove_push_subscription', { p_endpoint: endpoint }));
export const submitRating = async (appt: string, stars: number, comment: string) => unwrap(sb().rpc('submit_rating', { p_appt: appt, p_stars: stars, p_comment: comment }));

// ---------------------------------------------------------------- admin
export type Channel = 'whatsapp' | 'sms' | 'push' | 'in_app';
export type Status = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
export interface OutboxFilters { channel: Channel | ''; status: Status | ''; template: string; from: string; to: string; page: number }
export interface OutboxRow {
  id: string; created_at: string; send_after: string; template_key: string; channel: Channel; status: Status; to_masked: string | null; attempts: number;
  cost_paise: number; error: string | null; provider: string | null; sent_at: string | null; delivered_at: string | null; seen_at: string | null; failed_at: string | null;
  clicked_at: string | null; language: string; rendered_text: string; event_key: string | null;
}
export const PAGE = 50;
export function useOutbox(f: OutboxFilters) {
  return useQuery({
    queryKey: nqk.outbox(f),
    placeholderData: (prev) => prev,
    queryFn: async () => {
      let q = sb().from('notifications').select('id, created_at, send_after, template_key, channel, status, to_masked, attempts, cost_paise, error, provider, sent_at, delivered_at, seen_at, failed_at, clicked_at, language, rendered_text, event_key', { count: 'exact' })
        .gte('created_at', f.from).lt('created_at', f.to).order('created_at', { ascending: false }).range(f.page * PAGE, f.page * PAGE + PAGE - 1);
      if (f.channel) q = q.eq('channel', f.channel);
      if (f.status) q = q.eq('status', f.status);
      if (f.template) q = q.eq('template_key', f.template);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as OutboxRow[], count: count ?? 0 };
    },
  });
}
export interface ChannelStats { channel: Channel; total: number; queued: number; sent: number; delivered: number; read: number; failed: number; skipped: number; clicked: number; cost_paise: number }
export interface Stats { by_channel: ChannelStats[]; by_template: { template_key: string; total: number; failed: number; cost_paise: number }[]; cost_paise: number; month_cost_paise: number }
export function useStats(from: string, to: string) {
  return useQuery({ queryKey: nqk.stats(from, to), queryFn: async () => (await unwrap(sb().rpc('outbox_stats', { p_from: from, p_to: to }))) as Stats });
}
export const retry = async (id: string) => unwrap(sb().rpc('retry_notification', { p_id: id }));

export interface Template {
  key: string; category: string; audience: string; channels: Channel[]; body_en: string; body_ml: string; sms_body_en: string | null; sms_body_ml: string | null;
  provider_template_name: string; sms_dlt_template_id: string | null; variables: string[]; active: boolean; quiet_hours: boolean; description: string; updated_at: string;
}
export function useTemplates() {
  return useQuery({ queryKey: nqk.templates, queryFn: async () => (await unwrap(sb().from('notification_templates').select('*').order('audience').order('key'))) as Template[] });
}
export const saveTemplate = async (key: string, patch: Partial<Template>, reason: string) => unwrap(sb().rpc('save_notification_template', { p_key: key, p_patch: patch, p_reason: reason }));
export function useCosts() {
  return useQuery({
    queryKey: nqk.costs,
    queryFn: async () => ((await unwrap(sb().from('app_settings').select('value').eq('key', 'notification_costs').maybeSingle())) as { value: { whatsapp: number; sms: number; push: number } } | null)?.value ?? { whatsapp: 13, sms: 25, push: 0 },
  });
}
export const saveCosts = async (c: { whatsapp: number; sms: number; push: number }, reason: string) => unwrap(sb().rpc('set_notification_costs', { p_costs: c, p_reason: reason }));

/** Sample values for template previews – never real patient data. */
export const SAMPLE: Record<string, string> = {
  name: 'Anjali', doctor: 'Dr. Arun Nair', date: '02 Nov 2026', time: '10:30 AM', ref: 'SC-7KQ2MD', link: 'https://care.sunrise.example/l/3f9c…', amount: '800', response: 'accepted', otp: '123456', minutes: '10',
};
export const render = (body: string, vars: Record<string, string> = SAMPLE) => body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
