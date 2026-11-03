# Doctor experience

| Screen | Route | What it does |
|---|---|---|
| Today | `/d` | Up next (with countdown), stats, today's schedule, proposals waiting for patients (withdraw), live |
| Consultation | `/d/appointments/:id` | Patient basics, allergies, red-flag symptoms, symptoms / vitals / medicines / history, document viewer (images with zoom, PDFs inline, 60 s signed URLs), outcome, same-day reschedule, "I can't take this consultation", live |
| Calendar | `/d/calendar` | Mon–Sun week (IST), bookings coloured by status, leave, live |
| Availability | `/d/availability` | Weekly hours (multiple ranges per day, overlap checks, copy Monday to Tue–Fri), leave (whole day or hours), list of bookings that now fall outside the hours |
| Patients | `/d/patients` → `/d/patients/:id` | Patients the doctor treats; timeline of consultations, notes, final prescriptions (any Sunrise doctor) and documents. Opening a timeline is audited |
| Profile | `/d/profile` | Availability shortcut, language / theme / text size |

Patients get **Appointments** (`/p/appointments`) with live "Needs your answer" cards, the free-reschedule picker (`/p/appointments/:id/choose`) and a Home banner.

## Rules (`supabase/migrations/20261101000008_doctor.sql`)
- **Outcome**: *completed* from the join window (10 min before start); *patient didn't join* only after the patient grace period (10 min after start), with refund per `patient_no_show_refund_percent` (default 0 %); *technical failure* needs a note and gives the patient the fallback below. Recorded once; only by the consultation's doctor.
- **Same-day reschedule**: the doctor proposes another open slot on the same day with a message for the patient. The slot is held for the patient until the **answer deadline = 15 minutes before the earlier of the two times**; the proposal needs at least 5 minutes before that deadline (otherwise the doctor cancels instead). One pending proposal per booking; the doctor can withdraw it.
  - Patient **accepts** → the booking moves to the proposed time.
  - Patient **declines** → chooses a **free new time with the same doctor (any day)** or a **full refund**.
  - **No answer** by the deadline → proposal expires, booking counts as cancelled by the doctor → fallback below.
- **Doctor can't take it** (`doctor_cancel`, note required) / technical failure / expired proposal → the patient chooses a **free reschedule** or a **full refund**; with no choice within `doctor_no_show_auto_refund_hours` (24 h) the refund is issued automatically. When **nobody** joined (`both_no_show`) the free reschedule is offered and a refund is given only on request – never automatically.
- A move creates a new appointment row (same reference, fee and follow-up link; old row `rescheduled`, ref `…-R`); payment, symptoms and documents move with it.
- **Availability** changes go through RPCs that rebuild the next 14 days of open slots; booked and held slots are never removed — clashing bookings are listed for the doctor to move or cancel. Direct table writes are closed.
- Scheduled jobs (`run_scheduled_jobs`: expire holds, expire proposals, auto-refunds) run every minute via pg_cron on Supabase; the local gateway calls them every minute and then sweeps refunds.

Doctor, patient and both-sides **no-shows are detected automatically 30 minutes after the start** from the video join times (see [VIDEO.md](VIDEO.md)); the doctor can still mark a patient no-show by hand from 10 minutes.

## Realtime
`src/lib/realtime.ts` — `useRealtime(name, [{ table, filter }], queryKeys)` subscribes to Supabase Realtime `postgres_changes` and refetches the given queries (payloads are only a signal; data is re-read through RLS). Published tables: `appointments`, `reschedule_requests`, `notifications`, `slots`, `chat_messages`, `call_logs`. Supabase Realtime applies RLS per subscriber, so a doctor only receives their own bookings and a patient only their family's. The app sets the user's JWT on the Realtime client before joining (supabase-js 2.46 does not forward a session restored on page load, which would make every RLS check fail).

Locally (no Docker), `scripts/local-stack/realtime.ts` in the gateway speaks the same Phoenix channel protocol: changes arrive through `pg_notify` triggers (`scripts/local-stack/realtime.sql`, not a migration) and each row is re-read **as the subscriber** before delivery, so RLS is enforced the same way.

## Tests
| | |
|---|---|
| `supabase/tests/doctor_flow.sql` (in `npm run db:test`) | 51 checks: availability + slot rebuild + clashes, proposal rules (reason, same day, one pending, deadline, held slot), accept / decline-reschedule / decline-refund, expiry → fallback, doctor cancel → refund, 24 h auto refund, outcomes (too early, once, grace, no-show refund %, technical failure), role checks, audited timeline, publication |
| `src/features/doctor/doctor.test.ts` | weekly-hours validation |
| `npm run e2e:doctor` | doctor + patient browsers at once: Today, consultation + document viewer, proposal arrives live on the patient's screen, accept → doctor sees the move live, decline with refund, can't-attend → patient picks a free time, outcome, availability + leave, calendar, audited timeline, Malayalam phone |
