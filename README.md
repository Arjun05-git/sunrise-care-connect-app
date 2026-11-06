# Sunrise Care Connect — Foundation

Sunrise Care Connect: design system, auth, role-based routing, i18n (English + Malayalam), database with RLS, and the **patient flow** on real data — consent, profile & family, home, doctor discovery, doctor profile with slot picker, pre-consult form with document upload, and review with a 10-minute slot hold; **fees, follow-up policy engine and payments** (Razorpay test mode behind a `PaymentProvider`, webhooks, receipts, full / partial refunds) with the admin Fees, Policies and Payments screens — see [docs/PAYMENTS.md](docs/PAYMENTS.md). The **doctor experience** (Today, consultation detail with document viewer, calendar, availability, patient timeline, outcomes, same-day reschedule with patient accept / decline and the free-reschedule-or-refund fallback) updates live via Supabase Realtime — see [docs/DOCTOR.md](docs/DOCTOR.md). **Video consultations** (LiveKit behind a `VideoProvider`, Jitsi fallback for demos): waiting room with device check, join windows, in-call screens with chat and file share, the doctor's side panel with live notes, call logs, automatic no-shows and technical-failure handling, recording off — see [docs/VIDEO.md](docs/VIDEO.md). **Clinical notes and e-prescriptions**: autosaved notes with ICD-10 search and templates, a prescription builder with the List O / A / B / Prohibited rule engine (blocked with the reason), allergy and interaction warnings, PIN + signature, finalise and lock, unique Rx number, versioned addenda, server-side PDF on Sunrise letterhead with a QR code, patient records with download / share, and a public verification page — see [docs/PRESCRIPTIONS.md](docs/PRESCRIPTIONS.md). **Notifications**: one outbox for WhatsApp, SMS (MSG91 / DLT), Web Push and in-app, with opt-in checks, quiet hours, a scheduled job for 24 h / 1 h / 10 min reminders, follow-ups and feedback, messages with no clinical details (only a secure sign-in link), the live bell and notification settings, and Admin → Notifications (Outbox with delivery status and cost counters, templates, rates) — see [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md). The **admin console**: dashboard with charts, appointment monitor with manual actions (cancel with a chosen refund, move, record outcome, extend), doctor onboarding with a two-person registration check and suspension, masters, versioned consent and legal pages, users and roles, support tickets (with a patient Help page), audit log viewer and six CSV reports — see [docs/ADMIN.md](docs/ADMIN.md). **Integrations** behind interfaces with mock adapters and HTTP stubs (not yet run against the real systems): HIS patient master / consultation summary / prescription / billing on events plus a nightly doctor master, LeadSquared journey events only for patients who give the new optional marketing consent (never anything clinical), and optional ABDM ABHA verification and linking behind a flag that is off — one retrying outbox with an Admin → Integrations screen, see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). An **installable PWA** (manifest, icons, a service worker that caches only the app shell — never API data — offline banner, update prompt, install card) and **Capacitor 8** Android / iOS shells with FCM push, camera and file handling, permissions applied by script — see [docs/MOBILE.md](docs/MOBILE.md). **Security review** (OWASP ASVS L2 / MASVS): findings, fixes and the production checklist are in [docs/SECURITY.md](docs/SECURITY.md). **Quality**: critical-journey e2e, accessibility (WCAG 2.1 AA) and mobile performance on throttled 4G – results in [docs/QUALITY.md](docs/QUALITY.md).

**Testing on your own computer:** step-by-step guide in [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md).

```bash
npm install
# Real data (Supabase Auth + Postgres + Storage). Without Docker: needs PostgreSQL 15/16 and the binaries in $SB_BIN
SB_BIN=/opt/sb PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run stack:up   # migrates, seeds, writes .env.local
npm run dev              # http://localhost:5173 (proxies /auth/v1, /rest/v1, /storage/v1)
# With the Supabase CLI instead: supabase start (reference data only), then load the demo hospital as described in docs/LOCAL_TESTING.md B2, and put its URL + anon key in .env.local (VITE_APP_ENV=demo, VITE_APP_MODE=supabase)

# UI shell only, no database:
cp .env.example .env     # VITE_APP_ENV=demo, VITE_APP_MODE=demo (both are required: a missing value stops the app)
```

| Role | Demo login |
|---|---|
| Patient | mobile `9847000001` → OTP `123456` (any other valid number becomes a new patient) |
| Doctor | mobile `9847100001` → OTP `123456` |
| Admin | `admin@sunrise.demo` / `Sunrise@123` (also `coordinator@` and `finance@sunrise.demo`) |

## Scripts
| | |
|---|---|
| `npm run dev` / `build` / `preview` | Vite |
| `npm test` | 180 Vitest tests: server-side upload checks (magic bytes, PDF active content), Send SMS hook signature + Indian numbers, MFA guard, HIS / LeadSquared / ABDM adapters, sealed ABHA transactions, integration dispatcher, notification-tap path guard, credential type sniffing / content version order, notification guard / SMS parts / WhatsApp + MSG91 requests and webhooks / Web Push encryption + VAPID / dispatcher, prescription PDF (QR decoded back to the verification URL), video tokens / webhook signatures / Jitsi config / quality aggregation, weekly-hours validation, payment providers + signatures, receipt PDF, reconciliation CSV, effective fees, document validation (type + magic bytes + size), slot rules, form schema, consent versions, hold countdown,  WCAG AA contrast of every token pair (light + dark, parsed from `index.css`), demo auth, rate limiting, guards, routing per role, en/ml key parity |
| `npm run i18n:check` | Every key used in code exists in `en.json` and `ml.json`, with matching interpolation variables |
| `npm run stack:up` / `stack:down` | Local Supabase-compatible stack without Docker: GoTrue (phone OTP with test numbers), PostgREST, storage-api and a gateway on :54321 that also runs the edge functions in Node, a Realtime (postgres_changes) emulator with RLS and the minute scheduler; a local LiveKit SFU when the binary is present; applies migrations + seed |
| `npm run db:test` | Throwaway DB: migrations + seed, 78 RLS + 50 booking + 83 fee / follow-up / refund + 51 doctor-flow + 50 video + 72 prescription + 53 notification + 90 admin-console + 57 integrations + 35 security checks |
| `npm run e2e:journeys` | The five critical journeys for a brand-new patient each run: book and pay, free follow-up, doctor same-day reschedule, doctor cancellation with refund, prescription with drug-rule block → signed (see docs/QUALITY.md) |
| `npm run a11y` | axe-core (WCAG 2.0/2.1 A + AA) on 82 screens of all roles in light and dark, open dialogs and MFA enrolment, plus reflow at 320 px with the largest text size; fails on any violation (see docs/QUALITY.md) |
| `npm run test:tz` | The whole unit-test suite under UTC, America/Los_Angeles, Pacific/Kiritimati and Asia/Kolkata: results must not depend on the machine's time zone. `npm run db:test` likewise re-runs every SQL suite under other session zones (see [docs/TIMEZONE.md](docs/TIMEZONE.md)) |
| `npm run perf` | Lighthouse, phone, Slow 4G applied by DevTools, median of 3 cold loads per page; `scripts/perf-server.mjs` serves a build over HTTP/2 + gzip like a CDN (see docs/QUALITY.md) |
| `npm run e2e:security` | Staff TOTP enrolment + sign-in, REST refusals for each review finding, documents-register (renamed HTML, PDF with JavaScript, another family's path, clean PDF), Send SMS hook (signature, non-Indian numbers, per-number limit) — see docs/SECURITY.md |
| `npm run e2e:integrations` | Marketing opt-in → booking → HIS patient master (MRN) + LeadSquared, payment → billing, non-clinical LeadSquared payloads, HIS rejection → admin retry, ABDM on → ABHA link with OTP → unlink, opt-out (see docs/INTEGRATIONS.md) |
| `npm run e2e:pwa` | Against a production preview: manifest + icons, shell-only precache, no API responses cached, offline deep link + banner, update prompt → reload, iOS install hint (see docs/MOBILE.md) |
| `npm run mobile:add` / `mobile:build` / `mobile:assets` | Capacitor: check `.env.mobile`, build, add / sync Android + iOS, apply permissions and push wiring (`scripts/mobile/patch-native.mjs`), generate icons + splash (see docs/MOBILE.md) |
| `npm run e2e:admin` | Admin console: dashboard, doctor onboarding + second-person verification + suspension, monitor actions, masters, content versions / re-consent, staff invite, support, audit, reports + CSV (see docs/ADMIN.md) |
| `npm run e2e:notifications` | Booking → WhatsApp + SMS + in-app delivered (mock providers) with costs, no clinical text, scheduled reminder, live bell, secure links, SMS opt-out, failed message → admin Outbox → Send again, template edit, rates, feedback (see docs/NOTIFICATIONS.md) |
| `npm run e2e:prescription` | Notes, ICD-10, templates, rule-checked prescription, PIN + signature, signed PDF, patient records, public QR page, addendum (see docs/PRESCRIPTIONS.md) |
| `npm run e2e:video` | Doctor and patient with fake camera/mic in a real LiveKit room: waiting room, call, chat + file share, notes, audio only, SFU restart → reconnect, outcome, call log (see docs/VIDEO.md) |
| `npm run e2e:doctor` | Doctor and patient browsers side by side against the live stack, incl. realtime updates (see docs/DOCTOR.md) |
| `npm run e2e:payments-api` / `e2e:payments` | Payments end to end through the API and in the browser (see docs/PAYMENTS.md) |
| `npm run e2e:patient <url>` | Chromium against the live stack: onboarding, discovery & filters, slot pick, form + uploads, hold countdown, another patient blocked, expiry release, free follow-up confirm, family, Malayalam + dark, no horizontal scroll. Screenshots `docs/screenshots/patient-*.png` |
| `node scripts/e2e-smoke.mjs <url>` | Playwright run against a preview build: logins for all roles, guards, Malayalam, dark mode, style guide (no mobile overflow, no failing contrast), dialog, toast. Writes `docs/screenshots/` |

## What's in place
- **Stack:** React 18 + TypeScript + Vite, Tailwind 3, shadcn/ui (new-york, `components.json` included), Radix, Lucide, React Query, React Hook Form + Zod, react-i18next, sonner.
- **Design tokens** (`src/styles/index.css`): HSL CSS variables in the shadcn convention plus Sunrise extras: `primary` teal `#0F766E`, `primary-soft` `#CCFBF1`, `highlight` amber `#F59E0B` (the brand "accent"; shadcn's `accent` is kept for hover tints so future CLI components behave), `success` / `warning` / `destructive` (+ `-soft`), slate neutrals, page `#F8FAFC`, 16 px radius, soft shadows. Light (`:root, .light`) and dark (`.dark`). Rebrand by editing that file only.
- **UI primitives** (`src/components/ui`): button, card, input, textarea, label, form, select, checkbox, radio-group, switch, slider, tabs, dialog, sheet (bottom / left), tooltip, dropdown-menu, badge, avatar, progress, skeleton, separator, sonner toaster, input-otp. 44 px tap targets, 16 px input text.
- **Layout** (`src/components/layout`): `TopBar`, `BottomTabBar`, `Sidebar`, `PageHeader`, `MobileTabShell` (patient/doctor: inline nav on md+, tab bar on phones), `SidebarShell` (admin: fixed sidebar ≥lg, drawer below), `DemoBanner`, `SkipLink`.
- **Feedback & brand:** `EmptyState` (6 inline illustrations), `ListSkeleton`, `CardSkeleton`, `ErrorState`, `FullPageLoader`, `EmergencyNotice` (on every patient screen and the login page), `Logo`.
- **Auth** (`src/auth`): `AuthService` interface; `DemoAuthService` (OTP 123456, Indian-mobile validation, 5 OTP requests / 15 min, staff email + password); `AuthProvider`; `RequireRole` guard — anonymous → `/login` (remembers the target), wrong role → own home.
- **Routes:** `/login`, `/style-guide`, patient `/p/*` (Home, Appointments, Records, Profile), doctor `/d/*` (Today, Calendar, Patients, Profile), staff `/a/*` (11 sidebar sections), 404.
- **Preferences:** language, theme (light / dark / system) and text size (90–130 %) persisted per device, applied before first paint.

## Patient flow
| Screen | Route | Data |
|---|---|---|
| Consent | `/p/consent` | `set_consents` — texts and versions from `app_settings`; new version → asked again; WhatsApp is opt-in, never pre-ticked |
| Your details | `/p/welcome` | `save_patient` — first login only |
| Home | `/p` | upcoming consults, free follow-up shortcut (`my_free_follow_ups`), specialities, search |
| Find a doctor | `/p/doctors` | `search_doctors` — speciality, hospital, language, audio/video, available today, text search; filters in the URL (IDs only) |
| Doctor + slots | `/p/doctors/:id` | registration no. shown (TPG), patient picker (self / family), mode + fee, 14-day IST date strip, morning / afternoon / evening slots, live free/paid preview |
| About the problem | `/p/book/details` | body area, symptoms, duration, severity, description, vitals, allergies, medicines, history, red-flag 112 warning; uploads (PDF/JPG/PNG ≤ 10 MB, max 5, checked by magic bytes in the browser and again on the server by `documents-register`, which also refuses PDFs with scripts) with progress, preview (60 s signed URL), delete |
| Review | `/p/book/review/:id` | `hold_slot` on entry from the form; countdown from the server clock, warnings at 5 / 2 / 1 min, release on 0 → "pick a time again" (form kept); fee breakup + refund tiers from settings; free follow-up → `confirm_free_booking`; paid → payment (next phase) |
| Profile | `/p/profile` | family add / edit / remove (archive), consents with withdraw, display settings |

Decisions taken (no business rule changed): the 10-minute hold starts when the form is submitted (it covers review + payment, so a slow form never wastes the hold); one hold per account at a time; leaving the review via "Change doctor or time" or going back to edit releases the hold immediately; a paid hold can't be confirmed until the payment phase.

## Notes
- The shadcn registry wasn't reachable from the build sandbox, so the components were added by hand following the shadcn source layout. On a normal network `npx shadcn@2.1.8 add <component>` works with the included `components.json`.
- Staff MFA (TOTP) is enforced: `stepUpPending` sends staff without a code to `/mfa`, and `staff_ok()` needs aal2 (docs/SECURITY.md). Doctors sign prescriptions with their PIN.
- **Database:** migrations, RLS, audit and seed in `supabase/`; see [docs/DATABASE.md](docs/DATABASE.md) (`npm run db:test` runs the RLS matrix and the booking tests).
- Main bundle is ~196 kB gzip; patient screens and supabase-js load on demand.
- `scripts/local-stack` is a development tool for machines without Docker; it uses the well-known local JWT secret and test OTP numbers (`98470000NN`, `98471000NN`, and `98479990NN` for new sign-ups). Never use it for real data.
