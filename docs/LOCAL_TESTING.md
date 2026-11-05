# Testing Sunrise Care Connect on your own computer

There are two ways to run the app. Start with **A**: it takes five minutes and needs nothing but Node. Move on to **B** to test the real patient, doctor and admin flows.

| | A. Quick look (demo mode) | B. Full app (local Supabase) |
|---|---|---|
| What works | Sign-in for all three roles, layout, navigation, Malayalam, dark mode, text size, style guide | Everything: booking, slot hold, mock payments, doctor's day, video calls, prescriptions, notifications, admin console |
| What you need | Node | Node, Docker Desktop, Supabase CLI |
| Data | None. Patient screens show a "start the database" notice | Seeded hospitals, doctors, patients and slots |

Nothing in either setup sends a real SMS or WhatsApp message, and no real money moves.

---

## 1. Install the tools (once)

| Tool | Version | Get it |
|---|---|---|
| **Node.js** | 20 or 22 LTS | <https://nodejs.org> (check: `node -v`) |
| **Git** | any | <https://git-scm.com> |
| **Docker Desktop** (B only) | current | <https://www.docker.com/products/docker-desktop>. Start it and wait until it says *running*. On Windows, turn on WSL 2 when asked. |
| **Supabase CLI** (B only) | 2.x | macOS: `brew install supabase/tap/supabase`. Windows: `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git` then `scoop install supabase`. Linux: see <https://supabase.com/docs/guides/local-development/cli/getting-started>. Check with `supabase --version`. |

Use **Chrome or Edge** for testing. The camera, microphone and install prompt work on `http://localhost` without HTTPS.

## 2. Get the code and install packages

Unzip the project, or clone it from GitHub if it has been pushed there. Then, in a terminal inside the project folder:

```bash
npm install
```

## A. Quick look (demo mode)

```bash
cp .env.example .env          # Windows PowerShell: copy .env.example .env
npm run dev
```

Open <http://localhost:5173>. Sign in with:

| Role | Sign-in |
|---|---|
| Patient | mobile `9847000001`, OTP `123456` |
| Doctor | mobile `9847100001`, OTP `123456` |
| Admin | `admin@sunrise.demo` / `Sunrise@123` |

Also open <http://localhost:5173/style-guide>, which shows every component in light and dark. Stop the server with **Ctrl + C**.

## B. Full app with local Supabase

### B1. Allow test sign-ins (local only)

The project's `supabase/config.toml` has no fixed test codes, on purpose: the file can be pushed to a hosted project, and a fixed code would then be a permanent login. For local testing, **add the block below to the end of `supabase/config.toml` and do not commit it** (or remove it again afterwards):

```toml
# ---- LOCAL TESTING ONLY – remove before `supabase config push` or committing ----
[auth.sms.twilio]
enabled = true
account_sid = "local"
message_service_sid = "local"
auth_token = "local"

[auth.sms.test_otp]
919847000001 = "123456"   # patient Anjali (seeded)
919847000002 = "123456"   # patient (seeded)
919847100001 = "123456"   # doctor (seeded)
919847100002 = "123456"   # doctor (seeded)
919847999001 = "123456"   # free numbers: each signs up as a brand-new patient
919847999002 = "123456"
919847999003 = "123456"
```

The Twilio values are dummies: test numbers never send an SMS, but Supabase needs a provider switched on before phone sign-in works. Any number **not** in the list will fail with an SMS error. That's expected.

### B2. Start Supabase

With Docker Desktop running:

```bash
supabase start        # first run downloads images (several minutes); applies migrations + seed
supabase status       # shows API URL, DB URL, Studio URL and the anon key
```

If you change the SQL or want a clean database again later: `supabase db reset`.

### B3. Start the server functions (payments, video, prescriptions, notifications…)

In a **second terminal**:

```bash
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env
```

Leave this running. It uses the mock payment gateway, mock notifications and free Jitsi video rooms.

### B4. Point the app at Supabase

Create **`.env.local`** in the project folder. Delete `.env` from step A if you made it.

```bash
VITE_APP_ENV=demo
VITE_APP_MODE=supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=<the "anon key" from supabase status>
VITE_DEMO_HINTS=true
```

Leave `VITE_SUPABASE_URL` empty: the dev server forwards `/auth`, `/rest`, `/storage`, `/functions` and `/realtime` to `http://127.0.0.1:54321`. **Never** put the `service_role` key in this file.

### B5. Optional: the minute scheduler

Reminders, automatic no-shows and expired-hold clean-up run from a once-a-minute database job. To switch it on locally, open **Supabase Studio** (URL from `supabase status`) → *SQL Editor* and run:

```sql
create extension if not exists pg_cron;
select cron.schedule('scc-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
```

Without it, everything else works; reminders simply aren't generated.

### B6. Run the app

In a **third terminal**:

```bash
npm run dev
```

Open <http://localhost:5173>.

| Role | Sign-in |
|---|---|
| Patient | `9847000001`, OTP `123456` (or `9847999001` for a brand-new patient) |
| Doctor | `9847100001`, OTP `123456`; signing PIN `1234` |
| Admin | `admin@sunrise.demo` / `Sunrise@123` (also `finance@` and `coordinator@sunrise.demo`) |

Staff two-factor sign-in is switched off in the seeded data. To try it, set `staff_mfa_required` to `true` in the `app_settings` table (Studio → Table editor).

**Payments** use a built-in *Test payment* window: choose a method, then **Pay ₹…** for success or **Simulate a declined payment** for a failure. No card details are asked for and no money moves.

### B7. Stop everything

**Ctrl + C** in the terminals, then `supabase stop`.

---

## 3. What to test: a checklist

Tip: use one **normal** window and one **incognito** window (or two browsers) to be patient and doctor at the same time.

### Patient (phone size)
Open DevTools (F12) → device toolbar → choose a 360 px-wide phone.

1. Sign in with a **new** number (`9847999001`) → consent screen (WhatsApp is not pre-ticked) → your details → Home.
2. **Find a doctor**: try speciality, Audio/Video, "available today" and search.
3. Open a doctor → pick a date and time → fill in *About the problem*.
   - Pick *Chest pain* → the emergency warning appears.
   - Upload a PDF or photo.
4. **Review**: the 10-minute countdown runs. In the *Test payment* window press **Pay** → booking confirmed → receipt.
5. On another booking press **Simulate a declined payment** → a friendly message, and the slot stays held.
6. **Profile**: add a family member, switch to **Malayalam**, dark mode and larger text.

### Doctor (second window)
1. Sign in as `9847100001` → **Today** shows the new booking *without refreshing*.
2. Open it → read the patient's form and documents.
3. **Start the consult**. Allow camera and mic. The patient joins from *Appointments* in the other window.
4. Write notes, add a diagnosis, then a prescription. Try a blocked drug to see the reason, then sign with PIN `1234` → PDF.
5. As the patient: **Records** → download the prescription and scan its QR code (opens `/verify/...`).
6. Try **reschedule** and **cancel**. The patient sees the choice live, and the refund shows in Admin → Payments.

### Admin (desktop size)
Dashboard, Appointments (cancel with refund, move), Doctors (onboard and second-person verify), Masters, Content, Notifications → Outbox (the messages from the steps above, with no clinical text), Integrations, Support, Audit log, Reports (download a CSV).

### Things to check everywhere
- Nothing scrolls sideways at 360 px. Wide desktop pages look centred and tidy.
- **Offline**: DevTools → Network → *Offline* → you see "You're offline" and a Try again button.
- Error messages are friendly and say what to do next.

## 4. Automated checks you can run locally

```bash
npm run typecheck      # TypeScript, app and server functions
npm test               # 182 unit tests
npm run i18n:check     # every English key has a Malayalam one
npm run build          # production build into dist/
```

The browser end-to-end suites in `scripts/e2e-*.mjs`, accessibility and performance were written for the Docker-free stack used in development (`npm run stack:up`). That stack needs prebuilt GoTrue, PostgREST and storage binaries. They are not set up for the Supabase CLI, so treat the checklist above as the local test. The demo-mode smoke test does run locally, once a Chromium is available:

```bash
npx playwright@1.49.1 install chromium
npm run build && npx vite preview --port 4174      # in one terminal (with .env from step A)
CHROMIUM_PATH="<path printed by the install>" node scripts/e2e-smoke.mjs http://localhost:4174
```

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| `supabase start` fails: Docker isn't running | Start Docker Desktop and wait for *running* |
| Port 54321/54322/5173 already in use | Stop the other app or old Supabase (`supabase stop --all`) |
| "Error sending SMS" or "Unsupported phone provider" at sign-in | Step B1 is missing, or the number isn't in the test list. Restart with `supabase stop && supabase start` after editing `config.toml`. |
| Signed in but screens show "We couldn't load this" | Check `.env.local` (mode `supabase`, anon key from `supabase status`), then restart `npm run dev` |
| Payment, video or PDF buttons fail | The functions terminal (B3) isn't running, or `supabase/functions/.env` is missing |
| App still shows old screens | DevTools → Application → *Service workers* → Unregister, then hard reload. Only an issue after `npm run preview`. |
| Want a clean start | `supabase db reset` |
