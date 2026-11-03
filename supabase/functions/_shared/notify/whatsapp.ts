// WhatsApp Business Cloud API (Meta). Messages outside a 24-hour session must be pre-approved
// templates: `provider_template_name` + language (en / ml), body parameters by name.
import { msisdn } from './guard.ts';
import type { ChannelAdapter, OutboundMessage, Rates, SendResult } from './types.ts';

// Meta error codes that won't succeed on retry (recipient not on WhatsApp, template problems, …)
const PERMANENT = new Set([131026, 131021, 131030, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 100, 190]);

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly provider = 'whatsapp_cloud';
  constructor(private cfg: { token: string; phoneNumberId: string; apiVersion?: string; fetch?: typeof fetch }) {}

  body(m: OutboundMessage) {
    const to = msisdn(m.phone);
    if (!to) return null;
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: m.whatsapp_template,
        language: { code: m.language === 'ml' ? 'ml' : 'en' },
        components: [{
          type: 'body',
          parameters: Object.entries(m.variables).map(([k, v]) => ({ type: 'text', parameter_name: k, text: String(v) })),
        }],
      },
    };
  }

  async send(m: OutboundMessage, rates: Rates): Promise<SendResult> {
    const body = this.body(m);
    if (!body) return { ok: false, provider: this.provider, error: 'invalid_number', permanent: true };
    const res = await (this.cfg.fetch ?? fetch)(`https://graph.facebook.com/${this.cfg.apiVersion ?? 'v20.0'}/${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { code?: number; message?: string } };
    if (res.ok && json.messages?.[0]?.id) return { ok: true, provider: this.provider, providerMessageId: json.messages[0].id, costPaise: rates.whatsapp };
    const code = json.error?.code ?? res.status;
    return { ok: false, provider: this.provider, error: `wa_${code}`, permanent: PERMANENT.has(code) || (res.status >= 400 && res.status < 500 && res.status !== 429) };
  }
}

/** Webhook statuses → our receipt states. */
export function whatsappStatuses(payload: unknown): { id: string; status: 'delivered' | 'read' | 'failed'; error?: string }[] {
  const out: { id: string; status: 'delivered' | 'read' | 'failed'; error?: string }[] = [];
  const entries = (payload as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { code: number }[] }[] } }[] }[] })?.entry ?? [];
  for (const e of entries) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
    if (s.status === 'delivered' || s.status === 'read' || s.status === 'failed') out.push({ id: s.id, status: s.status, error: s.errors?.[0] ? `wa_${s.errors[0].code}` : undefined });
  }
  return out;
}
