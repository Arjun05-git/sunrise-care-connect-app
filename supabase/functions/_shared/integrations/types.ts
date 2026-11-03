// Integration contracts. Every adapter has a mock (local stack, tests) and an HTTP implementation that is a
// STUB: written against the vendors' documented APIs but not yet exercised against Sunrise's real systems.
// Payloads come from integration_payload() (minimum necessary); adapters never read the database.

/** Outcome of one send. Temporary failures are retried with back-off; permanent ones fail at once. */
export type SendOutcome =
  | { ok: true; externalRef: string; result?: Record<string, unknown> }
  | { ok: false; error: string; permanent: boolean };

// ---------------------------------------------------------------- HIS
export interface HisPatient {
  patient_ref: string; mrn: string | null; name: string; date_of_birth: string; gender: string; mobile: string | null;
  email: string | null; address: string | null; abha_number: string | null; idempotency_key: string;
}
export interface HisEncounterBase { mrn: string; encounter_ref: string; hospital_code: string | null; doctor_code: string | null; idempotency_key: string }
export interface HisConsultationSummary extends HisEncounterBase {
  start_at: string; mode: string; consult_type: string; version: number; chief_complaint: string; history: string; examination: string;
  diagnoses: { code?: string; text?: string }[]; advice: string; investigations: string; follow_up_date: string | null;
}
export interface HisPrescription extends HisEncounterBase {
  rx_no: string; version: number; replaces_rx_no: string | null; verification_code: string; signed_at: string; pdf_path: string | null;
  items: { drug_code: string; name: string; strength: string; form: string; dose: string; frequency: string; duration: string; route: string; instructions: string }[];
}
export interface HisBillingPayment extends HisEncounterBase {
  service_code: string; receipt_no: string; amount: number; currency: 'INR'; method: string | null; gateway_payment_id: string | null; paid_at: string;
}
export interface HisBillingRefund extends Omit<HisEncounterBase, 'doctor_code'> {
  receipt_no: string; refund_ref: string; amount: number; currency: 'INR'; gateway_refund_id: string | null; refunded_at: string;
}
export interface HisDoctorRow { his_doctor_code: string; registration_no: string; name?: string; department_code?: string }

export interface HisAdapter {
  readonly name: string;
  /** Creates or updates the patient; the result carries the HIS MRN. */
  upsertPatient(p: HisPatient): Promise<SendOutcome>;
  pushConsultationSummary(p: HisConsultationSummary): Promise<SendOutcome>;
  pushPrescription(p: HisPrescription): Promise<SendOutcome>;
  postBilling(p: HisBillingPayment): Promise<SendOutcome>;
  postRefund(p: HisBillingRefund): Promise<SendOutcome>;
  /** Doctor master (nightly pull). */
  fetchDoctorMaster(): Promise<HisDoctorRow[]>;
}

// ---------------------------------------------------------------- LeadSquared
export type LeadEventType = 'signed_up' | 'booked' | 'paid' | 'completed' | 'cancelled';
/** Exactly what Sunrise agreed to share – nothing clinical, no doctor or department. */
export interface LeadEvent {
  event: LeadEventType; occurred_at: string; idempotency_key: string;
  lead: { name: string; mobile: string | null; city: string | null; source: string };
}
export interface LeadSquaredAdapter { readonly name: string; captureEvent(e: LeadEvent): Promise<SendOutcome> }

// ---------------------------------------------------------------- ABDM (ABHA)
export type AbhaMethod = 'aadhaar_otp' | 'mobile_otp';
export interface AbhaProfile { abha_number: string; abha_address: string | null; name: string; gender: string | null; year_of_birth: number | null }
export interface AbdmAdapter {
  readonly name: string;
  /** Sends an OTP for the ABHA number / address; returns ABDM's transaction id. */
  startVerification(input: { id: string; method: AbhaMethod }): Promise<{ txnId: string }>;
  confirmVerification(input: { txnId: string; otp: string }): Promise<AbhaProfile>;
}

export class AdapterError extends Error {
  constructor(public code: string, public permanent = false) {
    super(code);
  }
}
