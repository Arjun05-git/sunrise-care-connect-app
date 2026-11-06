# Time zones

Sunrise Care Connect runs on **India time (`Asia/Kolkata`, UTC+05:30, no daylight saving)**. A booking at 10:00 means
10:00 in India for the patient, the doctor, the admin, the PDF and the database, wherever the phone, the server or the
database happens to be. Instants are stored as UTC (`timestamptz`); every *calendar day*, *weekday*, *clock time* and *display*
is computed in `Asia/Kolkata`.

## The rules

| Where | Do | Don't |
|---|---|---|
| Browser (`src/`) | Use `src/domain/time.ts`: `formatTime`, `formatDateTime`, `istDateKey`, `istTime`, `fromIst`, `ageFromDob` … | `getHours()`, `getDate()`, `toLocaleDateString()`, `Intl.DateTimeFormat` without `timeZone`, `new Date('2026-11-06')` (read as UTC midnight) |
| Edge functions (PDFs, messages) | Use `supabase/functions/_shared/time.ts`: `istDate`, `istDateTime` | their own formatters |
| SQL | `ts at time zone 'Asia/Kolkata'` for any date / time / weekday of an instant, `ist_today()` for "today", `ist_day_start(date)` for the start of an IST day | `current_date`, `current_time`, `localtime`, `localtimestamp`, `now()::date`, a bare date string compared with a timestamp (`start_at > '2026-11-06'` means midnight in the *session* zone) |

## Why the database zone is not changed

`ALTER DATABASE … SET timezone = 'Asia/Kolkata'` would make the bare-date mistakes above "work" on one database and break on
the next (hosted Supabase is UTC; a developer machine is whatever it is). It would also change how every timestamp prints
and how tools such as PostgREST and the dashboard read data. The code is written so it gives the same answer in **any** session zone.

## How that is enforced

- `supabase/tests/timezone.sql`: no database function may use `current_date`, `current_time`, `localtime`, `localtimestamp`
  or cast `now()` to a bare date / time; `ist_today()` is the IST date under every zone; date-of-birth rules agree with the IST
  date under zones behind and ahead of IST.
- `npm run db:test` runs **every** SQL suite again under session zones UTC, America/Los_Angeles and Pacific/Kiritimati
  (`DB_TEST_ZONES="" npm run db:test` skips it). You can run one suite yourself: `PGTZ=America/Los_Angeles psql … -f supabase/tests/doctor_flow.sql`.
- `scripts/timezone-hazards.test.ts`: `src/` and `supabase/functions/` may not contain the browser / server hazards above
  (`tz-scan:allow` on a line, with a reason, is the escape hatch).
- `npm run test:tz`: the whole unit-test suite under UTC, America/Los_Angeles, Pacific/Kiritimati and Asia/Kolkata. A developer's
  own zone hides bugs (this project's tests were written in IST), so run it before a release.

## What was found and fixed (phase 9)

- `save_patient` checked the date of birth against `current_date`, the date in the *session* zone. On hosted Supabase (UTC),
  between 00:00 and 05:30 IST a baby registered with today's IST birth date was refused as "in the future". It now uses
  `ist_today()` (migration `20261101000021_timezone_ist_today.sql`).
- Two tests built dates from the session zone (a bare `'2020-03-02'` slot range, `current_date + 1`) and failed under zones
  behind IST. They now use explicit IST bounds.
- The receipt and prescription PDFs each carried their own copy of the IST formatter; both now use `_shared/time.ts`.
- Everything else (slot generation, availability, holidays, quiet hours, reports, receipt and prescription numbers, notification
  text) already pinned `Asia/Kolkata` explicitly and passed unchanged under every zone.
