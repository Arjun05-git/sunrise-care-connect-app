# Visual and copy review: what changed

**Reviewed 2 Nov 2026.** Every screen of all three roles was captured at a **360 px phone** and a **1920 × 1080 desktop**, then reviewed on contact sheets:
- `scripts/ux-shots.mjs`, 120 screenshots;
- including the states testing usually misses:
  - **empty** (a brand-new patient);
  - **error** (the API blocked after sign-in);
  - **slow loading** (the API delayed 8 s);
  - **start-up with the service unreachable**.

Aim: friendlier and simpler, with **no new elements on screen**. Every change below fixes something seen in the screenshots.

## Small phones (360 px)
| Where | Before | After |
|---|---|---|
| Symptoms form | Page scrolled sideways (367 > 360 px): the "Add readings (BP, sugar, temperature…)" button couldn't wrap | Shorter label ("Add BP, sugar or temperature"). **All buttons** now wrap a long label onto a second line, keeping the 44 px minimum height, instead of running off the screen. This matters most in Malayalam. |
| Admin → Doctors filter, Admin → Masters tabs | Labels **overlapped each other**. This came from the earlier accessibility pass, which let tabs shrink. | Tabs and option groups keep their natural width and scroll sideways (scrollbar hidden) or wrap. Nothing overlaps or is cut. |
| Page titles (Help & support, tickets, admin pages) | Titles and subtitles cut off with "…" whenever the page had an action button ("Help & sup…") | Titles and subtitles wrap to two lines, and the action moves under the title when there's no room beside it. One change, in `PageHeader`. |
| Profile → Me & family | Names cut off ("Sarojini M…") | Names and details wrap. The delete icon is muted grey instead of red in every row; the confirmation dialog still guards it. |
| Doctor cards (Find a doctor) | "from ₹…" sat sometimes beside and sometimes under the Audio/Video badges | The price always sits right-aligned above **Book**. |
| Search fields | Placeholders cut off ("Doctor name, speciality o…", "Search by code or words, e.g. J…") | "Search doctors"; "Code or words, e.g. fever". |
| Doctor → appointment → documents | Long file names widened the page to 384 px at 320 px (a grid column grows to fit truncated text) | The column is capped at the screen width (`grid-cols-[minmax(0,1fr)]`). The same guard went on all 21 one-to-two-column grids (forms, admin cards, help), so no long name or email can do this elsewhere. |

## Large screens (1920 px)
| Where | Before | After |
|---|---|---|
| Emergency notice on single-column pages | Stretched 1152 px wide under 672 px of content | Same width as the content column (`max-w-2xl`), centred |
| Doctor → Profile | The "Profile" heading sat halfway down the page, below the Availability, Signature and Notifications cards, in a left-aligned column | Heading first, with the doctor's name. One centred column, like the patient profile. |
| Settings (staff, doctor) | Left-aligned narrow column | Centred, like other single-column pages |

Checked and already consistent: patient pages share one centred column; admin pages share one full width beside the sidebar; Find a doctor and the doctor profile use their two-column layouts.

## Loading, error and empty states
| State | Before | After |
|---|---|---|
| **Screen fails to load** | Red alert icon with "Something went wrong. Please try again." after **≈ 15 s of skeletons**: supabase-js retried 3× on top of React Query's retry, which meant 8 requests | Grey cloud icon with **"We couldn't load this"**, "Check your internet connection and try again", and **Try again**. When the phone is offline: "You're offline" and a Wi-Fi icon. It appears after **≈ 1.3 s**: supabase-js retries are off (`db: { retry: false }`) and React Query retries once. |
| **App start-up, service unreachable** | The logo and spinner span **forever** | After 8 s: "This is taking longer than usual. Check your internet connection, or try again." and a **Try again** button |
| **Live badge** | The pill was stretched to the width of "Connecting…" and looked half empty | Always reads "Live": a grey dot while connecting (screen readers hear "Connecting…") and a green pulsing dot when live. Same width in both states, so the header never jumps. Only "Offline – refresh to update" changes the text, because then the person has to act. Tests wait on `data-live="live"`. |
| Calendar day with no bookings | "0 consults" | "No bookings" (an i18next `_zero` plural) |
| Empty-state titles | Mixed: some ended with a full stop ("No integration events.") | No full stop on any title |

Skeletons were already used on lists (22 places) and cards (5), and the shared error component on 21 screens. Small "nothing here" lines inside cards (no documents, no refunds) were left as they are; a full illustration there would be clutter.

## Copy tone (English and Malayalam together)
| Key | Before | After |
|---|---|---|
| `auth.err.invalid_otp` | "That code is not correct. **In demo mode use 123456.**" (the demo hint would have reached real patients) | "That code doesn't match. Check the SMS and try again." The demo card on the sign-in screen already shows the test code. |
| `common.error` (failed actions) | "Something went wrong. Please try again." | "That didn't work. Please try again." |
| `pay.failed` | "Payment failed. You can try again while the slot is held." | "The payment didn't go through. You can try again while your slot is held." |
| New: `common.loadErrorTitle` / `loadErrorBody`, `offlineTitle` / `offlineBody`, `slowBody` | (generic text) | Plain words, one suggestion each, see above |
| `patient.pre.vitals`, `patient.doctors.searchPh`, `clinical.dx.placeholder`, `doctor.cal.count_zero` | Long or cut off | Short, see above |

The rest of the patient copy was already warm and specific ("Sorry, someone just booked that time…", "Your doctor needs an answer about 1 booking"). It was kept.

## Verified
- **Recapture:** 120 screens, **no sideways scrolling at 360 px** (there were 3 overflows before).
- **Error state:** shown after 1.3 s, with 2 requests.
- **Type, unit and translation checks pass:** 182 unit tests; 2,142 keys in both English and Malayalam.
- **Accessibility:** 97 screens (light and dark), 0 axe WCAG 2.1 AA violations, and no reflow failures at 320 px with 130 % text.
- **End-to-end:** all suites pass: patient, payments (UI and API), doctor, video, prescription, notifications, admin, integrations, security, and the 5 critical journeys. Admin, doctor, patient and journeys were run again after the grid change.
  - The patient suite timed out once on a click in the booking step, after other suites had run against the same database. It passed straight away on rerun. The same happened before this change, so it is a test-timing issue, not a layout issue.
- **Production builds:** PWA test (service worker, update prompt, offline shell, iOS install hint) and demo smoke test (including the style guide at phone width) pass.

## Not changed (needs a decision or more than a tweak)
- **Admin tables on phones** (Masters, Support) scroll inside their card. Phone use by staff is secondary, and a card-per-row layout for every admin table would be a larger redesign.
- **The consent screen is long**, because each consent shows its full wording. That's deliberate for DPDP; shortening it is a legal decision, not a design one.
