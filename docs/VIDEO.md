# Video consultations

| Screen | Route | What it does |
|---|---|---|
| Waiting room (patient) | `/p/consult/:id` | Doctor and time, countdown to the join window, device check, doctor-in-room / running-late status, Join, emergency notice, "Not recorded" |
| Before you start (doctor) | `/d/consult/:id` | Same device check, whether the patient is waiting, symptoms with red flags, Start consultation |
| In call (both) | same routes | Full screen, outside the tab shell: remote video, self view, mute, camera, audio only, chat, network quality, elapsed time, reconnect banner, "connection lost" recovery |
| Doctor side panel | in call | Symptoms · Documents (viewer, includes files shared in chat) · Notes (autosaved draft) · Chat |
| After the call | same routes | Patient: left / completed / stopped (rejoin while the room is open). Doctor: Completed / Patient didn't join / Technical failure / Rejoin |
| Call log | `/d/appointments/:id` | Doctor joined, patient joined, call start and end, duration, worst quality and share of poor samples, reconnects, problems with reasons, provider, "Not recorded" |

Entry points: **Join consultation / Waiting room** on patient Home, Appointments and the booking-confirmed screen, and **Start consultation** on the doctor's Today card and appointment page. They appear on the day of the consultation and become the primary button once the room is open.

## VideoProvider
The app only talks to `src/services/video/types.ts`:

```ts
interface VideoProvider { name: 'livekit' | 'jitsi'; connect(creds, { mic, camera, audioOnly, micId, cameraId, speakerId, remote, local }): Promise<VideoCall> }
interface VideoCall {
  on('state' | 'quality' | 'remote' | 'ended', cb); setMic(on); setCamera(on); setAudioOnly(on); setLocalElement(el); disconnect();
}
```

| Provider | Use | Notes |
|---|---|---|
| **LiveKit** (`livekit.ts`, `livekit-client` 2.6) | Production | Adaptive stream + dynacast, 540p capture, per-participant connection quality, SDK resume / full reconnect, device errors. Audio only = stop publishing the camera **and** unsubscribe from remote video (saves bandwidth both ways). |
| **Jitsi** (`jitsi.ts`, IFrame API) | Demo fallback | Jitsi renders its own video inside our layout; our controls drive it (`toggleAudio`, `toggleVideo`, `setAudioOnly`, `hangup`). No SFU quality metric through the IFrame API, so the indicator is hidden. The public `meet.jit.si` makes the first participant sign in as moderator and limits embedded calls, so use a self-hosted Jitsi (`JITSI_DOMAIN`) for anything beyond a demo. |

Both SDKs load only when a call starts (separate chunks; LiveKit ≈ 94 KB gzip), never in the main bundle.

**Server side** (`supabase/functions/_shared/video/`): `VIDEO_PROVIDER=livekit` with `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (optional `LIVEKIT_PUBLIC_URL` if browsers reach LiveKit at a different address). With anything else set, the server uses Jitsi (`JITSI_DOMAIN`, default `meet.jit.si`).

```
supabase secrets set VIDEO_PROVIDER=livekit LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…
```
In LiveKit, add the webhook URL `https://<project>.supabase.co/functions/v1/video-webhook`.

## Flow
1. The client calls the **`video-token`** edge function with the appointment id.
2. That function calls `join_consult()` **as the user**, which:
   - checks they are this booking's doctor or patient;
   - checks the status (confirmed / in progress) and the join window;
   - creates the room name once, as random text with no names or ids;
   - stamps `doctor_joined_at` or `patient_joined_at`;
   - moves the booking to **in progress** once **both** the doctor and the patient have joined (either one alone leaves it confirmed);
   - writes a `join` call log.
3. Only then does the function sign credentials. LiveKit gets a HS256 JWT with:
   - a grant to join **this room only**;
   - publish, subscribe and data rights;
   - `roomRecord`, `roomAdmin` and `roomCreate` set to **false**;
   - a lifetime that runs until the window closes plus 5 minutes (5 to 120 minutes).

   The display name is the doctor's full name, or the patient's **first name only**.
4. The **`video-webhook`** function (no user JWT, `verify_jwt = false`) verifies LiveKit's signature:
   - the Authorization JWT is signed with the API secret;
   - the issuer is the API key;
   - the `sha256` claim matches the body.

   It then records `room_started`, `participant_joined`, `participant_left` (with the disconnect reason) and `room_finished` as **server-side** call logs. Rooms that aren't ours are ignored.

### Join window (`app_settings`)
- **Opens** `join_window_minutes` (10) before the start.
- **Closes** `join_close_minutes` (30, new setting) after the scheduled end, plus any extension.
- The server enforces it. The waiting room counts down on the server clock and re-checks when the window opens.

### No-shows and technical failures
`sweep_no_shows()` runs every minute in `run_scheduled_jobs()`. It looks only at consultations that started within the last day, so it never rewrites history.

Automatic decisions wait **30 minutes** after the start (`auto_doctor_no_show_minutes`, `auto_patient_no_show_minutes`, confirmed by Sunrise on 2026-10-26). The doctor can still mark "patient didn't join" by hand after `patient_grace_minutes` (10).

- **Doctor never joined, the patient did**, by start + 30 min:
  - The booking becomes *doctor no-show*, through the same path as a doctor cancellation.
  - The patient chooses a **free reschedule or a full refund**.
  - With no choice in `doctor_no_show_auto_refund_hours`, the refund is automatic.
  - The waiting room tells the patient this as soon as the doctor is late.
- **Neither joined**, by start + 30 min:
  - The booking becomes *both no-show* (`both_no_show`) and is cancelled; the slot reopens if it is still in the future.
  - The patient is offered a **free reschedule with the same doctor, on any future date**.
  - A refund is given **only if the patient asks** for it ("Request a refund instead"); there is no automatic refund.
  - The patient gets a `consult_missed` notification.
- **Doctor joined, patient never did**, by start + 30 min:
  - The booking becomes *patient no-show*.
  - The refund follows `patient_no_show_refund_percent` (default 0 %).
  - The doctor can mark this by hand from 10 minutes after the start.
- **Technical failure**, from the after-call screen or the appointment page:
  - The doctor must give a note.
  - The patient gets the free-reschedule-or-refund choice.
  - Patients can **Report a problem**. Only a category is logged (no sound / video / network / other), never the text they typed.
- **Recovery**:
  - The SDK first resumes the connection on its own. The reconnect banner shows while it does.
  - If the connection is lost, the app joins again with a fresh token, 3 times (after 2, 5 and 10 s).
  - After that, both people see "Connection lost" with Reconnect, Reconnect with audio only, Report a problem and Leave.
  - Being replaced by another tab or device is never retried, so two tabs don't fight over the seat.

### Call logs (`call_logs`, RLS: the two participants and admins read; only RPCs and the webhook write)
- **Client** events go through `log_call_event`, rate-limited to 120 per 10 minutes:
  - `leave`, `end` (doctor only), `reconnecting`, `reconnected` (with seconds), `disconnected` and `failure` (with a reason code), `device_error`, `audio_only`, `video_on`;
  - `quality`, sent once a minute: a count of 5-second samples per level (excellent / good / poor / lost) and the worst level.
- **Details are whitelisted** (keys such as `reason`, `quality`, `seconds`, `provider`, each 80 characters or fewer). No names and no clinical text are stored; the e2e test checks this.
- **`call_summary()`** gives the doctor's call-log card:
  - start = when both people were in the room;
  - end = the last end or leave;
  - duration;
  - worst quality and share of poor samples;
  - reconnects;
  - problems with reasons;
  - provider.

### Chat and file share
- **Sending**: `send_chat_message()` takes the sender's role from the caller, never from input. It only works while the room is open, accepts up to 2000 characters and is rate-limited to 60 per 5 minutes. Direct inserts are closed.
- **Files**: both sides can share a PDF, JPG or PNG up to 10 MB, checked by magic bytes.
  - Files go to the patient's private `medical-documents` store, with the same validation and storage RLS as other uploads.
  - A shared file **joins the consultation's documents**, so the doctor sees it in the Documents tab and later on the appointment.
  - Files open through 60-second signed URLs in a new tab.
- **Delivery**: messages arrive through Realtime. `chat_messages` is RLS-filtered per subscriber. The other person sees an unread badge.

### Live notes
- `save_consult_notes()` saves the doctor's draft. This is the `consultations` row the prescription phase will finish.
- It autosaves 1.5 s after typing stops and when the panel closes, and shows Saved / Saving / Not saved with a retry.
- Patients can't read drafts.
- The audit log redacts the note text.

## Recording is off
- There is **no code path that starts a recording**.
- LiveKit tokens never grant `roomRecord`, and no egress is configured.
- Jitsi gets `fileRecordingsEnabled`, `liveStreamingEnabled`, `recordingService`, `localRecording` and `transcription` all off, and its toolbar is hidden.
- `app_settings.recording_enabled` is `false`, and `consult_access`, the token response and `call_summary` all report `recording: false`.
- Both sides see **"Not recorded"** in the waiting room and during the call.

## Device check
- **Camera**: live preview.
- **Microphone**: live level meter.
- **Pickers**: camera, mic and speaker (the speaker picker only where the browser supports `setSinkId`).
- **Speaker test**: a 1-second tone, generated locally.
- **Connection**: round-trip time to our own API, with no third parties. Slow or 2G connections are told audio only is recommended.
- **Blocked or busy devices**: specific help text, then Check again.
- Chosen devices are remembered per browser.
- Audio consultations skip the camera.
- If the connection stays poor for 15 s during a call, the app offers audio only.

## Local stack
`npm run stack:up` starts a LiveKit SFU on :7880 when `/opt/sb/livekit/livekit-server` (or `LIVEKIT_BIN`) exists:
- dev key `devkey`;
- recording not configured;
- RTC on 127.0.0.1, with UDP 50000–50100 and TCP 7881;
- webhooks go to the gateway.

The edge functions run in the gateway. Without the binary, the stack falls back to Jitsi.

## Tests
- **`npm run db:test` → `video_flow.sql`, 44 checks**:
  - join window;
  - roles and room creation;
  - joined timestamps and in-progress;
  - whitelisted log details;
  - webhook and service-only access;
  - summary;
  - chat rules and file attach;
  - notes privacy and audit redaction;
  - doctor and patient no-show sweep, including no rewrites of old bookings and idempotence.
- **`npm test`**:
  - HS256 against Node crypto;
  - token grants (`roomRecord` false) and lifetime;
  - webhook signature (body tamper, wrong key, wrong secret);
  - Jitsi config (recording off, display name, hostname-only domain, toggle state);
  - quality aggregation.
- **`npm run e2e:video`**: two Chromium browsers with fake camera and microphone in a **real LiveKit room**:
  - waiting-room countdown;
  - device check;
  - token claims;
  - patient waits, then the doctor starts;
  - video both ways and the quality indicator;
  - chat and file share into Documents;
  - notes autosave;
  - mute and audio only;
  - **LiveKit killed and restarted mid-call → both reconnect**;
  - webhook logs;
  - the doctor ends → completed, and the patient is told live;
  - the call-log card;
  - a technical failure → the patient is offered the fallback;
  - no names or clinical text in the logs.
