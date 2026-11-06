# Security review: OWASP ASVS 4.0 (L2) and MASVS 2.x basics

**Reviewed 2 Nov 2026.**

**Method:**
- read every edge function, migration, storage policy and client data path;
- probed the database as real users, impersonating them with JWT claims exactly as PostgREST does;
- ran `npm audit`.

Every finding below is **fixed and covered by tests**, except the items listed under *Accepted / open*.

## Findings

| # | Severity | Area (ASVS / MASVS) | Finding | Fix |
|---|---|---|---|---|
| 1 | **High** | Access control, V4.1.3 / V4.2.1 | A patient could `PATCH /rest/v1/patients` directly. Row-level security allowed **any column**, so they could:<br>• set `his_mrn` to **another person's hospital number**, after which the next HIS consultation or billing events attach to that person's record;<br>• mark an ABHA as verified without the ABDM OTP. | `revoke insert, update, delete on patients from authenticated`. All writes go through the existing definer RPCs: `save_patient`, `archive_patient`, `link_abha`, `unlink_abha`. |
| 2 | **High** | Access control, V4.2.1 | A doctor could insert a **FINAL** consultation note for **any patient** (not their appointment) without signing. The patient's family then sees it as a final clinical record. | The `consultations` policy is now SELECT-only, and table writes are revoked. Notes go through `save_consult_notes` and `finalize_prescription`. |
| 3 | **High** | Log integrity, V7.3.3 | `write_audit()` was executable by `PUBLIC`. The old `revoke … from anon` had no effect, because anon inherits `PUBLIC`. **Anyone, signed in or not,** could add forged audit entries, and an anonymous one shows as a "system" action. | Every public function had `EXECUTE` revoked from `PUBLIC` and anon. Signed-in users keep exactly what they had, minus `write_audit`, `setting` and `audit_actor_role`. Anon keeps only `public_content`. New functions are no longer executable by `PUBLIC` by default. |
| 4 | **High** | Authentication, V2.7 / V4.3.1 | Staff (admin, finance, coordinator) had full console access with **a password only**. `staff_ok()` asked for aal2 only from staff who had *chosen* to enrol a factor, and the app had no way to enrol. | **TOTP MFA for staff:**<br>• first sign-in → `/mfa` with QR code and key;<br>• later sign-ins → code;<br>• the guard sends any staff session without aal2 to `/mfa`;<br>• `staff_ok()` requires aal2. **Phase 2:** whether MFA is mandatory is decided by the *database environment* (`app.environment`, set by an operator), not by a table row an admin could edit: production always requires it and ignores `app_settings.staff_mfa_required`; only an explicitly configured `demo` database may run without it (migration `20261101000019_environment_mfa.sql`, `supabase/tests/environment.sql`). |
| 5 | **High** | Authentication, V2.10 | `supabase/config.toml` held **fixed OTP 123456** for three real-format Indian numbers, one of them a doctor login. If someone runs `supabase config push`, those numbers become standing logins on a hosted project. | Removed from `config.toml`. The local stack injects its test numbers through `GOTRUE_SMS_TEST_OTP` only. |
| 6 | Medium | OTP abuse, V2.2.1 / V11.1.4 | Supabase Auth texts an OTP to **any number in the world**; the +91 check was client-side only. There was no per-number limit, which leaves the project open to SMS pumping (toll fraud) and OTP flooding of one person's phone. | New **Send SMS hook** (`auth-sms-hook`):<br>• Standard-Webhooks signature, 5-minute replay window;<br>• Indian mobiles only;<br>• 5 codes per number per 15 min and 10 per day (hashed keys);<br>• sends through MSG91 with the DLT OTP template;<br>• never logs the number or the code. |
| 7 | Medium | Personal data integrity, V8.3.4 | A patient could change `profiles.phone` and `profiles.email`. Their reminders and links would then be sent to someone else's number. They could also **squat** a number, so the real owner's sign-up fails on the unique key. | Writes to `profiles` revoked. The name changes through `save_patient`; phone and email come from Auth. |
| 8 | Medium | Consent records (DPDP), V8.3 | A patient could rewrite their own consent rows (`version`, `granted_at`). | Writes to `consents` revoked. Consent changes go through `set_consents` only. |
| 9 | Medium | Clinical record integrity | A patient could detach a file from a **finished** consultation (`appointment_id = null`) and then delete it. They could also delete the stored object at any time. | Direct UPDATE on `documents` revoked. The storage delete policy refuses files still registered to a consultation that has started or finished. |
| 10 | Medium | File upload, V12.1–12.2 | The file type was checked **only in the browser**. Clients inserted `documents` rows with any `mime_type`, `size_bytes` and `storage_path`, including a path in another patient's folder. | New `documents-register` function. It first checks the caller can see the patient (RLS). It then reads the uploaded file back and checks:<br>• magic bytes;<br>• that the stored Content-Type and extension match the bytes;<br>• size ≤ 10 MB;<br>• **PDFs with JavaScript, Launch, EmbeddedFile, XFA and similar entries are refused**.<br>A failing file is deleted. Otherwise the row is written through the service-only `register_document`, which enforces the path `patients/<patient>/<doc>.<ext>`. Doctors and admins can read only registered files. |
| 11 | Medium | Dependencies, V14.2.1 | `npm audit` found:<br>• app bundle: react-router 6.28 (open redirect via backslash and more), ws, postcss, supabase auth-js;<br>• tooling: vite 5, vitest 2, tinypool (critical), esbuild. | Upgraded:<br>• react-router-dom 7.18.5;<br>• supabase-js 2.118;<br>• zod 3.25.76;<br>• vite 8.3.5, @vitejs/plugin-react 6, vitest 5.0.5, postcss 8.5;<br>• TypeScript 5.9, with type-only fixes.<br>The local Realtime emulator now speaks Phoenix serializer v2, which the new realtime-js uses by default. |
| 12 | Medium | MASVS-STORAGE-1 | In the Android/iOS app the Supabase session, including the refresh token, sat in WebView `localStorage`. | Native builds keep it in the **Keychain / Android Keystore** (`@aparajita/capacitor-secure-storage`). A session found in localStorage is moved across once. The web keeps localStorage. |
| 13 | Low | V2.1.1 | Staff passwords: Auth's default minimum of 6, and the set-password screen asked for 10. | Minimum 12 characters with letters and digits: `config.toml`, the local GoTrue setting and the set-password screen. |
| 14 | Low | V2.9 / V6.2 | The service-key check and the WhatsApp verify token used `===`. | Constant-time comparison (`safeEqual`). |
| 15 | Low | V14.5.3 | With `ALLOWED_ORIGINS` unset, the functions echoed back any `Origin`. | Unset now returns `*` without echoing; `Vary: Origin` is added. Set `ALLOWED_ORIGINS` in production (checklist). |
| 16 | Low | V5.1.5 / MASVS-PLATFORM | Paths from a tapped notification were filtered by origin only. Paths like `/\evil.example` or `///evil.example` are the react-router open-redirect pattern. | `safeAppPath` refuses backslashes, whitespace and protocol-relative paths. Unit-tested. |
| 17 | Low | V14.1 | `vite` dev server listened on every network interface (`host: true`). | Now `localhost` only; `DEV_HOST=0.0.0.0` opts in. |
| 18 | Low | Information exposure, V8.2 | The nightly HIS doctor-sync summary (`app_settings.his_doctor_sync`, with unmatched HIS codes) was readable by every signed-in user. | Admin-only. |

### Checked and found sound (no change)

- **Signed URLs:** 60 s, minted as the user, so storage RLS applies. The `prescriptions` and `signatures` buckets are service-only, and prescription PDFs are streamed by a function after an RLS read.
- **Documents, prescriptions, receipts (no IDOR):**
  - `prescription-pdf` checks the row as the caller;
  - `receipt_data` checks ownership;
  - chat attachments must belong to the appointment's patient.
- **Webhooks:**
  - Razorpay: HMAC with constant-time compare, de-duplicated by event id;
  - LiveKit: HS256 JWT with `exp` and a body SHA-256;
  - WhatsApp: `X-Hub-Signature-256`;
  - MSG91: secret token, constant time.
  - All return before touching data.
- **Public QR verification:** 50-bit codes, 30 lookups per 10 min per IP. It shows only validity, doctor and date.
- **Notification links:** 128-bit tokens bound to the account; another account gets "can't be opened".
- **Secrets:**
  - none in the repo or in `VITE_` variables;
  - the service-role key is used only in functions;
  - `check-env` stops mobile builds that contain secret-looking `VITE_` variables.
- **Logs:** functions log error codes and messages only, never request bodies, phone numbers or clinical text. The audit log redacts clinical free text and device tokens.
- **RLS:** enabled and forced on every table in `public`; there are no views. OTP is 6 digits with a 5-minute expiry and a 30 s resend gap; Auth limits verification per IP.

### Accepted / open (decisions or work outside this repo)

| Item | Why it's open | What to do |
|---|---|---|
| **zod 3 advisory** (memory exhaustion with huge constrained collections, fixed in 4.6.6) | zod runs only in the browser on the user's own form input; the server never uses it. The worst case is a user slowing down their own tab. Moving to zod 4 also needs `@hookform/resolvers` 5. | Plan the zod 4 / resolvers 5 upgrade with the next form change. |
| `@capacitor/cli` → rimraf → glob / minimatch (moderate) | Build-time tool only, never shipped. | Update when Capacitor releases a CLI with newer rimraf. |
| **Captcha on OTP requests** | Needs a site key and a widget on the login screen. | Turnstile or hCaptcha via `[auth.captcha]` (commented in `config.toml`). The SMS hook already caps cost per number. |
| **Leaked-password check** for staff | Hosted Supabase setting (Pro plan). | Auth → Passwords → turn on "Prevent use of leaked passwords". |
| **Content Security Policy and security headers** on the web host | They depend on the host and on the Supabase, LiveKit and Razorpay origins in use. | Set them at the CDN; template below. |
| **Screenshots of clinical screens** (Android `FLAG_SECURE`) | This would also stop patients screenshotting their own prescription. **Sunrise to decide.** | One line in `MainActivity` if wanted. |
| **Malware scanning** of uploads | The type and PDF-active-content checks are a filter, not an antivirus. Compressed object streams can hide names. | Add a scanner (e.g. ClamAV) behind `documents-register` if Sunrise's policy requires it. |

## Production checklist

1. **Auth (dashboard):**
   - Hooks → **Send SMS** → `https://<ref>.supabase.co/functions/v1/auth-sms-hook`; put the generated secret into `supabase secrets set SEND_SMS_HOOK_SECRET=…`.
   - Set `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID`. The template is DLT-registered with an `##otp##` variable.
   - Minimum password length 12, with letters and digits; turn on leaked-password protection.
   - Make sure there are **no test phone numbers**.
   - MFA → TOTP enabled.
2. **Load only `supabase/seed/reference.sql` in production** (master data and safe defaults, no people). `supabase/seed/demo.sql` creates accounts with known passwords and refuses to run unless `app.environment = 'demo'`. Leave `app.environment` unset (or anything other than `demo`): the database then treats itself as production and always requires staff MFA, whatever `app_settings` says. Every staff member enrols on first sign-in.
3. `supabase secrets set ALLOWED_ORIGINS=https://care.sunrisehospitals.in` (and the app origins, e.g. `https://localhost,capacitor://localhost` for the mobile apps).
4. **Web host headers:**
   ```
   Strict-Transport-Security: max-age=31536000; includeSubDomains
   X-Content-Type-Options: nosniff
   Referrer-Policy: strict-origin-when-cross-origin
   Permissions-Policy: camera=(self), microphone=(self), geolocation=()
   Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<theme script hash>' https://checkout.razorpay.com;
     connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co wss://<livekit host> https://lumberjack.razorpay.com;
     img-src 'self' data: blob: https://<ref>.supabase.co; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
     font-src https://fonts.gstatic.com; frame-src https://api.razorpay.com https://meet.jit.si; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
   Cache-Control: no-cache            (index.html, sw.js)
   ```
5. Storage: buckets stay private (the migrations create them that way). Don't add public policies.
6. Edge functions deployed with `verify_jwt = false` must be exactly the signature-checked ones:
   - `payments-webhook`, `video-webhook`, `notifications-webhook`;
   - `prescription-verify` (public, rate-limited);
   - `auth-sms-hook`.

## Tests
- **`npm run db:test` → `security_hardening.sql`, 35 checks:**
  - direct writes refused: his_mrn, ABHA, profile phone, consent rewrite, notification status, document rows, document detach;
  - a finished consultation's file and object can't be deleted, while a loose file can;
  - `save_patient` still works;
  - storage reads: the owner sees their own uploads, a doctor sees registered files only;
  - audit forging refused (anon and patient); anon's only callable function is `public_content`;
  - `register_document` rules: path, owner, existence, type, size;
  - staff MFA:
    - aal1 refused when MFA is required, or when the setting is missing;
    - aal2 allowed;
    - a staff member who enrolled must use it even when MFA is not required.
- **The earlier suites were updated where the old behaviour was the bug:**
  - the RLS matrix "own profile: no direct writes";
  - notes through `save_consult_notes`;
  - an outbox rewrite is now a permission error.
- **`npm test`:**
  - upload checks: magic bytes, mismatch, size, PDF active content including hex-escaped names;
  - SMS hook: signature, tamper, stale timestamp, Indian numbers only;
  - the notification path guard against backslash and protocol-relative paths;
  - the MFA guard.
- **`npm run e2e:security` (live stack):**
  1. Staff MFA: enrolment by QR and key; a wrong code refused; a TOTP code opens the console; the next sign-in uses a fresh code.
  2. REST refusals for each finding.
  3. `documents-register`: an HTML file renamed to `.pdf` and a PDF with JavaScript are refused and deleted; another family's file is left untouched; a clean PDF is registered with the server's values.
  4. SMS hook: unsigned call refused, UK number refused, then 429 after 5 codes. The rate-limit table holds no phone numbers.
