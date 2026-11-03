// NotificationService contracts. A ChannelAdapter sends one already-rendered message; the dispatcher
// (service.ts) decides retries, cost and receipts. No adapter ever sees clinical data: messages are
// built from whitelisted variables only (see guard.ts and the templates_vars_whitelist constraint).
export type Channel = 'whatsapp' | 'sms' | 'push' | 'in_app';

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
/** Capacitor app on a phone (FCM token; iOS via FCM → APNs). */
export interface DeviceToken { platform: 'android' | 'ios'; token: string }

/** One outbox row as returned by claim_notifications(). */
export interface OutboundMessage {
  id: string;
  channel: Channel;
  template_key: string;
  variables: Record<string, string | number>;
  text: string;
  language: 'en' | 'ml';
  attempts: number;
  phone: string | null;
  category: 'transactional' | 'reminder' | 'service' | 'auth';
  whatsapp_template: string;
  sms_dlt_template_id: string | null;
  push_title: string;
  link: string | null;
  subscriptions: PushSubscription[] | null;
  devices?: DeviceToken[] | null;
}

export interface SendResult {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  /** what the provider charges for this message, in paise */
  costPaise?: number;
  /** the provider confirmed delivery synchronously (in-app, push accepted by the push service) */
  delivered?: boolean;
  error?: string;
  /** don't retry (invalid number, not on WhatsApp, template rejected, …) */
  permanent?: boolean;
  /** push: endpoints that are gone (404 / 410) – the subscription is removed */
  goneEndpoints?: string[];
  /** push: native device tokens FCM no longer knows – removed */
  goneTokens?: string[];
}

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly provider: string;
  send(m: OutboundMessage, rates: Rates): Promise<SendResult>;
}

/** Paise per message (SMS: per 160 / 70-character part). From app_settings.notification_costs. */
export interface Rates { whatsapp: number; sms: number; push: number }
