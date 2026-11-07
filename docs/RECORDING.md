# Consultation recording

Recording applies **only to consultations held through the app** (audio and video appointments). It is **off by default**
(`app_settings.recording_enabled = false`); the demo seed turns it on. Built in four parts; this page says what exists now.

| Part | What | Status |
|---|---|---|
| 11a | Consent, the recording record and its state machine, private storage, audit | **done** (migration `20261101000023_recording_consent.sql`) |
| 11b | Doctor's start / stop buttons, both parties' consent prompts, the "recording" indicator, browser capture and upload | planned |
| 11c | Doctor plays a recording later: audited, short-lived link; access rules | planned |
| 11d | Retention purge job, legal hold, stale-recording cleanup | planned |

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

## Tests

`supabase/tests/recording.sql` (66 checks): the switch, consent (both parties, strangers, withdrawal), starting rules, one at a time,
path privacy for every role, no direct writes, storage upload/read/overwrite/delete rules, withdrawal during a recording, finishing
(file must exist, mime, size, retention default and setting), failure, and audit.
