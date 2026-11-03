# Quality: critical journeys, accessibility, mobile performance

**Measured 2 Nov 2026** on the local stack (`npm run stack:up`), from a production build where it matters.

## 1. Critical journeys: `npm run e2e:journeys`

Each run signs up a **brand-new patient** with a fresh test number (`98479991NN`). So every run starts from nothing, can be repeated, and doesn't disturb other suites. It ran twice back to back on the same database: **5/5 passed both times**.

### 1. Book and pay
**Flow:**
1. OTP sign-up → consent → profile → find Dr Meera.
2. Pick a slot → symptoms form → 10-minute hold → UPI payment (test gateway).
3. Booking confirmed → receipt PDF downloaded.

**What is verified:**
- The amount on the Pay button equals the server's `resolve_fee`.
- The appointment is `confirmed` at that fee, and the slot is `booked` for it.
- The payment is `captured` with a receipt number.
- The confirmation message is queued, and the booking shows in My appointments.

### 2. Free follow-up
**Flow:**
1. A consultation completed 3 days ago → the home screen offers "Free follow-up with Dr. Meera Krishnan".
2. Pick a slot → "Free follow-up" → form → **Confirm booking**, with no payment step.
3. Open the same doctor again.

**What is verified:**
- The follow-up booking has fee 0, is `is_free`, and has **no payment row**.
- Policy (1 free follow-up within 14 days): the next booking with that doctor shows **"Follow-up fee: ₹300"**. That equals the server's follow-up fee and is not free.
- The shortcut disappears once the free follow-up is used.

### 3. Doctor same-day reschedule
**Flow:**
1. The doctor proposes a later time today, with a message.
2. The patient's page shows it **live**, without a reload.
3. The patient accepts → the doctor's page updates live.

**What is verified:**
- The old booking is `rescheduled` and the new one is `confirmed` on the proposed slot.
- **The payment moved** to the new booking.
- The old slot is **open** again and the new slot is booked.
- The patient was sent both `reschedule_proposed` and `rescheduled`.

### 4. Doctor cancels with refund
**Flow:**
1. The doctor chooses "I can't take this consultation" and adds a note.
2. The patient sees the choice **live** → picks "Full refund (₹800)".

**What is verified:**
- The appointment is `cancelled / cancelled_by_doctor`.
- The refund is `processed` for the **whole payment**, and the payment is `refunded`.
- The choice card goes away, and the patient is told about the cancellation and the refund.

### 5. Prescription with a drug-rule block
**Flow:**
1. Audio **first** consultation.
2. Amoxicillin (List A) and Alprazolam (Prohibited) are **blocked, with the reason shown**, and the Add button is disabled.
3. Paracetamol is added → signed with the PIN.

**What is verified:**
- The API refuses the blocked drug too (`save_rx_draft` → `drug_blocked`).
- The prescription is `final` with a number in the `SCRX-…` format, its only item is Paracetamol, and the notes are locked.
- The PDF is stored, and later edits are refused.
- The patient sees the prescription in Records.
- The **public QR check** says "Valid prescription" and shows the doctor but **not the patient's name**.

The older per-feature suites (`e2e:patient`, `e2e:payments`, `e2e:doctor`, `e2e:prescription` …) still cover the many side paths. This suite is the short list that must never break.

## 2. Accessibility: `npm run a11y` (WCAG 2.1 AA)

**What it checks:**
- **axe-core 4.11** with the WCAG 2.0/2.1 A + AA rules, on **82 screens**:
  - every main screen for patients and doctors at phone width, and staff at desktop width;
  - in **light and dark** themes;
  - plus states that only exist after an action: the symptoms form with errors, the review with a hold, the **checkout dialog**, the fee-edit reason dialog, and **staff MFA enrolment**.
- **Reflow (WCAG 1.4.10):** 15 patient, doctor and login screens at **320 CSS px with the largest text size (130 %)**. Nothing may need sideways scrolling.
- The script fails on any violation, so it can run in CI.

### Before
- **axe:** 21 of 82 screens failed, on 6 rules.
- **Reflow:** 15 of 15 screens failed.

| Rule (impact) | Where | Fix |
|---|---|---|
| `aria-valid-attr-value` (critical) | Language and theme pickers, admin doctor-status filter, user-kind filter: Radix **Tabs used as value pickers** with no tab panels, so `aria-controls` pointed at nothing | New `Segmented` control (`components/ui/segmented.tsx`), a WAI-ARIA **radio group**: one Tab stop, arrow keys move and select. Unit-tested. Tabs are kept where there are real panels. |
| `aria-required-parent` (critical, 120 elements) | Dashboard charts: focusable bars had `role="listitem"` inside an `svg role="img"` | The chart is now a labelled `role="group"` with a `role="list"` of bars, so screen readers can reach each bar's value. |
| `label` (critical) | Hidden file inputs behind the "Upload" buttons (patient documents, doctor credentials) | Given an accessible name and taken out of the tab order; the visible button opens them. |
| `link-name` (serious) | Calendar → Availability, an icon-only link on phones | `aria-label` added. |
| `scrollable-region-focusable` (serious) | Report table scroll box | Focusable region with a label and a focus ring. |
| `color-contrast` (serious, dark) | Version number on the selected item in Consent & terms (3.7 : 1) | Uses the item's own foreground (≥ 4.5 : 1). |
| Reflow at 320 px (serious) | Top bar (wordmark plus 4 icon buttons), login role tabs, "Join consultation" button, badges, the template buttons in notes, availability time inputs, two-column layouts whose grid items couldn't shrink | Below 360 px the wordmark becomes screen-reader-only and tab padding tightens. The join button and badges may wrap. Template buttons wrap. Time inputs flex. `min-w-0` added to layout grid children. |

Two more issues showed up only once the journey suite had created cancelled and refundable bookings. Both were fixed:
- **Calendar:** cancelled bookings were dimmed with 60 % opacity (4.48 : 1 contrast). They now use the muted text colour with a strike-through.
- **Patient choice buttons** ("Full refund", "Request a refund instead", "Accept", "Pick another time") now wrap rather than running off a 320 px screen.

### After
- **0 violations on all 97 checks:** 82 axe screens + 15 reflow screens.

**Not covered.** Automated checks find roughly a third to half of real accessibility problems. **No manual screen-reader pass has been done yet.** These still need a person to check:
- screen-reader wording and announcements;
- reading order in Malayalam;
- whether error messages make sense.

A short pass with TalkBack (Android) and VoiceOver (iOS) on the five journeys is recommended before launch.

## 3. Mobile performance on throttled 4G: `npm run perf`

**Method:**
- **Tool:** Lighthouse 12.8, phone form factor.
- **Network:** Lighthouse's **Slow 4G** profile, *applied* by DevTools (real throttling, not simulated): 1.47 Mbps down, 675 kbps up, 562 ms per request (150 ms RTT).
- **CPU:** slowed 4×.
- **Runs:** every run is a **cold load**: HTTP cache, service worker and Cache Storage are cleared, and the sign-in is kept. Median of **3 runs** per page.
- **Pages:** the login page, plus five signed-in patient and doctor screens.

**Two servers:**
- **`vite preview`:** HTTP/1.1, no compression of API responses. This is the baseline server, used for a like-for-like comparison.
- **`scripts/perf-server.mjs`:** HTTP/2 + gzip with immutable asset caching, like a CDN in front of hosted Supabase. This is what users will actually get.

**Google's "good" thresholds:**
- FCP ≤ 1.8 s;
- LCP ≤ 2.5 s;
- CLS ≤ 0.1;
- TBT ≤ 200 ms.

### Results
Columns: Lighthouse score; **FCP** = first paint; **LCP** = largest content painted; **TBT** = total blocking time; **CLS** = layout shift.

| Page | Before (preview) | After (preview) | **After (HTTP/2, production-like)** |
|---|---|---|---|
| Login, first visit | 76 · FCP 4.2 s · LCP 4.2 s · TBT 0 · CLS 0.004 | 80 · 2.0 s · 3.8 s · 269 ms · 0.000 | **87 · 1.8 s · 3.2 s · 248 ms · 0.000** |
| Patient home | 42 · 6.1 s · 6.1 s · 24 ms · **0.556** | 69 · 2.0 s · 6.7 s · 149 ms · 0.041 | **69 · 1.9 s · 5.7 s · 294 ms · 0.041** |
| Find a doctor | 61 · 6.1 s · 6.1 s · 165 ms · 0.063 | 64 · 2.0 s · 5.8 s · 386 ms · 0.057 | **68 · 1.8 s · 5.1 s · 375 ms · 0.057** |
| Doctor profile + slots | 60 · 6.1 s · 7.0 s · 49 ms · 0.093 | 65 · 2.0 s · 6.7 s · 291 ms · 0.025 | **72 · 1.8 s · 5.8 s · 205 ms · 0.025** |
| My appointments | 62 · 6.2 s · 6.2 s · 54 ms · 0.063 | 65 · 2.0 s · 6.7 s · 263 ms · 0.029 | **71 · 1.8 s · 5.8 s · 195 ms · 0.029** |
| Doctor Today | 48 · 5.4 s · 7.0 s · 19 ms · **0.284** | 65 · 2.0 s · 6.7 s · 297 ms · 0.001 | **72 · 1.8 s · 5.9 s · 188 ms · 0.001** |
| Doctor appointment | 64 · 5.4 s · 6.4 s · 49 ms · 0.001 | 70 · 2.0 s · 5.3 s · 292 ms · 0.001 | **77 · 1.8 s · 4.4 s · 273 ms · 0.001** |
| JavaScript transferred | 326 KB on every page | 262 KB | 253 KB |

### What changed and why
1. **Fonts no longer block the first paint** (−1.3 s).
   - **Before:** the Google Fonts stylesheet was render-blocking.
   - **Now:** it loads asynchronously with `display=optional`. Text never re-flows when the font arrives. On a slow first visit the system font is kept; later visits use the cached web font.
2. **The app shell is painted from the HTML.** `index.html` shows the logo and wordmark before any JavaScript runs, and `BootLoader` keeps the same look while the session restores. First paint is now **1.8–2.0 s** on every page, down from 4.2–6.2 s.
3. **Less JavaScript up front** (332 → 264 KB gzipped). Malayalam strings (~40 KB) now load only when Malayalam is chosen, and are applied before the first render for Malayalam users, so there's no English flash. The Style Guide page is lazy. The login form uses two tiny resolvers instead of zod (~13 KB).
4. **Layout shifts fixed.**
   - **Home 0.556 → 0.041:** the free-follow-up and "needs your answer" banners loaded later and pushed the list down. Home content now appears in one pass once its data is ready.
   - **Doctor Today 0.284 → 0.001:** the Live badge changed width from "Connecting…" to "Live" and re-wrapped the header. It now keeps one width, through a CSS-only placeholder, so screen readers don't read it twice.
   - **Emergency notice:** the content area reserves 75 % of the screen height, so the notice below it starts off-screen instead of being pushed around.

**Tried and rejected.** Preloading the current page's code at start-up was A/B tested:
- **HTTP/1.1:** it made first paint **1.5 s slower**, because the preloads queued in front of the sign-in API calls on the 6 available connections.
- **HTTP/2:** it made no consistent difference (within noise), and it added 15 KB.

So it was removed.

### Honest reading
- **CLS:** **good** on every page (≤ 0.06); two pages were "poor" before.
- **FCP:** **good** on HTTP/2 (1.8 s).
- **TBT** went up, although the app does no more work. Lighthouse counts blocking only *after* first paint, and first paint now comes before the app's start-up script runs. Doctor Today and My appointments are under 200 ms; Find a doctor is the highest at 375 ms.
- **LCP is still "poor" on signed-in pages** (4.4–5.9 s on HTTP/2). The rest is a chain of round trips that each cost ~0.56 s on this profile: app JS → session check (roles + name) → patient gate (consents, profile, settings) → page code → page data. Next steps, in order of value:
  1. **One start-up call:** a `bootstrap()` RPC that returns role, name, consent status and the primary profile together. This saves one to two round trips (~0.6–1.1 s).
  2. **Cache-friendly reference data:** `settings` and `masters` change rarely. They can use a long `staleTime` and be persisted, so a returning user skips them.
  3. **Brotli** on the CDN; the measurement used gzip.

  Trusting a role cached on the phone would also cut a round trip, but it breaks the rule in docs/SECURITY.md and docs/MOBILE.md that the role is never taken from stored data, so it was not done.
- **Network profile:** Lighthouse's Slow 4G is deliberately harsh. On a typical Kerala 4G connection (≈10 Mbps, 50–100 ms) the same build loads several times faster. The numbers above are the floor, not the typical case.

## Regression after these changes
- **DB:** 10 suites, 619 checks.
- **Unit:** 182 tests, plus the type and translation checks.
- **End-to-end:** all 14 suites pass:
  - patient, payments UI and API, doctor, video, prescription, notifications, admin, integrations, security, **journeys**;
  - PWA on a production build;
  - demo smoke.
- **Tests updated for the new semantics:**
  - dashboard charts are now a `group` with a `list`;
  - the language and theme pickers are now `radio`s;
  - consent boxes are ticked with `check()`.
- **Bug found by the regression and fixed:** the consent page applied saved consents *after* the first paint. For one frame every box showed unticked, and a quick tap in that frame toggled a consent **off**. The saved consents are now applied before paint (`useLayoutEffect`).

## Files
| File | What it is |
|---|---|
| `scripts/e2e-journeys.mjs` | The five journeys. |
| `scripts/a11y.mjs` | Accessibility audit. Writes `a11y-report.json`; set `A11Y_DETAIL=1` for element-level output. |
| `scripts/perf-mobile.mjs` | Lighthouse runner. Writes `perf-report.json`; `PERF_DETAIL=1` prints the LCP element, layout-shift sources and render-blocking requests; `PAGES=` filters pages. |
| `scripts/perf-server.mjs` | HTTP/2 + gzip server for production-like measurement. |
| `src/components/ui/segmented.tsx` | Radio-group value picker; tests in `src/test/segmented.test.tsx`. |
| `src/components/feedback/LiveBadge.tsx` | Width-stable Live badge. |
| `BootLoader` in `src/components/feedback/states.tsx`, `#root` in `index.html` | The app shell. |
