# Clinical notes and e-prescriptions

| Screen | Route | What it does |
|---|---|---|
| Notes & prescription (doctor) | `/d/appointments/:id/write` | Clinical notes and the prescription side by side (stacked on phones). Opened from the appointment page and the after-call screen |
| In call (doctor) | `/d/consult/:id` → side panel | The same **Notes** and **Rx** editors as tabs next to Symptoms, Documents and Chat |
| Signature & signing PIN (doctor) | `/d/profile/signature` | Set or change the signing PIN; draw the signature with a finger, stylus or mouse, or upload a PNG |
| Records (patient) | `/p/records` → `/p/records/:id` | The family's prescriptions (latest version first): medicines, advice, follow-up, earlier versions; **Download**, **Share** and **Open PDF** |
| Verification (public) | `/verify/:code` (also `/verify` to type a code) | The QR target. No sign-in. Shows **only** whether the prescription is valid, replaced or unknown, the doctor (name, registration, council) and the date |

## Clinical notes
- **Fields**: chief complaint, history, examination, diagnoses, investigations, advice and follow-up date.
- **Autosave**: 1.5 s after typing stops, and when the editor closes, through `save_consult_notes`. The status shows Saving / Saved hh:mm / Not saved, with a retry.
- **Diagnoses come from ICD-10 search** (`search_icd10`, 214 codes in the seed):
  - matches a code prefix, words, or close typos (trigram similarity);
  - keyboard-navigable combobox;
  - if nothing fits, a free-text **provisional** diagnosis can be added; it is marked as such on the PDF.
  - The server resolves every code against `icd10_master` and ignores descriptions sent by the client.
  - Limit: 10 diagnoses.
- **Templates**:
  - **Sunrise templates** (nine common teleconsultation conditions, from the seed) are visible to every doctor.
  - Each doctor can save **their own** (up to 50), from the current notes.
  - A template stores complaint, history, examination, diagnoses, investigations and advice, and never patient data.
  - Applying a template fills empty fields, adds to fields already written and merges diagnoses.
- **Locking**: the notes become **final together with the signed prescription** and are then locked by a trigger.
- **Shared fields**: diagnosis, investigations, advice and follow-up print on the prescription. History and examination stay in the clinical record.

## Prescription builder
- **Drug search** (`search_rx_drugs`) covers the seeded Sunrise formulary of 102 medicines, matching brand or generic names. Every result comes with the **rule verdict for this consultation**.
- **Blocked medicines** are shown in red with the reason, and their Add button is disabled.
- **Defaults**: dose, frequency and route come from the master. Frequency and duration have quick picks. Up to 20 medicines.
- **Autosave**: the draft autosaves through `save_rx_draft`. A prescription may also carry only advice and investigations.
- **Preview PDF** renders the draft with a "DRAFT – NOT VALID" watermark and no QR code.

### Rule engine: one function, used everywhere
`rx_drug_verdict` decides for one drug, in one consultation (mode and first or follow-up), next to the other drugs on the list. The same verdict is used by:
- the search results;
- the item list (`check_rx_drugs`);
- saving a draft, which refuses a blocked drug with `drug_blocked`;
- finalising, which re-checks every drug in case the rules changed in between.

The reason the doctor sees is therefore the reason the server enforces.

**Blocking**:

| Rule | Source |
|---|---|
| List O / A / B by mode × consult type | `drug_rules` matrix (admin-editable; seeded with the Telemedicine Practice Guidelines 2020 defaults). O: always. **A: video first consultation, or any follow-up.** **B: follow-up only.** |
| Prohibited list | `drug_master.category = 'prohibited'` – never; a CHECK constraint stops the matrix from ever allowing it |
| Schedule X / narcotic & psychotropic | `drug_master.schedule` – never (and forced onto the Prohibited list by a CHECK) |
| Inactive | `drug_master.active = false` |

**Warnings** never block; the doctor decides.
- **Allergies**: compared with the patient record and with what was typed in the pre-consultation form (for example "Sulfa drugs; none" is read as sulfa). A match is on the drug's allergy class (penicillin, sulfa, cephalosporin, quinolone and so on) or on its name.
- **Interactions**: a deliberately basic table, `drug_interactions`, with 11 pairs. They cover:
  - anticoagulant + NSAID or antiplatelet;
  - two NSAIDs;
  - ACE inhibitor + potassium-sparing diuretic, or + ARB;
  - macrolide + statin;
  - SSRI + triptan, or + tramadol;
  - two QT-prolonging drugs;
  - sulfonylurea + fluoroquinolone;
  - PPI + clopidogrel.
- **Duplicates**: the same medicine twice.

### Medicines that are not in the list
A doctor can add a medicine the catalogue does not have (**Add one that is not in the list**, under the search box).

**Two modes** (`app_settings.custom_medicine_mode`):
- **`direct` (the demo; the demo seed sets it):** the typed medicine is added exactly as typed: no catalogue check, no acknowledgement tick. What makes it work is the same in both modes: it **saves** with the prescription, it is **printed** on the signed PDF (the PDF payload left-joins the catalogue, otherwise it would silently vanish), and it **survives an addendum**. The name is still sanity-checked and `allow_custom_medicines = false` still switches it off.
- **`checked` (the default, also when the setting is missing; what production gets from the reference seed):** the safeguards below.

In `checked` mode the rule
engine (List O / A / B / Prohibited, schedule, interactions) cannot judge a medicine it does not know, so this is built to be safe:
- **The server refuses any name that matches a catalogue medicine** (`check_custom_medicine`, and again on save and on signing).
  Matching is by ingredient word, tolerant of spelling slips, and ignores dose-form words ("syrup", "tablet", "vitamin"): `Codeine linctus`
  is refused and points to *Codeine Cough Syrup* (prohibited), `Amoxycillin 500mg` points to *Amoxicillin*. Otherwise a restricted drug
  could be retyped as "custom" to get around the rules. The dialog offers **Search for <catalogue entry>** instead.
- **The doctor acknowledges each one** ("I have checked this medicine myself") after being told it is not rule-checked. An
  unacknowledged line blocks signing (`custom_not_acknowledged`). At signing the name is checked against the catalogue again, in case
  the catalogue has since gained that medicine.
- **Allergies are still checked by name** (a warning, never a block, like catalogue medicines). Interactions and the List rules are not,
  and the line is badged *Not in list · not rule-checked*.
- **It is printed** on the prescription like any other line (the PDF payload left-joins the catalogue), copied into addenda with its
  acknowledgement, and flagged in the data (`prescription_items.is_custom`, `drug_id` null; a check constraint keeps the two kinds apart).
- **Limits:** at most 10 per prescription; name 2 to 80 characters, no control characters or `< > { } \`.
- **Switch:** `app_settings.allow_custom_medicines = false` turns the feature off (check and save then answer `custom_disabled`; a missing
  setting means allowed). Catalogue medicines are never affected.
- **Review:** `admin_custom_medicines(days)` (admin, MFA) lists the custom medicines used on signed prescriptions: name, strength, form,
  how many times, by how many doctors, last used. No patient data. A frequently used one is a candidate for the catalogue (Admin → Masters)
  with a proper List category.
- The HIS prescription event carries `drug_code` null for a custom line (the name, strength and form are sent).

### Sign, lock and number
`finalize_prescription(rx, pin)` checks, in order:
1. The consultation has happened (status in progress or completed).
2. A signature is on file.
3. A diagnosis is present. Version 1 takes it from the notes.
4. The prescription is not empty.
5. All drugs still pass the rules.
6. The **signing PIN** (bcrypt) is correct. After 5 wrong attempts, signing is locked for 15 minutes. A wrong PIN is *returned* rather than raised, so the failure counter isn't rolled back.

On success it:
- sets the status to **final**;
- generates a 10-character **verification code** from an unambiguous alphabet (no 0/O or 1/I);
- assigns a **unique Rx number** `SCRX-YYMM-NNNNNN` (addenda: `…-A1`, `-A2`);
- snapshots the doctor (name, qualification, registration, council), patient (name, age, sex, MRN) and hospital;
- copies the notes' diagnosis, advice, investigations and follow-up;
- locks the notes;
- tells the patient (`prescription_ready`, with no clinical content).

The final row and its items are **immutable** (trigger). Direct table writes are closed, so drafts change only through the RPCs.

### Versioned addendum
- `start_addendum(rx, reason)` works on the **latest** final version and needs a reason of at least 5 characters.
- It creates draft version *n+1*, with the items and fields copied, which the doctor edits and signs like the original.
- The original stays signed and unchanged.
- **Verification**: the old code answers "replaced by a newer version" and the new code answers "valid".
- **PDF**: the addendum shows "replaces SCRX-…", with the reason.
- **Patient view**: older versions link to the latest.
- An unsigned addendum can be discarded.

### Signature
- **Format**: a PNG (drawn on the pad or uploaded), 100×30 to 1600×800 pixels, up to 200 KB. The `doctor-signature` function checks the magic bytes and the header.
- **PIN required**: saving needs the signing PIN.
- **Storage**: the PNG is kept privately as `signatures/<doctor id>.png` and is only ever placed on PDFs by the server.

## PDF (server-side, `prescription-pdf`)
- **Rendering**: pdf-lib in the edge function.
- **Layout**: A4 on Sunrise letterhead, in Telemedicine Practice Guidelines format:
  - teal band with the sun mark, hospital name, address and phone;
  - doctor name, qualification, registration and council, department;
  - patient name, age/sex, MRN;
  - consultation mode, type, date and booking reference;
  - ICD-coded diagnoses;
  - Rx table (medicine with generic, route and instructions; dose; frequency; duration);
  - investigations, advice, follow-up;
  - signature image and "Digitally signed <date> IST";
  - **QR code** (vector) linking to `<PUBLIC_APP_URL>/verify/<code>`, with the code printed under it;
  - the guideline and emergency footer;
  - page numbers.
- **Long prescriptions** flow onto further pages.
- **Access**: decided by RLS *as the requesting user*:
  - patients: the family's final prescriptions;
  - doctors: their own, including draft previews, and final prescriptions of patients they treat.
  - The file is then read or written with the service role.
- **Storage**:
  - A final, current version is rendered **once, right after signing**, and stored in the private `prescriptions` bucket (`pdf_path`), so the PDF keeps the signature as it was at signing.
  - Superseded versions are re-rendered with a "newer version exists" banner.
- **Patient sharing**: **Share PDF** uses the Web Share API with the file itself (WhatsApp, email, a pharmacy app). Where sharing isn't supported, the PDF opens in a new tab.
- **Limitation**: the standard PDF fonts are Latin only. Malayalam text in advice would print as "?". Prescriptions are written in English; Malayalam would need an embedded font plus complex-script shaping, which pdf-lib doesn't do.

## Public verification (`prescription-verify`, no sign-in)
- **Access**: GET `?code=` or POST, rate-limited to 30 per 10 minutes per client address. Codes are format-checked before any database lookup. Responses carry `X-Robots-Tag: noindex`, and the page sets `noindex`.
- **Returns only**: `status` (`valid` / `superseded` / `not_found`), doctor name, registration number and council, and the issue date. Never the patient, the diagnosis or the medicines.
- `verify_prescription` and `rx_pdf_payload` are callable by the service role only.

## Configuration
- **`PUBLIC_APP_URL`** (edge functions) is the origin printed in the QR code. Locally it is `http://localhost:5173`.
- **Drug rules**: admins can edit `drug_rules` and `drug_interactions` (RLS: admin). A rule change applies to the next search and to every finalisation.

## Also changed in this phase
- `check_rate_limit` is no longer callable by clients; before this change, any signed-in user could exhaust another user's quota. Internal callers run as the owner, and edge functions use the service role.
- Functions that use pgcrypto or pg_trgm now include the `extensions` schema in their `search_path`, which hosted Supabase needs. This includes `join_consult` from the video phase.

## Tests
- **`npm run db:test` → `prescription_flow.sql`, 72 checks**:
  - ICD search;
  - notes diagnoses (resolved, provisional, invalid, maximum);
  - templates (Sunrise and own, privacy, direct writes refused);
  - every list × mode × type verdict, with reasons;
  - allergy from the record and from the form;
  - interactions and duplicates;
  - admin rule change;
  - drafts (blocked refused, no direct writes, patient can't see drafts);
  - signature and PIN (format, weak, wrong, counter kept, lockout);
  - finalise (number, code, snapshots, notes locked, immutable, patient notified without clinical text);
  - verification (only the allowed fields; anon and authenticated can't call it directly);
  - addenda (numbering, superseded, latest only, discard);
  - seeded prescriptions numbered.
- **`npm test`**:
  - the PDF's QR **decoded back** to the verification URL with jsQR;
  - A4, title and page flow;
  - text wrapping, including Malayalam input;
  - code alphabet;
  - PNG header check.
- **`npm run e2e:prescription`** (browser and API):
  - PIN change, with a weak PIN refused;
  - drawn signature;
  - template, ICD search, provisional diagnosis, own template;
  - List A, List B and Prohibited + narcotic blocked with reasons;
  - allergy and QT warnings;
  - the API refusing a blocked drug;
  - wrong then right PIN;
  - PDF content (pdftotext);
  - patient records and download;
  - the public page showing no patient data;
  - addendum, with the old QR reporting "superseded".
