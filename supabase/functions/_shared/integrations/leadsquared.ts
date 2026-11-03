// LeadSquared adapters. The HTTP adapter is a STUB for the v2 API: Lead.Capture (upsert by phone) then
// ProspectActivity.Create with the account's custom activity code for the event. Only name, mobile, city
// and source are ever sent (consented, non-clinical).
import { outcome } from './his.ts';
import type { LeadEvent, LeadSquaredAdapter, SendOutcome } from './types.ts';

export interface LeadSquaredConfig {
  host: string; accessKey: string; secretKey: string;
  /** e.g. {"signed_up":201,"booked":202,"paid":203,"completed":204,"cancelled":205} – configured in LeadSquared */
  activityCodes: Record<string, number>;
  fetch?: typeof fetch;
}

/** LeadSquared wants "yyyy-MM-dd HH:mm:ss" in UTC. */
export const lsqTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);

export function leadAttributes(e: LeadEvent) {
  return [
    { Attribute: 'FirstName', Value: e.lead.name },
    { Attribute: 'Phone', Value: e.lead.mobile ?? '' },
    { Attribute: 'mx_City', Value: e.lead.city ?? '' },
    { Attribute: 'Source', Value: e.lead.source },
    { Attribute: 'SearchBy', Value: 'Phone' },
  ];
}

export class HttpLeadSquaredAdapter implements LeadSquaredAdapter {
  readonly name = 'leadsquared_http';
  constructor(private cfg: LeadSquaredConfig) {}
  private url(path: string) {
    return `https://${this.cfg.host}/v2/${path}?accessKey=${encodeURIComponent(this.cfg.accessKey)}&secretKey=${encodeURIComponent(this.cfg.secretKey)}`;
  }
  async captureEvent(e: LeadEvent): Promise<SendOutcome> {
    if (!e.lead.mobile) return { ok: false, error: 'no_mobile', permanent: true };
    const code = this.cfg.activityCodes[e.event];
    if (!code) return { ok: false, error: `no_activity_code:${e.event}`, permanent: true };
    const f = this.cfg.fetch ?? fetch;
    const lead = await outcome(
      await f(this.url('LeadManagement.svc/Lead.Capture'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leadAttributes(e)) }),
      (b) => String((b.Message as { Id?: string } | undefined)?.Id ?? ''),
    );
    if (!lead.ok) return lead;
    return outcome(
      await f(this.url('ProspectActivity.svc/Create'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ RelatedProspectId: lead.externalRef, ActivityEvent: code, ActivityNote: `ref:${e.idempotency_key}`, ActivityDateTime: lsqTime(e.occurred_at) }),
      }),
      (b) => String((b.Message as { Id?: string } | undefined)?.Id ?? lead.externalRef),
    );
  }
}

export const mockLeadLog: LeadEvent[] = [];
export class MockLeadSquaredAdapter implements LeadSquaredAdapter {
  readonly name = 'leadsquared_mock';
  async captureEvent(e: LeadEvent): Promise<SendOutcome> {
    if (!e.lead.mobile) return { ok: false, error: 'no_mobile', permanent: true };
    mockLeadLog.push(e);
    return { ok: true, externalRef: `LSQ-${e.event}-${mockLeadLog.length}` };
  }
}
