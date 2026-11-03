// MSG91 Flow API (India, DLT): the flow / template id is the DLT-registered template; variables are
// passed by name and substituted by MSG91 into the registered text.
import { msisdn, smsParts } from './guard.ts';
import type { ChannelAdapter, OutboundMessage, Rates, SendResult } from './types.ts';

export class Msg91Adapter implements ChannelAdapter {
  readonly channel = 'sms' as const;
  readonly provider = 'msg91';
  constructor(private cfg: { authKey: string; fetch?: typeof fetch }) {}

  async send(m: OutboundMessage, rates: Rates): Promise<SendResult> {
    const to = msisdn(m.phone);
    if (!to) return { ok: false, provider: this.provider, error: 'invalid_number', permanent: true };
    if (!m.sms_dlt_template_id) return { ok: false, provider: this.provider, error: 'no_dlt_template', permanent: true };
    const res = await (this.cfg.fetch ?? fetch)('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.cfg.authKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: m.sms_dlt_template_id, short_url: '0', recipients: [{ mobiles: to, ...Object.fromEntries(Object.entries(m.variables).map(([k, v]) => [k, String(v)])) }] }),
    });
    const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (res.ok && json.type === 'success' && json.message) return { ok: true, provider: this.provider, providerMessageId: json.message, costPaise: rates.sms * smsParts(m.text) };
    return { ok: false, provider: this.provider, error: `msg91_${res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 };
  }
}

/** MSG91 delivery reports: [{ requestId, report: [{ status: 1|2|…, desc }] }] or flat { request_id, status }. */
export function msg91Reports(payload: unknown): { id: string; status: 'delivered' | 'failed'; error?: string }[] {
  const list = Array.isArray(payload) ? payload : [payload];
  const out: { id: string; status: 'delivered' | 'failed'; error?: string }[] = [];
  for (const r of list as { requestId?: string; request_id?: string; status?: string | number; report?: { status: string | number; desc?: string }[] }[]) {
    const id = r?.requestId ?? r?.request_id;
    const st = r?.report?.[0]?.status ?? r?.status;
    if (!id || st === undefined) continue;
    const s = String(st).toLowerCase();
    if (s === '1' || s === 'delivered') out.push({ id, status: 'delivered' });
    else if (['2', '16', 'failed', 'rejected', 'ndnc'].includes(s)) out.push({ id, status: 'failed', error: `msg91_dlr_${s}` });
  }
  return out;
}
