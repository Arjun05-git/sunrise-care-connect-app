// Local / test providers: record what would be sent and answer like the real ones. Numbers ending in
// 99 fail permanently ("invalid number"), 98 fail temporarily – to exercise retries and the Outbox.
import { msisdn, smsParts } from './guard.ts';
import type { Channel, ChannelAdapter, OutboundMessage, Rates, SendResult } from './types.ts';

export const mockSent: { channel: Channel; to: string | null; text: string; at: string }[] = [];

export class MockAdapter implements ChannelAdapter {
  readonly provider: string;
  constructor(readonly channel: Channel) { this.provider = `mock_${channel}`; }
  async send(m: OutboundMessage, rates: Rates): Promise<SendResult> {
    if (this.channel === 'push') {
      const n = (m.subscriptions?.length ?? 0) + (m.devices?.length ?? 0);
      if (!n) return { ok: false, provider: this.provider, error: 'no_subscription', permanent: true };
      mockSent.push({ channel: 'push', to: `${n} device(s)`, text: m.text, at: new Date().toISOString() });
      return { ok: true, provider: this.provider, providerMessageId: `mock-${crypto.randomUUID()}`, costPaise: rates.push, delivered: true };
    }
    const to = msisdn(m.phone);
    if (!to || to.endsWith('99')) return { ok: false, provider: this.provider, error: 'invalid_number', permanent: true };
    if (to.endsWith('98')) return { ok: false, provider: this.provider, error: 'provider_timeout', permanent: false };
    mockSent.push({ channel: this.channel, to, text: m.text, at: new Date().toISOString() });
    const cost = this.channel === 'sms' ? rates.sms * smsParts(m.text) : this.channel === 'whatsapp' ? rates.whatsapp : 0;
    // the mock "network" delivers at once; real providers report delivery through the webhook
    return { ok: true, provider: this.provider, providerMessageId: `mock-${crypto.randomUUID()}`, costPaise: cost, delivered: true };
  }
}
