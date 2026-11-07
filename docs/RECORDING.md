# Consultation recording

Recording applies **only to consultations held through the app** (audio and video appointments). It is **off by default**
(`app_settings.recording_enabled = false`); the demo seed turns it on. Built in four parts; this page says what exists now.

| Part | What | Status |
|---|---|---|
| 11a | Consent, the recording record and its state machine, private storage, audit | **done** (migration `20261101000023_recording_consent.sql`) |
| 11b | Doctor's start / stop buttons, both parties' consent prompts, the "recording" indicator, browser capture and upload | **done** |
| 11c | Doctor plays a recording later: audited, short-lived link; access rules | **done** (migration `…025`, function `recording-playback`) |
| 11d | Retention purge job, legal hold, stale-recording cleanup | **done** (migration `…026`, function `recordings-maintenance`) |

## The rules (11a)

- **By hand, by the treating doctor:** `start_recording(appointment)` works only for the appointment's own doctor, only while the
  consultation is `in_progress`, and only if recording is switched on.
- **Both parties consent, for this appointment:** `set_recording_consent(appointment, granted)` by the doctor and by the patient
  (the booking account). Without both, `start_recording` answers `consent_required`. **Withdrawing consent stops a recording in
  progress** (it moves to `uploading` with `stop_reason = consent_withdrawn`). Consent can be given again.
- **One recording at a time** per appointment (`already_recording`).
- **States:** `recording` → `uploading` (stopped) → `ready` (`finish_recording`: the file must really be in storage, type and size are
  checked) or `failed` (`fail_recording`). `deleted` is for the purge (11d).
- **Retention:** a `ready` recording gets `retention_until = ended_at + app_settings.recording_retention_days` (default **90**, a
  placeholder: set the hospital's period). Nothing is purged yet (11d).
- **Who sees what:** doctor and patient of the appointment see the consent rows and the recording's metadata (state, times, size).
  An admin sees the recording metadata only. Coordinators, finance, other doctors and other patients see nothing.
- **The media's location is a secret:** `storage_prefix` is not granted to any client, whatever its role; it is never returned except
  to the doctor who just started the recording (to upload). The bucket `consult-recordings` is private: the treating doctor may
  **upload** under the active recording's prefix and nothing else. No client can list, read, overwrite or delete media through storage.
  Playback will be an audited function that mints a short-lived link (11c).
- **Writes:** clients cannot write `recording_consents` or `consult_recordings`; everything goes through the functions above.
- **Audit:** every consent change and every state change is in the audit log with who did it and why
  (`Recording started`, `Recording stopped`, `Recording consent withdrawn by the patient`, …).

## Capture (11b)

Audio only (migration `…024` forces `kind = 'audio'`). The doctor's browser captures: `AudioCapture` mixes the local mic and the remote audio tracks (Web Audio) and records opus/webm in 10 s slices; `ChunkUploader` uploads them in order as `part-000001.webm`… under the server-chosen prefix (retries; no chunk after a failed one; first part must carry the webm header). `useRecording` is the controller (phases off/idle/asked/invited/ready/recording/saving/interrupted); `RecordingPanel` is the UI in the call screen. Only LiveKit calls can be recorded (Jitsi's iframe hides the remote audio); Safari/iOS is unsupported. A server stop (consent withdrawn) makes the doctor's browser finish the upload; a recording left running by a closed tab can be ended from the panel. Real-browser check: `CHROMIUM_PATH=... npm run e2e:recording-capture`. Playback (joining parts) is 11c.

## Playback (11c)

Only the **treating doctor** can play a `ready` recording (patients, admins and coordinators cannot; admins see metadata). The `recording-playback` edge function calls `open_recording(id)` as the user (checks doctor and state, writes the audit entry `recording.played`), joins the parts once into `joined.webm` beside them (cached), and returns a signed link valid for 5 minutes; the storage path never reaches the browser. A recording with a missing part is refused (`parts_missing`). Playing works even when `recording_enabled` is later switched off. The doctor sees a "Recordings" card on the appointment page. **11d must delete the whole prefix (parts and `joined.webm`) when a recording is purged.**

## Retention (11d)

- **Retention period:** `app_settings.recording_retention_days` (default 90, a placeholder: set the hospital's period). A ready recording is kept until `retention_until`; a failed one (partial media) for the same period after it ended.
- **Legal hold:** an admin calls `set_recording_legal_hold(recording, hold, reason)`; the reason is mandatory and audited (`recording.legal_hold`). A held recording is never purged, even past retention; releasing the hold makes it due again. (There is no admin screen for this yet: it is a database function.)
- **Stale recordings:** a recording still `recording` / `uploading` after 6 hours is failed (`stop_reason = stale`), releasing the one-at-a-time lock.
- **Purge:** the `recordings-maintenance` edge function (service role only, run **once a day** by the scheduler, like `integrations-dispatch`; the local gateway does it every 24 h) first fails stale recordings, then for each recording due: removes every file under its folder (parts and `joined.webm`), then calls `mark_recording_deleted`, which re-checks the hold and retention. The record stays (`status = 'deleted'`, `deleted_at`), audited as "Recording purged (retention)". If removal fails the record is left alone and retried next run.

## Tests

`supabase/tests/recording.sql` (66 checks): the switch, consent (both parties, strangers, withdrawal), starting rules, one at a time,
path privacy for every role, no direct writes, storage upload/read/overwrite/delete rules, withdrawal during a recording, finishing
(file must exist, mime, size, retention default and setting), failure, and audit.
