// HIS adapters. HttpHisAdapter is a STUB for a REST HIS gateway (to be mapped to Sunrise's HIS once its API
// spec is shared): bearer key, facility id, Idempotency-Key on every write, MRN in the patient response.
import { AdapterError, type HisAdapter, type HisDoctorRow, type HisPatient, type SendOutcome } from './types.ts';

export interface HisConfig { baseUrl: string; apiKey: string; facilityId: string; timeoutMs?: number; fetch?: typeof fetch }

/** Maps an HTTP response to an outcome: 2xx ok; 408 / 429 / 5xx retry; other 4xx permanent. */
export async function outcome(res: Response, ref: (body: Record<string, unknown>) => string): Promise<SendOutcome> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, externalRef: ref(body) || `http_${res.status}`, result: body };
  const retry = res.status === 408 || res.status === 429 || res.status >= 500;
  return { ok: false, error: `http_${res.status}${typeof body.code === 'string' ? `:${body.code}` : ''}`.slice(0, 120), permanent: !retry };
}

export class HttpHisAdapter implements HisAdapter {
  readonly name = 'his_http';
  constructor(private cfg: HisConfig) {}
  private async call(method: string, path: string, body: unknown, key?: string): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      return await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`, 'X-Facility-Id': this.cfg.facilityId, 'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new AdapterError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
  async upsertPatient(p: HisPatient) {
    const res = await this.call(p.mrn ? 'PUT' : 'POST', p.mrn ? `/patients/${encodeURIComponent(p.mrn)}` : '/patients', {
      externalId: p.patient_ref, name: p.name, dateOfBirth: p.date_of_birth, gender: p.gender, mobile: p.mobile, email: p.email, address: p.address, abhaNumber: p.abha_number,
    }, p.idempotency_key);
    const o = await outcome(res, (b) => String(b.mrn ?? b.id ?? ''));
    return o.ok ? { ...o, result: { mrn: String((o.result ?? {}).mrn ?? p.mrn ?? '') } } : o;
  }
  pushConsultationSummary(p: Parameters<HisAdapter['pushConsultationSummary']>[0]) {
    return this.call('POST', `/encounters/${encodeURIComponent(p.encounter_ref)}/summary`, p, p.idempotency_key).then((r) => outcome(r, (b) => String(b.id ?? '')));
  }
  pushPrescription(p: Parameters<HisAdapter['pushPrescription']>[0]) {
    return this.call('POST', '/prescriptions', p, p.idempotency_key).then((r) => outcome(r, (b) => String(b.id ?? p.rx_no)));
  }
  postBilling(p: Parameters<HisAdapter['postBilling']>[0]) {
    return this.call('POST', '/billing/charges', p, p.idempotency_key).then((r) => outcome(r, (b) => String(b.billNo ?? b.id ?? '')));
  }
  postRefund(p: Parameters<HisAdapter['postRefund']>[0]) {
    return this.call('POST', '/billing/refunds', p, p.idempotency_key).then((r) => outcome(r, (b) => String(b.id ?? '')));
  }
  async fetchDoctorMaster(): Promise<HisDoctorRow[]> {
    const res = await this.call('GET', '/masters/doctors', undefined);
    if (!res.ok) throw new AdapterError(`http_${res.status}`);
    const rows = (await res.json()) as { code?: string; registrationNo?: string; name?: string; departmentCode?: string }[];
    return rows.filter((r) => r.code).map((r) => ({ his_doctor_code: r.code!, registration_no: r.registrationNo ?? '', name: r.name, department_code: r.departmentCode }));
  }
}

/** Local / test HIS: deterministic MRNs, an in-memory log, and failure switches for the outbox tests. */
export const mockHisLog: { op: string; key: string; body: unknown }[] = [];
export class MockHisAdapter implements HisAdapter {
  readonly name = 'his_mock';
  constructor(private doctors: HisDoctorRow[] = []) {}
  private ok(op: string, key: string, body: unknown, ref: string, result?: Record<string, unknown>): SendOutcome {
    mockHisLog.push({ op, key, body });
    return { ok: true, externalRef: ref, result };
  }
  async upsertPatient(p: HisPatient) {
    // a name containing "HISDOWN" simulates an outage (temporary), "HISREJECT" a validation error (permanent)
    if (/HISDOWN/.test(p.name)) return { ok: false as const, error: 'http_503', permanent: false };
    if (/HISREJECT/.test(p.name)) return { ok: false as const, error: 'http_422:invalid_patient', permanent: true };
    const mrn = p.mrn ?? `SUN-${(await sha(p.patient_ref)).slice(0, 8).toUpperCase()}`;
    return this.ok('patient', p.idempotency_key, p, mrn, { mrn });
  }
  async pushConsultationSummary(p: Parameters<HisAdapter['pushConsultationSummary']>[0]) { return this.ok('summary', p.idempotency_key, p, `ENC-${p.encounter_ref}-v${p.version}`); }
  async pushPrescription(p: Parameters<HisAdapter['pushPrescription']>[0]) { return this.ok('prescription', p.idempotency_key, p, p.rx_no); }
  async postBilling(p: Parameters<HisAdapter['postBilling']>[0]) { return this.ok('billing', p.idempotency_key, p, `BILL-${p.receipt_no}`); }
  async postRefund(p: Parameters<HisAdapter['postRefund']>[0]) { return this.ok('refund', p.idempotency_key, p, `CRN-${p.refund_ref.slice(0, 8)}`); }
  async fetchDoctorMaster() { return this.doctors; }
}
async function sha(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
