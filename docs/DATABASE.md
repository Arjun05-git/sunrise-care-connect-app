# Database

Supabase Postgres (project region **ap-south-1 Mumbai**). Migrations in `supabase/migrations/`:

| File | Contents |
|---|---|
| `20261101000001_schema.sql` | Extensions, 15 enums, **39 tables** (the 31 in the data model + `holidays`, `data_requests`, `chat_messages`, `doctor_secrets`, `auth_step_up`, `doctor_preferences`, `payment_webhook_events`, `rate_limits`), FKs, CHECKs, 89 indexes |
| `20261101000002_rls.sql` | Helper functions, RLS **enabled and forced** on every table, 87 policies, grants |
| `20261101000003_audit.sql` | Generic audit trigger on 25 sensitive tables, append-only `audit_logs`, immutable final prescriptions |
| `20261101000004_storage.sql` | Private buckets `medical-documents`, `prescriptions`, `signatures` + storage policies |
| `20261101000005_auth_hooks.sql` | New auth user → `profiles` row + `patient` role; realtime publication |
| `20261101000008_doctor.sql` | Availability RPCs + slot rebuild, outcomes, same-day reschedule + patient responses, doctor-cancel fallback, auto refunds, scheduled jobs, audited patient timeline — see [DOCTOR.md](DOCTOR.md) |
| `20261101000007_payments.sql` | Fee quote, follow-up engine with admin overrides, payment capture, refunds, reconciliation, admin config RPCs — see [PAYMENTS.md](PAYMENTS.md) |
| `20261101000009_video.sql` | Join window + rooms (`consult_access`, `join_consult`), call logs (client RPC + LiveKit webhook) and `call_summary`, in-call chat, live notes, automatic doctor / patient no-shows — see [VIDEO.md](VIDEO.md) |
| `20261101000010_prescriptions.sql` | ICD-10 search, notes with diagnoses (locked when final), note templates, drug rule engine + interactions, rule-checked drafts, signing PIN + signature, finalise / Rx number / snapshots, addenda, verification + PDF data (service only) — see [PRESCRIPTIONS.md](PRESCRIPTIONS.md) |
| `20261101000011_both_no_show_outcome.sql` / `20261101000012_no_show_rules.sql` | `both_no_show` outcome; in progress only when both joined; automatic no-shows after 30 min; nobody joined → free reschedule, refund only on request |
| `20261101000013_notification_status_skipped.sql` / `20261101000014_notifications.sql` | Outbox per person × channel (`event_key` de-duplication, masked numbers, provider ids, costs, delivery timestamps), `notification_links` (secure `/l/` tokens), `notification_prefs`, `push_subscriptions`; template channels / DLT ids / quiet hours with a placeholder whitelist; routing + opt-in (`enqueue_notification`), event triggers on appointments / payments / refunds, scheduled reminders, feedback and follow-ups, dispatcher RPCs (service only), Outbox stats / retry / template and cost admin, ratings — see [NOTIFICATIONS.md](NOTIFICATIONS.md) |
| `20261101000015_admin_console.sql` | Doctor onboarding + two-person verification + suspension, credentials bucket, staff roles with guards (direct writes to `doctors` / `user_roles` closed), masters RPCs, appointment monitor actions, versioned consent & legal content, ticket conversations, audit search, dashboard and reports — see [ADMIN.md](ADMIN.md) |
| `20261101000016_marketing_consent.sql` / `20261101000017_integrations.sql` | Optional `marketing` consent; integration outbox `integration_events` (references only, idempotency keys, lease + back-off) with triggers on appointments / patients / prescriptions / payments / refunds, send-time payloads, MRN write-back, HIS doctor-master matching, ABHA columns + `link_abha` / `unlink_abha`, native push `device_tokens`, admin stats / events / retry / flags — see [INTEGRATIONS.md](INTEGRATIONS.md) |
| `20261101000018_security_hardening.sql` | Direct writes closed on `patients`, `profiles`, `consents`, `consultations`, `notifications`, `documents` (RPCs only); `register_document` (service, after the byte check); storage: doctors / admins read registered files only, files of a started consultation can't be deleted; function EXECUTE locked down (anon: `public_content` only; `write_audit` / `setting` internal); staff MFA in `staff_ok()` — see [SECURITY.md](SECURITY.md) |
| `20261101000023_recording_consent.sql` | **Recording, part 1:** `recording_consents` and `consult_recordings` (the storage path is not granted to any client), `set_recording_consent` / `start_recording` / `stop_recording` / `finish_recording` / `fail_recording`, the private `consult-recordings` bucket (doctor upload under the active prefix only; no client read, overwrite or delete), audit triggers, realtime. See [RECORDING.md](RECORDING.md). |
| `20261101000024_recording_audio_only.sql` | **Recording, part 2:** `start_recording` always stores `kind = 'audio'`. |
| `20261101000022_custom_medicines.sql` | **Custom medicines:** `prescription_items.drug_id` becomes nullable with `is_custom`, `generic_name`, `custom_acknowledged` and a check constraint tying them together; `check_custom_medicine` / `rx_custom_verdict` / `rx_custom_match` (the catalogue-match guard); `save_rx_draft`, `start_addendum`, `finalize_prescription` and `rx_pdf_payload` made custom-aware (the PDF payload now left-joins the catalogue); `admin_custom_medicines` for review; `custom_medicine_mode` ('direct' in the demo seed, 'checked' by default) selects the guarded or the as-typed behaviour. See [PRESCRIPTIONS.md](PRESCRIPTIONS.md). |
| `20261101000021_timezone_ist_today.sql` | `ist_today()` (the IST calendar date, whatever the session zone) and `save_patient` using it instead of `current_date`. No function may depend on the session time zone: see [TIMEZONE.md](TIMEZONE.md). |
| `20261101000020_authorization_hardening.sql` | **Privilege layer closed:** `authenticated` loses INSERT / UPDATE / DELETE / TRUNCATE on every RPC-owned table (appointments, payments, refunds, doctors, user_roles, prescriptions and items, call_logs, chat_messages, slots, …) and all access to `doctor_secrets`, `auth_step_up`, `rate_limits`, `payment_webhook_events`; `anon` keeps only SELECT on `content_versions`; later tables start closed (default privileges). Admin / coordinator can no longer write `slots` directly (read only); the `signatures` storage bucket has no client policy (only the PIN-protected doctor-signature function writes it). |
| `20261101000019_environment_mfa.sql` | **Deployment environment:** `app_env()` reads the operator-set `app.environment` (only the exact word `demo` is demo; anything else is production). `mfa_required()` / `staff_ok()`: staff MFA (aal2) is always required in production and ignores `app_settings.staff_mfa_required`; in demo it is optional unless that setting is `true`. `auth_policy()` tells the sign-in screen. |
| `20261101000006_patient_booking.sql` | Patient flow RPCs: consent, family, directory, consult-type decision, fees, 10-minute slot hold / release / expiry, free follow-up confirmation; pg_cron jobs |

## Patient booking RPCs (`20261101000006`)

All are `SECURITY DEFINER`, re-check `auth.uid()` ownership, and are executable by `authenticated` only (revoked from `PUBLIC` and `anon`). Errors are stable codes the app translates (`slot_taken`, `consent_required`, …).

| Function | Does |
|---|---|
| `set_consents(types[], granted)` | Records / withdraws consents with the current version from `app_settings.consent_versions` (history kept) |
| `save_patient(...)` / `archive_patient(id)` | Creates the account holder's record, adds / edits family members (patient + dependent link in one transaction; only demographic columns), removes = archive (blocked with upcoming consults) |
| `search_doctors(q, hospital, department, language, mode, available_today)` | Verified, active doctors with next bookable slot and lowest first-consult fee |
| `doctor_fees(doctor)` | Fee per mode, first consult and follow-up |
| `booking_preview(doctor, patient, slot, mode)` | Consult type, free / paid, fee, follow-up window, hold length – without booking |
| `my_free_follow_ups()` | Free follow-ups still available to the family (Home shortcut) |
| `hold_slot(doctor, patient, slot, mode, symptoms, document_ids)` | Checks consent + rate limit, locks the slot row (`FOR UPDATE`), creates a `pending_payment` appointment with `hold_expires_at = now() + slot_hold_minutes`, marks the slot `held`, saves symptoms, attaches documents. One hold per account: a new hold releases the previous one |
| `get_hold(appointment)` | Status and seconds left on the **server** clock (the countdown never trusts the phone's clock) |
| `release_hold(appointment)` | Idempotent: cancels the hold (`payment_expired`), reopens the slot, detaches documents for reuse |
| `confirm_free_booking(appointment)` | Free follow-ups only: `confirmed`, slot `booked`, in-app notification. Paid holds → `payment_required` (confirmed by the payment webhook in the payment phase) |
| `expire_holds()` | Releases every lapsed hold. Runs every minute via pg_cron and lazily inside `hold_slot`; not callable by clients |

`determine_consult_type` (14-day window, 1 free follow-up, same-doctor rule – all from `follow_up_policy`) and `generate_slots` are internal.

## Double-booking protection

| Level | Object | Guarantees |
|---|---|---|
| Slot | `slots_doctor_start_uq` — `UNIQUE (doctor_id, start_at)` | a doctor has one slot per start time |
| Slot | `slots_no_overlap` — `EXCLUDE USING gist (doctor_id =, tstzrange(start_at,end_at) &&)` | a doctor's slots never overlap |
| Slot → appointment | `slots_one_appointment` — unique index on `slots.appointment_id` | a slot points at one appointment |
| **Appointment** | **`appointments_one_live_per_slot`** — `UNIQUE (slot_id) WHERE status IN (pending_payment, confirmed, in_progress, completed, no_show)` | **a doctor slot can be booked by only one live appointment**; cancelled / rescheduled bookings free the slot |
| Appointment | `appointments_no_double_booking` — `EXCLUDE (doctor_id =, tstzrange &&) WHERE live` | no two live appointments overlap in time for a doctor, even across different slot rows |

Postgres can't express a *partial* `UNIQUE` table constraint, so the slot guarantee is a partial unique index, which enforces uniqueness the same way. All five hold even if application code is bypassed. They are verified by `supabase/tests/rls_matrix.sql`.

## Row Level Security: who can do what

Legend: **R** read · **W** write (insert/update/delete as noted) · — no access. "Own" = the patient's own record plus dependents (`my_patient_ids()`). "Treating" = the doctor has an appointment with that patient (`doctor_sees_patient()`).

| Table(s) | Patient | Doctor | Coordinator | Finance | Admin |
|---|---|---|---|---|---|
| `profiles` | R/update self | R self + own patients' owners | R | R | R |
| `user_roles` | R self | R self | — | — | R/W all |
| `hospitals`, `departments`, `holidays`, `icd10_master`, `drug_master`, `drug_rules`, `follow_up_policy`, `app_settings` | R | R | R | R | R/W |
| `fee_config` | R | R | R | R · change via `save_fee` | R · change via `save_fee` |
| `doctors` | R verified & active | R + self | R all | R all | R/W all |
| `doctor_availability` | R | R · change via availability RPCs | R · RPCs | R | R · RPCs |
| `slots` | R | R | R/W | R | R/W |
| `patients` | R/insert/update own | R treating only | R | R | R |
| `dependents` | R/W own | — | R | — | R |
| `consents` | R/insert/withdraw own | — | — | — | R |
| `appointments` | R own | R own (assigned) | R all | R all | R all · *writes via RPC (booking phase)* |
| `appointment_symptoms` | R own (+update before consult) | R own appts | — | — | R |
| `documents` | R/insert/delete own | R/insert treating | — | — | R |
| `payments`, `refunds` | R own | — | — | R · refunds via `request_refund` | R · refunds via `request_refund` |
| `follow_up_overrides` | — | — | R | — | R · via `grant_/revoke_follow_up_override` |
| `consultations` | R own **final** | R/W own | — | — | R |
| `prescriptions`, `prescription_items` | R own **final** | R/W own **drafts**; R final of treating patients | — | — | R |
| `reschedule_requests`, `call_logs`, `ratings` | R own (+rate completed) | R own (+insert call logs) | R | R | R |
| `chat_messages` | R/W own live consult | R/W own live consult | — | — | — |
| `notifications` | R/mark-read own | R/mark-read own | R outbox | — | R outbox |
| `notification_templates` | — | — | R | — | R/update |
| `support_tickets` | R/create own | R/create own | R/update | — | R/update |
| `data_requests` | R/create own | R/create own | — | — | R/W |
| `audit_logs` | — | — | — | — | R (append-only for everyone) |
| `doctor_secrets`, `auth_step_up`, `payment_webhook_events`, `rate_limits` | — | — | — | — | — (service role / definer functions only) |
| `anon` (not signed in) | no table access at all | | | | |

Cross-cutting rules enforced in the helper functions:
- **Doctor step-up:** when `app_settings.require_doctor_step_up = true`, `my_doctor_id()` returns null until the doctor has a valid `auth_step_up` row (PIN/biometric). With no step-up the doctor sees nothing. The demo seed sets it to `false` because the PIN screen isn't built yet. **Set it to `true` in production.**
- **Admin MFA:** `staff_ok()` requires an `aal2` JWT once the user has a verified MFA factor.
- **Clinical vs operational:** coordinators and finance see appointment metadata but never symptoms, notes, prescriptions or medical files (`can_see_clinical()` versus `can_see_appointment()`).
- **No direct business writes:** appointments, payment capture, refunds, outcomes and prescription finalisation have no write policies. They are denied until the booking phase adds SECURITY DEFINER RPCs that apply the business rules.

Live list of policies: `select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;`

## Audit log

`audit_row_change()` runs `AFTER INSERT/UPDATE/DELETE` on appointments, consultations, prescriptions, prescription_items, documents, reschedule_requests, patients, dependents, consents, data_requests, user_roles, doctors, payments, refunds, fee_config, follow_up_policy, app_settings, drug_rules, drug_master, notification_templates, hospitals, departments, holidays, doctor_availability and support_tickets.

- Each row records **who** (`auth.uid()` and highest role), **what** (`<table>.<op>`, entity id), **when**, and **before / after**. Updates store only the columns that changed; no-op updates aren't logged.
- **Reason:** set `set local app.audit_reason = '…'` in the same transaction. The RPC layer will require a reason for overrides and refunds.
- **PHI minimisation:** clinical free text is stored as `"[redacted]"`. This covers notes, diagnoses, advice, allergies, address, document file names and ticket descriptions. The log shows *that* a field changed, not its content.
- **Tamper-proof:** UPDATE / DELETE / TRUNCATE on `audit_logs` raise an error for every role, including `postgres`. A retention job may delete rows only after `set local app.audit_purge = 'on'`.

## Seed data (`supabase/seed/`)

Two files, generated by `npm run db:seed:generate` (`scripts/seed-sql.ts`, from `src/data/seed/`):

| File | What | Where it may run |
|---|---|---|
| `reference.sql` | Master data and defaults only: ICD-10 codes, medicines and prescribing rules, system-wide note templates, notification templates, consent and legal texts, the follow-up policy and default settings (HIS / LeadSquared integrations **off**). No people, no credentials. Deterministic (no timestamps), so it can be reviewed. | **Any environment**, including production. This is the only seed `supabase/config.toml` loads. Load it once into an empty database. |
| `demo.sql` | The demo hospital below, plus the demo-only settings (MFA and doctor step-up off, local public URL, integrations on). | Only a database declared as demo (`ALTER DATABASE … SET app.environment = 'demo'`); it raises `demo seed refused` anywhere else. Load `reference.sql` first. |

The clinical content in `reference.sql` (drug lists and rules, ICD-10, note templates) and the consent / legal texts are drafts: have the hospital sign them off before go-live. `support_phone` and `grievance_officer` are placeholders to replace.

The demo seed's timestamps are relative to when you generate it, so there is always a "today":
- 3 hospitals, 8 departments
- 10 doctors with placeholder avatars, dummy TCMC registration numbers, schedules and fees; one is pending verification
- 20 patients, including 2 dependents of the demo patient
- 40 appointments in every state: completed, confirmed (one starting in about 8 minutes), cancelled with refunds, no-shows, rescheduled, payment-expired, free follow-ups, and a pending doctor reschedule request
- documents, 37 payments, 4 refunds, 17 consultations, 16 final prescriptions, ratings, call logs, tickets, notifications
- 102 medicines with TPG list categories, 214 ICD-10 codes, 15 notification templates (en + ml)
- about 3,170 slots covering the next 14 days

Demo logins: patient `+919847000001`, doctor `+919847100001` (OTP `123456`), staff `admin@` / `finance@` / `coordinator@sunrise.demo` with password `Sunrise@123`. Supabase local `config.toml` maps the test OTPs.

## Testing RLS

### 1. Automated matrix (78 RLS checks, plus the booking, payments, doctor, video, prescription, notification, admin-console, integrations and security suites)
`supabase/tests/rls_matrix.sql` impersonates each persona the same way PostgREST does: JWT claims in `request.jwt.claims`, then `SET ROLE authenticated` (or `anon`). It asserts what each role can and cannot see or change, plus the constraints and audit behaviour. It prints a results table, exits non-zero on any failure, and runs inside a transaction that is rolled back.
`supabase/tests/booking_flow.sql` (run by the same command) covers the booking RPCs: directory and filters, free follow-up decision, privileged functions not callable, consent gate, hold → `pending_payment` with a 10-minute expiry, competing hold → `slot_taken`, release, server-side expiry, expired hold can't be confirmed, free follow-up confirmed, family add / edit / archive, anon denied.

```bash
# Plain PostgreSQL 15/16 (no Docker): builds a throwaway DB with a tiny auth/storage shim, migrates, seeds, tests
PGHOST=localhost PGPORT=5432 PGUSER=postgres npm run db:test

# Supabase CLI (local stack in Docker)
npm run db:seed:generate && supabase db reset     # reference data only; load demo.sql as described in docs/LOCAL_TESTING.md (B2)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rls_matrix.sql

# A hosted staging project (never production – the test inserts rows, then rolls back)
psql "$STAGING_DB_URL" -f supabase/tests/rls_matrix.sql
```

### 2. By hand in psql or the Supabase SQL editor
```sql
begin;
-- become the demo patient (Anjali)
select set_config('request.jwt.claims', '{"sub":"00000001-0000-4000-8000-0000000000c8","role":"authenticated"}', true);
set local role authenticated;
select count(*) from patients;            -- 3  (self + 2 dependents)
select count(*) from audit_logs;          -- 0
update patients set address = 'x' where owner_user_id <> auth.uid();   -- UPDATE 0 (filtered, not an error)
rollback;
```
Other personas: doctor `…000000000064`, admin `…000000000001`, finance `…000000000002`, coordinator `…000000000003`. For admin MFA, add `"aal":"aal2"` to the claims.

### 3. Through the real API (end to end)
`npm run stack:up` starts GoTrue + PostgREST + storage-api on your PostgreSQL without Docker (see README); `npm run e2e:patient` then drives the whole patient flow in Chromium against it.

Sign in from the app or `supabase-js` as each demo user and query with the **anon key**. The JWT then carries the user's id, and PostgREST applies exactly the same policies. Never use the service-role key from a client, because it bypasses RLS.
