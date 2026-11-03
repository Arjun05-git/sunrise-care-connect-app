# Notifications

Every event becomes one **outbox row per person and channel** (`notifications`). A scheduled dispatcher sends them through channel adapters and records the delivery status and cost.

| Screen | Route | What it does |
|---|---|---|
| Bell (all roles) | top bar | In-app messages, live through Realtime, unread count, "Mark all read". Opening one follows its secure link |
| Notification settings | `/p/profile`, `/d/profile` | SMS on/off, reminders on/off, push on this device. WhatsApp follows the **WhatsApp updates** consent |
| Secure link | `/l/:token` | The only kind of link we send. It opens the linked page for the account it was sent to; a signed-out user signs in first, and any other account sees "This link can't be opened" |
| Feedback | `/p/feedback/:id` | 1–5 stars and an optional comment, once per completed consultation |
| Admin → Notifications | `/a/notifications` | **Outbox**: counters per channel (sent / delivered / failed / queued / skipped, WhatsApp read), cost for the period and the month, links opened, filters, message details with a timeline, **Send again** for failed messages. **Templates**: wording in English and Malayalam, channels, WhatsApp template name, DLT id, quiet hours, on/off. **Costs**: rate per channel |

## Events

| Event | Template | Who | When |
|---|---|---|---|
| Booking confirmation | `booking_confirmed` (+ `doctor_new_booking` to the doctor) | patient, doctor | booking becomes confirmed (free, paid or late payment) |
| Payment receipt | `payment_received` | patient | payment captured |
| Reminders | `reminder_24h`, `reminder_1h`, `reminder_10m` | patient | 24 h, 1 h and 10 min before the start (scheduled job); only for bookings that existed at the reminder time |
| Join link | `reminder_10m`, `doctor_joined` | patient | 10 min before, and when the doctor enters the room and the patient isn't in yet |
| Reschedule request | `reschedule_proposed` (+ `reschedule_response` to the doctor), `rescheduled` | patient, doctor | same-day reschedule proposed / answered / moved |
| Cancellation and refund | `cancelled` (+ `doctor_booking_cancelled`), `doctor_unavailable`, `consult_missed`, `refund_initiated`, `refund_processed` | patient, doctor | cancelled by the patient or Sunrise; doctor-side cancellation or no-show; both missed; refund started / sent |
| Prescription ready | `prescription_ready` | patient | prescription signed |
| Follow-up reminder | `follow_up_due`, `follow_up_advised` | patient | 2 days before the free follow-up window closes, and the day before the doctor's follow-up date (from 10:00 IST); skipped when a booking with that doctor already exists |
| Feedback request | `feedback_request` | patient | **2 hours** after completion (`feedback_delay_minutes`), unless already rated |

The reminders, feedback and follow-ups come from `queue_scheduled_notifications()`, which runs every minute inside `run_scheduled_jobs()`. Every row has an `event_key` (unique per person, channel and event), so re-running a job never sends twice.

## Routing and opt-in (`enqueue_notification`)
Each template lists its channels. Patient templates use **WhatsApp + SMS + push + in-app**, and every message goes on WhatsApp **and** SMS (Sunrise's choice). Doctor templates use SMS + push + in-app.

| Channel | Sent when | Otherwise |
|---|---|---|
| WhatsApp | the account has the `whatsapp_opt_in` consent and a phone number | row `skipped`, reason `no_opt_in` / `no_phone` |
| SMS | the SMS preference is on and there is a phone number | `skipped`, `opted_out` / `no_phone` |
| Push | the user has at least one subscribed browser (Web Push) or app install (FCM device token) | not created |
| In-app | always | delivered at once |

Turning **reminders** off skips the reminder category on WhatsApp, SMS and push; reminders still appear in the app.

**Quiet hours, 9 pm – 8 am IST** (`notification_quiet_hours`): templates marked *quiet hours* (24-hour reminder, follow-ups, feedback) that fall in that window are held until 8 am. Time-critical messages are never held.

## No clinical details
- Template variables are whitelisted: `name` (first name only), `doctor`, `date`, `time`, `ref`, `link`, `amount`, `response`, `otp`, `minutes`. Anything else passed by mistake is dropped, and admins cannot save a template with another placeholder.
- Doctor names are included (they are not clinical). Symptoms, diagnoses, drugs and documents never are.
- Every link is `<public_url>/l/<32 hex token>` (`notification_links`). It resolves only for the account it was sent to, and it opens the page inside the app after sign-in. The dispatcher refuses any message containing another URL.
- The outbox stores masked numbers (`+91 98•••••001`). Logs carry ids and status only.

## NotificationService (`supabase/functions/_shared/notify/`)
`notifications-dispatch` is service-only and runs every minute (locally every 5 s). It:
1. claims due rows (`claim_notifications`, a 5-minute lease, `skip locked`);
2. re-checks each message (`guard.ts`: links, length);
3. sends through the adapter;
4. records the result:
   - `mark_notification_sent` stores the provider id and cost;
   - `mark_notification_failed` retries temporary errors with backoff, up to **3 attempts**, then fails;
   - permanent errors fail at once.

| Adapter | Provider | Notes |
|---|---|---|
| `whatsapp.ts` | WhatsApp Cloud API | Approved template by name (`sunrise_<key>_v1`), named parameters, language `en` / `ml` |
| `msg91.ts` | MSG91 Flow API | DLT template id per template |
| `webpush.ts` | Web Push | VAPID (ES256) and `aes128gcm` encryption on WebCrypto; expired subscriptions (404 / 410) are removed |
| `fcm.ts` | Android / iOS app push | FCM HTTP v1 with a service-account OAuth token (RS256); title and body only, the `/l/` link in data; Android channel `sunrise_default`; `UNREGISTERED` tokens are removed. `CombinedPushAdapter` sends one push row to every browser and app of the user — see [MOBILE.md](MOBILE.md) |
| `mock.ts` | local / tests | Numbers ending **99** fail permanently, **98** fail temporarily |

Delivery reports go to **`notifications-webhook`** (`verify_jwt = false`):
- `?provider=whatsapp`: Meta's GET verification (`WHATSAPP_VERIFY_TOKEN`), then POSTs signed with `X-Hub-Signature-256` (`WHATSAPP_APP_SECRET`); delivered / read / failed;
- `?provider=msg91&token=…` (`MSG91_WEBHOOK_TOKEN`): delivered / failed.

Status only moves forward (queued → sent → delivered → read).

### Costs
`app_settings.notification_costs` holds the rates in paise: WhatsApp 13 per message, SMS 25 **per part**, push 0. They can be edited in Admin → Notifications → Costs (admin, finance). An SMS part is 160 characters, or 70 when the text has Malayalam. With the 32-character link token, most SMS run to **2 parts**.

### Configuration
```
supabase secrets set WHATSAPP_TOKEN=… WHATSAPP_PHONE_NUMBER_ID=… WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=… \
  MSG91_AUTH_KEY=… MSG91_WEBHOOK_TOKEN=… VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:…
```
- App push: `FCM_SERVICE_ACCOUNT` (the Firebase service-account JSON) – see [MOBILE.md](MOBILE.md).
- The client needs only `VITE_VAPID_PUBLIC_KEY` (public). Generate a pair with `npx web-push generate-vapid-keys`.
- A channel without configuration fails its messages with `channel_not_configured`, so the gap shows in the Outbox instead of messages being dropped silently.
- Set `app_settings.public_url` to the app's address. Links are built from it.
- Before going live:
  - each WhatsApp template (`sunrise_<key>_v1`) must be approved in Meta Business Manager with the same wording;
  - each SMS template must be registered on the DLT portal. The seeded DLT ids are **placeholders**.

Locally `npm run stack:up` uses the mock providers (`NOTIFY_PROVIDER=mock`), generates a VAPID pair once (`.local-stack/vapid.env`) and writes the public key to `.env.local`.

## Admin
- **Outbox**: admins, coordinators and finance can read it. Admins and coordinators can **Send again** a failed message, which resets its attempts.
- **Templates**: only admins can edit them (`save_notification_template`). Every placeholder must be allowed, at least one channel is required, and a reason is required; the change is audited.
- Changing WhatsApp or SMS wording needs a new Meta / DLT approval, so change the template name or id along with the text.

## Tests
- **`npm run db:test` → `notifications_flow.sql`, 53 checks**:
  - routing and opt-in per channel, skip reasons;
  - whitelisted variables and secure links, link ownership;
  - quiet hours;
  - event triggers, de-duplication;
  - 24 h / 1 h / 10 min reminders, feedback after 2 h, both follow-up reminders;
  - dispatcher claim / sent / retry / fail, monotonic delivery status, costs;
  - stats, retry, template validation, rights;
  - ratings.
- **`npm test`**: message guard, SMS parts, WhatsApp / MSG91 request shapes and webhook parsing, Web Push encryption and VAPID token, dispatcher.
- **`npm run e2e:notifications`** (real stack, mock providers):
  - a booking → WhatsApp + SMS + in-app delivered, with costs;
  - no clinical text and only `/l/` links;
  - the scheduled job queues the 1-hour reminder once;
  - live bell;
  - secure link, signed in and signed out; another account's link refused;
  - SMS opt-out → skipped;
  - failed messages → admin Outbox counters, filters, masked numbers, Send again → delivered;
  - template edit (unknown placeholder refused, reason, audit);
  - cost rates;
  - feedback after a completed consultation.
