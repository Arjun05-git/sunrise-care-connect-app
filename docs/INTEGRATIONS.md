# Integrations: HIS, LeadSquared, ABDM

> **Status: stubs.** The interfaces, outbox, dispatcher, admin screen and mock adapters are complete and tested. The HTTP adapters follow each vendor's published request shapes, but **none has been run against the real system yet**. Sunrise's HIS vendor, the LeadSquared account and ABDM sandbox credentials are needed for that.

All three integrations are switched off by default in the migration. The local seed turns HIS and LeadSquared on so they can be seen working with the mocks.

## Rules confirmed by Sunrise (30 Oct 2026)

| System | What is sent | When |
|---|---|---|
| **HIS: patient master** | Name, date of birth, gender, mobile, email, address, ABHA number, our patient reference. HIS returns the MRN, which is stored in `patients.his_mrn` (only if it is still empty). | The first confirmed booking, then whenever one of those fields changes for a patient with real bookings. Linking or unlinking an ABHA counts as a change. |
| **HIS: consultation summary + prescription** | The signed note and prescription, including each addendum, with the HIS doctor code and the MRN | When the prescription is signed (draft → final) |
| **HIS: billing** | A charge on payment capture, and a refund on refund payout, with the receipt number and amount | On capture / on payout |
| **HIS: doctor master** | Pulled, not pushed. Matched on registration number to fill `doctors.his_doctor_code`. | Nightly. HIS is the source of truth for codes, **not** for verification, which stays in the admin console. |
| **LeadSquared** | **Name, mobile, city and the event only**: `signed_up`, `booked`, `paid`, `completed`, `cancelled`. Never anything clinical: no symptoms, doctor, department, diagnosis or fee. | Only for account holders with the **marketing consent**. This is a new, optional consent that is never pre-ticked, and withdrawing it stops further events. |
| **ABDM (ABHA)** | Verify an ABHA number or address by OTP (ABHA mobile or Aadhaar mobile), then link it to one patient profile | Patient's choice, on the family member page. It is **never required to book**. Behind the `abdm_enabled` flag, which is **off**. |

## How it works

```
appointments / patients / prescriptions / payments / refunds
        │  triggers (only when the system's flag is on; LeadSquared also needs marketing consent)
        ▼
integration_events  (system, kind, entity_id, idempotency_key, status, attempts, last_error, external_ref)
        │  integrations-dispatch (service role, every minute; locally every 10 s)
        ▼
integration_payload(id)  → built at send time from the current record → adapter → complete / fail
```

**Outbox (`integration_events`)**
- Rows hold **references only**. There is no payload column, so no personal or clinical data sits in the queue. Each payload is built when the event is sent, so a retry after the record has been fixed sends the corrected data.
- `idempotency_key` is unique:
  - `his:patient:<id>:<identity hash>`
  - `his:summary:<rx>`, `his:rx:<rx>`
  - `his:pay:<payment>`, `his:refund:<refund>`
  - `lsq:<event>:<entity>`

  Duplicate triggers do nothing, and the key is also sent as the `Idempotency-Key` header.

**Dispatcher**
- Patient masters are sent first in each batch, so the other events in the batch can use the MRN.
- If an event needs an MRN that isn't there yet, the payload returns `wait`. The event is re-queued in 2 minutes without using up an attempt, and a patient-master event is queued for that patient.
- Results:

  | Result | What happens |
  |---|---|
  | `skip` | Flag turned off, consent withdrawn, or record gone. The event is marked *skipped*. |
  | `temporary` | Network error, timeout, 408, 429 or 5xx. The event is retried after 1, 5, 15, 60 and 180 minutes, up to 6 attempts in total, and then marked *failed*. |
  | `permanent` | Any other 4xx, or an adapter that isn't configured. The event is marked *failed* at once and can be retried from the admin screen. |

- Leases last 5 minutes, so an event isn't lost if a dispatcher run crashes.

**Privacy**
- LeadSquared payloads are checked in both the DB tests and the e2e run.
- `integration_events` is admin-only through RLS, and it is not copied to the audit log.
- Error text is stored as a short code, such as `http_422:invalid_patient`.

## Adapters (`supabase/functions/_shared/integrations/`)

| File | Contract | HTTP stub | Mock (`INTEGRATIONS_PROVIDER=mock`) |
|---|---|---|---|
| `types.ts` | `HisAdapter`: `upsertPatient`, `pushConsultationSummary`, `pushPrescription`, `postBilling`, `postRefund`, `fetchDoctorMaster`. `LeadSquaredAdapter.captureEvent`. `AbdmAdapter`: `startVerification`, `confirmVerification`. | | |
| `his.ts` | | Generic REST: bearer key, `X-Facility-Id`, `Idempotency-Key`, 15 s timeout. Endpoints `/patients`, `/encounters/{ref}/summary`, `/prescriptions`, `/billing/charges`, `/billing/refunds`, `/masters/doctors`. **Replace the paths and field names with the HIS vendor's spec.** | Keeps an existing MRN or makes one up as `SUN-<hash>`. A patient name containing `HISDOWN` gives a 503, and `HISREJECT` gives a 422. |
| `leadsquared.ts` | | `Lead.Capture` (search by phone), then `ProspectActivity.Create` with the activity code for the event from `LSQ_ACTIVITY_CODES`. The note carries `ref:<key>` for de-duplication. | Records each call. |
| `abdm.ts` | | ABHA v3 sandbox: session token, the ID encrypted with RSA-OAEP (SHA-1) using the ABDM public key, then `/v3/profile/login/request/otp` and `/verify` | OTP is `123456`. |

`service.ts` picks the adapters from the environment and runs the dispatch and the doctor-master sync. `txn.ts` seals the ABHA OTP transaction. The seal is HMAC-signed, bound to the user and the patient, and expires after 10 minutes, so a transaction id from ABDM can't be replayed on another profile.

### Edge functions
- **`integrations-dispatch`** (service role only):
  - `{}` sends due events;
  - `{"job":"doctor_master"}` runs the nightly HIS doctor sync.
- **`abha`** (signed-in user):
  - returns 403 `abdm_disabled` while the flag is off;
  - `{"action":"start","patient_id","id","method":"mobile_otp|aadhaar_otp"}` checks that the profile is the user's own (through RLS) and returns a sealed transaction;
  - `{"action":"confirm","txn","otp"}` verifies the OTP and calls the service-only `link_abha`;
  - errors: `invalid_abha`, `invalid_otp`, `txn_expired`, `abha_in_use`, `not_found`.

### Configuration (hosted)
```
supabase secrets set HIS_BASE_URL=https://… HIS_API_KEY=… HIS_FACILITY_ID=… \
  LSQ_HOST=https://api-in21.leadsquared.com LSQ_ACCESS_KEY=… LSQ_SECRET_KEY=… \
  LSQ_ACTIVITY_CODES='{"signed_up":201,"booked":202,"paid":203,"completed":204,"cancelled":205}' \
  ABDM_CLIENT_ID=… ABDM_CLIENT_SECRET=… ABDM_PUBLIC_KEY_PEM="$(cat abdm_public.pem)" \
  ABDM_GATEWAY_URL=https://dev.abdm.gov.in/gateway ABDM_ABHA_URL=https://abhasbx.abdm.gov.in/abha/api \
  ABHA_TXN_SECRET=$(openssl rand -hex 32)
```
- The `LSQ_ACTIVITY_CODES` values above are **examples**. Create the custom activities in LeadSquared and use their codes.
- Schedule both jobs with the service key (pg_cron + pg_net):
  - `integrations-dispatch {}` every minute;
  - `integrations-dispatch {"job":"doctor_master"}` once a night, e.g. 02:30 IST.
- Turn systems on in **Admin → Integrations**. Each change needs a reason and is audited.
  - If you turn on a system whose secrets aren't set, its events fail with *Not configured*. They are visible on that screen rather than silently dropped.
  - Turn ABDM on only once the keys work. A warning is shown.
- Locally, `npm run stack:up` sets `INTEGRATIONS_PROVIDER=mock`. The gateway dispatches every 10 s (`INTEGRATIONS_MS`) and runs the doctor master 20 s after start-up.

## Admin → Integrations (`/a/integrations`, admin only)
- **System status card (top of the page):** which services are simulated and which are real, so a mock can never be mistaken for a live service. It comes from the admin-only `system-status` edge function, which reports the environment the *database* declares (`app.environment`) and each provider's mode: **MOCK** (simulated, nothing real is sent or charged), **SANDBOX** (a real service used for testing: Razorpay test keys, the free public Jitsi server), **LIVE**, or **NOT SET UP**. It never shows a key or value. In a **production** environment, any mock, sandbox, missing payment / message channel or open CORS setting appears in a red warning at the top of the card; a demo environment shows none. A live HIS / LeadSquared / ABDM adapter is marked "not yet tested against the real system" until it has run against the real service.
- **One card per system:**
  - an on/off switch, saved through a reason dialog;
  - counts of sent, queued, failed and skipped events;
  - when the last event was sent.
- **Doctor master:**
  - the time of the last nightly sync, with rows, matched and newly linked counts;
  - HIS codes that matched no doctor;
  - registration conflicts.
- **Events table:**
  - filters by system and status, with paging;
  - columns: type, event, status, a readable error, attempts and external ref;
  - **Retry** for failed events, which resets their attempts.

## Patient side
- **Consent and Profile → Consents:** "Offers and health camp updates from Sunrise (optional)". It is never pre-ticked and can be withdrawn at any time. Its text says only name, mobile and city are shared.
- **Family member page:** the **ABHA** card. It shows only while ABDM is on.
  1. Enter the ABHA number (`91-1234-5678-9012`) or address (`name@abdm`).
  2. Choose an OTP to the ABHA mobile or the Aadhaar mobile.
  3. Enter the OTP. The ABHA is verified and linked.
  - The linked ABHA shows with its verification date and an **Unlink** button.
  - One ABHA can be linked to only one active profile.

## Database (`20261101000016_marketing_consent.sql`, `20261101000017_integrations.sql`)
- **Consent:** `consent_type` gains `marketing`. A new marketing version never forces re-consent.
- **Patients:** new columns `his_synced_at`, `abha_address`, `abha_verified_at` and `abha_linked_by`. The ABHA number has a format check and is unique among active profiles.
- **Tables:**
  - `integration_events`;
  - `device_tokens`, for native push: Android/iOS FCM tokens, at most 10 per user, removed when FCM reports them gone. The token is redacted in the audit log.
- **Functions:**
  - flags and consent: `integration_on`, `marketing_opted_in`;
  - outbox: `enqueue_integration`, `claim_integration_events`, `integration_payload`, `complete_integration_event`, `fail_integration_event`, `ensure_patient_upsert`;
  - HIS: `his_apply_doctor_master`;
  - ABHA: `link_abha` (service only), `unlink_abha`;
  - admin: `admin_integration_stats`, `admin_integration_events`, `admin_retry_integration`, `admin_set_integrations`;
  - devices: `register_device_token`, `remove_device_token`, `device_token_result`.

## Tests
- **`npm run db:test` → `integrations_flow.sql`, 57 checks:**
  - flags and consent gating;
  - every trigger, and idempotency;
  - payload contents, including that nothing clinical goes to LeadSquared;
  - wait, skip, back-off and permanent failure;
  - MRN write-once;
  - doctor-master matching and conflicts;
  - ABHA flag, format, ownership and uniqueness;
  - device tokens;
  - access: patients can't claim events, build payloads or link an ABHA directly, and coordinators can't see stats.
- **`npm test`:** 14 adapter tests:
  - HTTP status → retry or permanent;
  - HIS request shape;
  - LeadSquared capture plus activity, and the missing-code case;
  - ABHA normalisation and the mock OTP;
  - the sealed transaction (tamper, expiry, wrong user);
  - dispatcher ordering, wait and skip.
- **`npm run e2e:integrations`:**
  1. The patient opts in to marketing.
  2. A booking leads to the HIS patient master with the MRN stored, plus LeadSquared `booked`.
  3. Payment capture leads to HIS billing and LeadSquared `paid`.
  4. LeadSquared payloads are checked to be non-clinical.
  5. HIS rejects a record → the admin fixes it and retries from the screen → the event is sent.
  6. The doctor-master card is shown.
  7. The admin turns ABDM on with a reason → the patient links an ABHA (a wrong OTP is refused first) → HIS is re-sent the patient master → the patient unlinks.
  8. With ABDM off, the card is hidden.
  9. After opting out, no further LeadSquared events are sent.
