# Admin console

Staff sign in with email and password at `/login` → Staff, then a 6-digit code from an authenticator app (TOTP). The first sign-in enrols the app (QR code or key at `/mfa`); without the code the database refuses every staff function. Only local/demo stacks switch this off (`app_settings.staff_mfa_required = false`). All times are IST.

Every change goes through a role-checked database function and is written to the audit log with the person and their reason.

| Area | Route | Admin | Coordinator | Finance |
|---|---|---|---|---|
| Dashboard | `/a` | ✓ | ✓ (no money figures) | ✓ |
| Appointment monitor | `/a/appointments` | all actions | all actions (cancel with full refund only) | view, cancel |
| Doctors | `/a/doctors`, `/a/doctors/:id` | onboard, **verify**, suspend, reinstate | onboard, submit | view |
| Masters | `/a/masters` | edit | view | view |
| Fees · Policies · Payments | (earlier phases) | ✓ | — | ✓ |
| Notifications (Outbox, **templates**, costs) | `/a/notifications` | ✓ | Outbox, Send again | view, costs |
| Support tickets | `/a/support` | ✓ | ✓ | — |
| Consent & terms | `/a/content` | publish | view | view |
| Users & roles | `/a/users` | ✓ | — | — |
| Audit log | `/a/audit` | ✓ | — | — |
| Reports | `/a/reports` | all | all except revenue | all except notification delivery |

## Rules confirmed by Sunrise (27 Oct 2026)

### Doctor onboarding and verification
Status flow: draft → pending (waiting for verification) → verified, or rejected (fix, then submit again).

1. An admin or coordinator creates the profile: name, mobile, qualification, registration number and council, hospital, department, languages, modes and slot length.
2. **Phone login.** The `admin-users` function creates a phone login for the doctor's mobile; the doctor signs in with an OTP. Only a number that no patient or other account uses can become a doctor login.
3. **Documents.** The registration certificate is required; degree and ID are optional.
   - Accepted files are PDF, JPG or PNG up to 10 MB, checked by their first bytes rather than the file name.
   - Files go to the private bucket `doctor-credentials/<doctor>/<uuid>.<ext>` and open through 60-second links.
4. **Submit** (needs the login and the certificate).
5. **Two-person rule.** Only an **admin who neither created nor submitted** the doctor can verify. Verifying needs a note of at least 10 characters saying what was checked.
   - Verified doctors appear in the directory and slots are generated for them.
   - Rejection needs a reason.
- **Registration lock.** The registration number and council can't change while a doctor is verified or pending. To change them, suspend, then reinstate.
- **Phone lock.** The phone number can't change once it is the doctor's login.
- **Suspend** (admin, with a reason):
  - no new bookings;
  - every future booking is cancelled through the doctor-unavailable path, so the patient chooses a free reschedule or a full refund;
  - unpaid holds are released and open slots are blocked.
- **Reinstate** (admin): the doctor goes back to *pending*, and a different admin must verify again.

### Appointment monitor
- **What it shows:** every booking in a date range, updated live, with the patient name and contact number. Clinical details are not shown.
- **Search:** searching by reference or mobile number covers every date.
- **"Needs a person" flags:**
  - doctor not joined (after the grace period);
  - patient not joined;
  - outcome missing (30 minutes after the end);
  - awaiting the patient's choice;
  - refund failed;
  - reschedule pending.
- **Manual actions** (a reason is always required):

| Action | Rules |
|---|---|
| **Cancel** | Confirmed bookings. The refund is **staff's choice**: full, as per the patient cancellation tiers, or none. Coordinators can only give a full refund; less than full needs admin or finance. The patient and doctor are told and the slot reopens. |
| **Move** | Confirmed, future bookings. Moves to a free slot with the same doctor or **another verified doctor in the same department** offering the same mode. The reference, documents and payment move with it. **The booked fee is kept**, so a Sunrise move never costs the patient more. The patient, old doctor and new doctor are told. |
| **Record outcome** | After the start, for bookings the automatic rules didn't settle: completed; patient no-show (after the grace period; refund per policy); doctor no-show or technical failure (the patient gets free reschedule or full refund). |
| **Extend the room** | +10 to +30 minutes at a time, at most 60 minutes in total. |

### Consent and terms
- **Content:** the four consents and three public legal pages (Terms of Use, Privacy Notice, Refund Policy), in English and Malayalam.
- **History:** each publish is a new row in `content_versions`.
- **Versions:**
  - a **wording fix** keeps the version (revision + 1), so nobody is asked again;
  - a **new version** (2.0, 3.0, …) makes every patient accept the required consents again before their next booking (the existing consent gate).
- **Where it shows:** the public pages are at `/legal/:key`, with no sign-in, and are linked from the consent screen.
- The seeded legal texts are **drafts** for Sunrise's legal team to replace.

### Users and roles
- Only admins manage staff roles (admin, coordinator, finance), and each change needs a reason.
- **Guards:**
  - nobody changes their own roles;
  - there is always at least one admin;
  - doctor and patient accounts can't hold staff roles;
  - staff need an email login.
- Removing every role revokes access straight away.
- **Inviting staff** goes through the `admin-users` function:
  - hosted: Supabase sends the invite email;
  - local stack (`STAFF_INVITE_MODE=link`): the one-time link is shown to the admin.

  The link opens `/set-password`, and the person then signs in with email and password.

### Support tickets
- Patients raise tickets at Profile → **Help & support** (`/p/help`), optionally about a booking.
- Staff reply. **Internal notes** are never shown to the user.
- The first staff reply moves the ticket to *in progress* and stamps the response time. Resolving needs a resolution.
- A user reply reopens a resolved ticket. Users are told through the `ticket_update` notification (a secure link only).
- Limits: 5 tickets an hour and 30 messages per 10 minutes per user.

### Audit log
- Filters: date, record type, role, record id, and text in the reason.
- Each entry shows a before/after diff and can be exported to CSV.
- The log is append-only. Clinical free text and message bodies appear as `[redacted]`.

### Dashboard and reports
**Dashboard:**
- today: consultations, in progress, starting within the hour, completed, no-shows, and money collected (admin and finance only);
- links to everything that needs a person;
- charts for consultations per day by status, by department, and net revenue per day.

The charts use the validated categorical palette in `index.css` (`--viz-1…4`, with light and dark steps), have hover tooltips and a table view, and redraw live.

**Reports** (CSV with BOM, injection-safe, raw values, IST dates). **No report row identifies a patient.**

| Report | Rows | Definitions |
|---|---|---|
| Appointments | one per booking | moved bookings appear once, under their new time |
| Revenue and refunds | one per day | gross = captured that day; net = gross − refunds paid out that day |
| No-show and failure rates | one per doctor | due = completed + no-shows + technical failures + doctor cancellations |
| Doctor utilisation | one per doctor | booked ÷ offered slots (blocked excluded) |
| Free follow-up usage | one per doctor | free follow-ups booked and completed, via overrides, and the fee forgone at the current follow-up fee |
| Notification delivery | one per template × channel | delivery rate excludes skipped messages; cost in ₹ |

## Database (`20261101000015_admin_console.sql`)
- **Doctors:** `doctors` gets the workflow columns (onboarded, submitted, verified and suspended by and at, note, reasons). Direct staff writes to `doctors` and `user_roles` are closed.
- **New tables:** `doctor_credentials`, `content_versions` (public read), and `ticket_messages`. Tickets also get a reference, `first_response_at` and `resolved_at`.
- **ICD-10:** `icd10_master.active`. Inactive codes drop out of the doctor's search.
- **Functions:**
  - doctors: `admin_save_doctor`, `admin_add_doctor_credential`, `admin_submit_doctor`, `admin_verify_doctor`, `admin_suspend_doctor`, `admin_reinstate_doctor`, `link_doctor_login` (service only);
  - users: `admin_set_staff_roles`, `admin_users`;
  - masters: `admin_save_hospital`, `admin_save_department`, `admin_save_holiday`, `admin_delete_holiday`, `admin_save_drug`, `admin_save_icd`;
  - appointment monitor: `admin_appointments`, `admin_cancel_appointment`, `admin_move_appointment`, `admin_move_options`, `admin_record_outcome`, `admin_extend_window`;
  - content: `admin_publish_content`, `public_content`;
  - tickets: `create_ticket`, `post_ticket_message`, `admin_update_ticket`, `admin_tickets`;
  - audit, dashboard and reports: `admin_audit`, `admin_dashboard`, `admin_report`, `am_staff`.

## Tests
- **`npm run db:test` → `admin_console.sql`, 90 checks**:
  - onboarding steps, two-person rule, registration lock, rejection and resubmission;
  - suspension effects and reinstatement;
  - role guards;
  - masters;
  - every monitor action and its role limits;
  - content versioning and re-consent;
  - tickets (internal notes hidden, reopening);
  - audit, dashboard and report access, with no patient identity in reports.
- **`npm test`**: credential type sniffing; latest-version ordering.
- **`npm run e2e:admin`**:
  - dashboard (tooltip, table view);
  - coordinator onboarding with upload → a second person verifies → the doctor signs in;
  - suspend and reinstate;
  - monitor: extend, doctor no-show, move, policy cancel;
  - masters;
  - content: fix shown on `/legal`; new version → patient re-consents;
  - staff invite → set password → sign in → roles removed;
  - support conversation;
  - audit search;
  - reports and CSV;
  - phone widths.
