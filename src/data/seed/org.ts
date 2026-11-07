/** Static master data for the demo: hospitals, departments, doctors, demo users, templates, settings. */
import type { AppSettings, Department, Hospital, NotificationTemplate, FollowUpPolicy } from '@/domain/types';

/** Deterministic UUIDs so seed SQL and demo data share IDs. kind = 2-hex-digit entity code. */
export const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const K = {
  user: 0x01,
  hospital: 0x02,
  department: 0x03,
  doctor: 0x04,
  patient: 0x05,
  appointment: 0x06,
  slot: 0x07,
  payment: 0x08,
  refund: 0x09,
  consultation: 0x0a,
  prescription: 0x0b,
  item: 0x0c,
  document: 0x0d,
  fee: 0x0e,
  availability: 0x0f,
  rule: 0x10,
  dependent: 0x11,
  consent: 0x12,
  rating: 0x13,
  ticket: 0x14,
  notification: 0x15,
  reschedule: 0x16,
  holiday: 0x17,
  audit: 0x18,
  calllog: 0x19,
} as const;

export const DEMO = {
  patientPhone: '+919847000001',
  doctorPhone: '+919847100001',
  doctorPin: '1234',
  adminEmail: 'admin@sunrise.demo',
  adminPassword: 'Sunrise@123',
  financeEmail: 'finance@sunrise.demo',
  coordinatorEmail: 'coordinator@sunrise.demo',
  otp: '123456',
};

export const HOSPITALS: Hospital[] = [
  { id: uid(K.hospital, 1), name: 'Sunrise Hospital Kakkanad', city: 'Kochi', address: 'Seaport–Airport Road, Kakkanad, Kochi 682030', phone: '+914842000100', emergency_phone: '+914842000111', active: true },
  { id: uid(K.hospital, 2), name: 'Sunrise Hospital Kozhikode', city: 'Kozhikode', address: 'Mavoor Road, Kozhikode 673004', phone: '+914952000200', emergency_phone: '+914952000211', active: true },
  { id: uid(K.hospital, 3), name: 'Sunrise Hospital Thrissur', city: 'Thrissur', address: 'Round North, Thrissur 680001', phone: '+914872000300', emergency_phone: '+914872000311', active: true },
];

export const DEPARTMENTS: Department[] = [
  { id: uid(K.department, 1), name: 'General Medicine', name_ml: 'ജനറൽ മെഡിസിൻ', icon: 'Stethoscope', active: true },
  { id: uid(K.department, 2), name: 'Cardiology', name_ml: 'കാർഡിയോളജി', icon: 'HeartPulse', active: true },
  { id: uid(K.department, 3), name: 'Paediatrics', name_ml: 'പീഡിയാട്രിക്സ്', icon: 'Baby', active: true },
  { id: uid(K.department, 4), name: 'Obstetrics & Gynaecology', name_ml: 'പ്രസവ-സ്ത്രീരോഗ വിഭാഗം', icon: 'Flower2', active: true },
  { id: uid(K.department, 5), name: 'Dermatology', name_ml: 'ഡെർമറ്റോളജി', icon: 'Sparkles', active: true },
  { id: uid(K.department, 6), name: 'Orthopaedics', name_ml: 'ഓർത്തോപീഡിക്സ്', icon: 'Bone', active: true },
  { id: uid(K.department, 7), name: 'ENT', name_ml: 'ഇഎൻടി', icon: 'Ear', active: true },
  { id: uid(K.department, 8), name: 'Diabetology & Endocrinology', name_ml: 'പ്രമേഹ-എൻഡോക്രൈൻ വിഭാഗം', icon: 'Droplet', active: true },
];

/** [name, dept#, hospital#, qualification, years, languages, modes, firstFeeVideo, phone] */
export const DOCTOR_ROWS: [string, number, number, string, number, string[], ('audio' | 'video')[], number, string][] = [
  ['Dr. Arun Nair', 2, 1, 'MBBS, MD, DM (Cardiology)', 18, ['English', 'Malayalam', 'Hindi'], ['audio', 'video'], 800, '+919847100001'],
  ['Dr. Meera Krishnan', 1, 1, 'MBBS, MD (Internal Medicine)', 12, ['English', 'Malayalam', 'Tamil'], ['audio', 'video'], 500, '+919847100002'],
  ['Dr. Fathima Rasheed', 3, 2, 'MBBS, MD (Paediatrics)', 9, ['English', 'Malayalam', 'Arabic'], ['audio', 'video'], 500, '+919847100003'],
  ['Dr. Lakshmi Varma', 4, 1, 'MBBS, MS (OBG), DNB', 15, ['English', 'Malayalam'], ['video'], 700, '+919847100004'],
  ['Dr. Joseph Mathew', 5, 3, 'MBBS, MD (Dermatology)', 11, ['English', 'Malayalam'], ['video'], 600, '+919847100005'],
  ['Dr. Rahul Menon', 6, 2, 'MBBS, MS (Ortho)', 14, ['English', 'Malayalam', 'Kannada'], ['audio', 'video'], 650, '+919847100006'],
  ['Dr. Sneha Pillai', 7, 3, 'MBBS, MS (ENT)', 8, ['English', 'Malayalam', 'Hindi'], ['audio', 'video'], 550, '+919847100007'],
  ['Dr. Abdul Kareem', 8, 2, 'MBBS, MD, DM (Endocrinology)', 20, ['English', 'Malayalam', 'Urdu'], ['audio', 'video'], 750, '+919847100008'],
  ['Dr. Anitha George', 1, 3, 'MBBS, DNB (Family Medicine)', 7, ['English', 'Malayalam'], ['audio', 'video'], 400, '+919847100009'],
  ['Dr. Vivek Shenoy', 2, 3, 'MBBS, MD, DNB (Cardiology)', 10, ['English', 'Malayalam', 'Konkani'], ['video'], 750, '+919847100010'],
];

export const DEFAULT_SETTINGS: AppSettings = {
  consult_minutes: 15,
  slot_hold_minutes: 10,
  join_window_minutes: 10,
  doctor_grace_minutes: 10,
  patient_grace_minutes: 10,
  auto_doctor_no_show_minutes: 30,
  auto_patient_no_show_minutes: 30,
  cancellation_tiers: [
    { min_hours_before: 2, percent: 100 },
    { min_hours_before: 0, percent: 0 },
  ],
  patient_no_show_refund_percent: 0,
  patient_reschedule_min_hours: 2,
  doctor_no_show_auto_refund_hours: 24,
  patient_reschedule_limit: 1,
  max_upload_mb: 10,
  join_close_minutes: 30,
  recording_enabled: false,
  allowed_upload_types: ['application/pdf', 'image/jpeg', 'image/png'],
  consent_versions: { teleconsultation: '1.0', data_processing: '1.0', whatsapp_opt_in: '1.0', terms: '1.0', marketing: '1.0' },
  consent_texts: {
    teleconsultation: {
      en: 'I consent to receive medical consultation by audio/video from a Sunrise registered medical practitioner. I understand that teleconsultation has limitations, that the doctor may advise an in-person visit, and that this service is not for emergencies.',
      ml: 'സൺറൈസ് രജിസ്റ്റേർഡ് ഡോക്ടറിൽ നിന്ന് ഓഡിയോ/വീഡിയോ വഴി ചികിത്സാ കൺസൾട്ടേഷൻ സ്വീകരിക്കാൻ ഞാൻ സമ്മതിക്കുന്നു. ടെലികൺസൾട്ടേഷന് പരിമിതികളുണ്ടെന്നും ഡോക്ടർ നേരിട്ട് കാണാൻ നിർദ്ദേശിച്ചേക്കാമെന്നും ഇത് അടിയന്തര സേവനമല്ലെന്നും ഞാൻ മനസ്സിലാക്കുന്നു.',
    },
    data_processing: {
      en: 'I consent to Sunrise Chain of Hospitals processing my personal and health data (and that of family members I add) to provide consultations, prescriptions and records, as described in the Privacy Notice. I can withdraw consent or request erasure at any time.',
      ml: 'കൺസൾട്ടേഷൻ, കുറിപ്പടി, രേഖകൾ എന്നിവ നൽകുന്നതിനായി എന്റെയും ഞാൻ ചേർക്കുന്ന കുടുംബാംഗങ്ങളുടെയും വ്യക്തിഗത, ആരോഗ്യ വിവരങ്ങൾ സ്വകാര്യതാ അറിയിപ്പിൽ പറയുന്ന പ്രകാരം സൺറൈസ് ഉപയോഗിക്കുന്നതിന് ഞാൻ സമ്മതിക്കുന്നു. എപ്പോൾ വേണമെങ്കിലും സമ്മതം പിൻവലിക്കാം.',
    },
    whatsapp_opt_in: {
      en: 'Send me appointment updates and secure links on WhatsApp. Messages never contain medical details.',
      ml: 'അപ്പോയിന്റ്മെന്റ് വിവരങ്ങളും സുരക്ഷിത ലിങ്കുകളും വാട്ട്‌സ്ആപ്പിൽ അയയ്ക്കുക. സന്ദേശങ്ങളിൽ ചികിത്സാ വിവരങ്ങൾ ഉണ്ടാകില്ല.',
    },
    terms: {
      en: 'I agree to the Terms of Use, Refund Policy and Privacy Notice of Sunrise Care Connect.',
      ml: 'സൺറൈസ് കെയർ കണക്റ്റിന്റെ ഉപയോഗ നിബന്ധനകൾ, റീഫണ്ട് നയം, സ്വകാര്യതാ അറിയിപ്പ് എന്നിവ ഞാൻ അംഗീകരിക്കുന്നു.',
    },
    marketing: {
      en: 'Sunrise may contact me (call, SMS or WhatsApp) about its health services and camps. Only my name, mobile number and city are used – never my medical details. I can withdraw this at any time.',
      ml: 'സൺറൈസിന്റെ ആരോഗ്യ സേവനങ്ങളെയും ക്യാമ്പുകളെയും കുറിച്ച് എന്നെ ബന്ധപ്പെടാം (കോൾ, SMS, WhatsApp). എന്റെ പേര്, മൊബൈൽ നമ്പർ, നഗരം എന്നിവ മാത്രം – ചികിത്സാ വിവരങ്ങൾ ഒരിക്കലുമില്ല. എപ്പോൾ വേണമെങ്കിലും പിൻവലിക്കാം.',
    },
  },
  abdm_enabled: false,
  // HIS and LeadSquared send through mock adapters locally; ABDM stays off until Sunrise is registered with NHA
  integrations: { his: true, leadsquared: true },
  support_phone: '+914842000100',
  grievance_officer: { name: 'Grievance Officer, Sunrise Chain of Hospitals', email: 'grievance@sunrisehospitals.example', phone: '+914842000199' },
};

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = { free_window_days: 14, free_follow_up_count: 1, match_rule: 'same_doctor' };

/**
 * Notification templates. Variables come from a whitelist (no clinical content can ever be filled in);
 * every link is a single-account token that needs sign-in. WhatsApp names must match the templates
 * approved in Meta Business Manager; SMS ids are the DLT registrations.
 */
type Row = [key: string, en: string, ml: string, vars: string[], cat: NotificationTemplate['category'], aud: NotificationTemplate['audience'], quiet: boolean, desc: string];
const ALL = ['whatsapp', 'sms', 'push', 'in_app'] as const;
const STAFF = ['sms', 'push', 'in_app'] as const;   // doctors: no WhatsApp opt-in flow
export const TEMPLATES: NotificationTemplate[] = ([
  ['otp', 'Your Sunrise Care Connect OTP is {{otp}}. Valid for 5 minutes. Do not share it.', 'നിങ്ങളുടെ സൺറൈസ് കെയർ കണക്റ്റ് OTP {{otp}} ആണ്. 5 മിനിറ്റ് സാധുത. ആരുമായും പങ്കിടരുത്.', ['otp'], 'auth', 'patient', false, 'Login code (sent by the auth service, not the outbox)'],
  ['booking_confirmed', 'Hi {{name}}, your Sunrise teleconsultation with {{doctor}} is confirmed for {{date}} at {{time}} IST. Ref {{ref}}. Details: {{link}}', 'നമസ്കാരം {{name}}, {{doctor}}-മായുള്ള നിങ്ങളുടെ സൺറൈസ് ടെലികൺസൾട്ടേഷൻ {{date}} {{time}}-ന് ഉറപ്പായി. റഫ് {{ref}}. വിവരങ്ങൾ: {{link}}', ['name', 'doctor', 'date', 'time', 'ref', 'link'], 'transactional', 'patient', false, 'Booking confirmed (paid or free)'],
  ['payment_received', 'Payment of Rs {{amount}} received for booking {{ref}}. Your receipt is in the app: {{link}}', 'ബുക്കിംഗ് {{ref}}-ന് Rs {{amount}} ലഭിച്ചു. രസീത് ആപ്പിൽ: {{link}}', ['amount', 'ref', 'link'], 'transactional', 'patient', false, 'Payment receipt'],
  ['reminder_24h', 'Reminder: your Sunrise teleconsultation {{ref}} is tomorrow, {{date}} at {{time}} IST. Details: {{link}}', 'ഓർമ്മപ്പെടുത്തൽ: നിങ്ങളുടെ സൺറൈസ് ടെലികൺസൾട്ടേഷൻ {{ref}} നാളെ, {{date}} {{time}}-ന്. വിവരങ്ങൾ: {{link}}', ['date', 'time', 'ref', 'link'], 'reminder', 'patient', true, 'Reminder 24 hours before'],
  ['reminder_1h', 'Reminder: your consultation {{ref}} starts at {{time}} IST. You can join from 10 minutes before: {{link}}', 'ഓർമ്മപ്പെടുത്തൽ: നിങ്ങളുടെ കൺസൾട്ടേഷൻ {{ref}} {{time}}-ന് ആരംഭിക്കും. 10 മിനിറ്റ് മുമ്പ് മുതൽ ചേരാം: {{link}}', ['ref', 'time', 'link'], 'reminder', 'patient', false, 'Reminder 1 hour before'],
  ['reminder_10m', 'Your consultation {{ref}} starts in {{minutes}} minutes. Join here: {{link}}', 'നിങ്ങളുടെ കൺസൾട്ടേഷൻ {{ref}} {{minutes}} മിനിറ്റിനുള്ളിൽ ആരംഭിക്കും. ഇവിടെ ചേരുക: {{link}}', ['ref', 'minutes', 'link'], 'reminder', 'patient', false, 'Join link 10 minutes before'],
  ['doctor_joined', 'Your doctor is ready for consultation {{ref}}. Join now: {{link}}', 'കൺസൾട്ടേഷൻ {{ref}}-നായി ഡോക്ടർ തയ്യാറാണ്. ഇപ്പോൾ ചേരുക: {{link}}', ['ref', 'link'], 'transactional', 'patient', false, 'Join link when the doctor is in the room'],
  ['reschedule_proposed', 'Your doctor has proposed a new time {{time}} IST today for booking {{ref}}. Please respond: {{link}}', 'ബുക്കിംഗ് {{ref}}-ന് ഇന്ന് {{time}}-ന് പുതിയ സമയം ഡോക്ടർ നിർദ്ദേശിച്ചു. മറുപടി നൽകുക: {{link}}', ['time', 'ref', 'link'], 'transactional', 'patient', false, 'Doctor asks to move the time'],
  ['rescheduled', 'Booking {{ref}} has been moved to {{date}} at {{time}} IST. Details: {{link}}', 'ബുക്കിംഗ് {{ref}} {{date}} {{time}}-ലേക്ക് മാറ്റി. വിവരങ്ങൾ: {{link}}', ['ref', 'date', 'time', 'link'], 'transactional', 'patient', false, 'Booking moved'],
  ['cancelled', 'Booking {{ref}} for {{date}} has been cancelled. Details: {{link}}', 'ബുക്കിംഗ് {{ref}} ({{date}}) റദ്ദാക്കി. വിവരങ്ങൾ: {{link}}', ['ref', 'date', 'link'], 'transactional', 'patient', false, 'Cancelled by the patient or by Sunrise'],
  ['refund_initiated', 'A refund of Rs {{amount}} for booking {{ref}} has been initiated. It usually reaches you in 5–7 working days. Details: {{link}}', 'ബുക്കിംഗ് {{ref}}-ന് Rs {{amount}} റീഫണ്ട് ആരംഭിച്ചു. 5–7 പ്രവൃത്തി ദിവസങ്ങൾക്കുള്ളിൽ ലഭിക്കും. വിവരങ്ങൾ: {{link}}', ['amount', 'ref', 'link'], 'transactional', 'patient', false, 'Refund started'],
  ['refund_processed', 'Your refund of Rs {{amount}} for booking {{ref}} has been sent to your bank / UPI. Details: {{link}}', 'ബുക്കിംഗ് {{ref}}-ന്റെ Rs {{amount}} റീഫണ്ട് നിങ്ങളുടെ ബാങ്ക് / UPI-ലേക്ക് അയച്ചു. വിവരങ്ങൾ: {{link}}', ['amount', 'ref', 'link'], 'transactional', 'patient', false, 'Refund completed by the gateway'],
  ['doctor_unavailable', 'We are sorry, your doctor could not take booking {{ref}}. Choose a free reschedule or a full refund: {{link}}', 'ക്ഷമിക്കണം, ബുക്കിംഗ് {{ref}} ഡോക്ടർക്ക് എടുക്കാനായില്ല. സൗജന്യ റീഷെഡ്യൂൾ അല്ലെങ്കിൽ പൂർണ്ണ റീഫണ്ട് തിരഞ്ഞെടുക്കുക: {{link}}', ['ref', 'link'], 'transactional', 'patient', false, 'Doctor-side cancellation, no-show or technical failure'],
  ['consult_missed', 'Consultation {{ref}} did not take place. Book a free new time with the same doctor; a refund is available on request: {{link}}', 'കൺസൾട്ടേഷൻ {{ref}} നടന്നില്ല. അതേ ഡോക്ടറുമായി സൗജന്യമായി പുതിയ സമയം ബുക്ക് ചെയ്യുക; ആവശ്യപ്പെട്ടാൽ റീഫണ്ട് ലഭിക്കും: {{link}}', ['ref', 'link'], 'transactional', 'patient', false, 'Neither side joined'],
  ['prescription_ready', 'Your consultation summary for {{ref}} is ready. View it securely in the app: {{link}}', '{{ref}}-ന്റെ കൺസൾട്ടേഷൻ സംഗ്രഹം തയ്യാറാണ്. ആപ്പിൽ സുരക്ഷിതമായി കാണുക: {{link}}', ['ref', 'link'], 'transactional', 'patient', false, 'Prescription signed (no medicine or diagnosis in the message)'],
  ['follow_up_due', 'Hi {{name}}, your free follow-up with {{doctor}} is available until {{date}}. Book: {{link}}', 'നമസ്കാരം {{name}}, {{doctor}}-മായുള്ള സൗജന്യ ഫോളോ-അപ്പ് {{date}} വരെ ലഭ്യമാണ്. ബുക്ക് ചെയ്യുക: {{link}}', ['name', 'doctor', 'date', 'link'], 'reminder', 'patient', true, '2 days before the free follow-up window closes'],
  ['follow_up_advised', 'Hi {{name}}, {{doctor}} asked to see you again on {{date}}. Book your follow-up: {{link}}', 'നമസ്കാരം {{name}}, {{date}}-ന് വീണ്ടും കാണാൻ {{doctor}} നിർദ്ദേശിച്ചു. ഫോളോ-അപ്പ് ബുക്ക് ചെയ്യുക: {{link}}', ['name', 'doctor', 'date', 'link'], 'reminder', 'patient', true, 'Day before the follow-up date the doctor set'],
  ['feedback_request', 'Hi {{name}}, how was your consultation with {{doctor}}? Tell us in one tap: {{link}}', 'നമസ്കാരം {{name}}, {{doctor}}-മായുള്ള കൺസൾട്ടേഷൻ എങ്ങനെയായിരുന്നു? ഒറ്റ ടാപ്പിൽ അറിയിക്കുക: {{link}}', ['name', 'doctor', 'link'], 'service', 'patient', true, '2 hours after a completed consultation, if not rated'],
  ['doctor_new_booking', 'New teleconsultation booked for {{date}} at {{time}} IST (ref {{ref}}). Open: {{link}}', '{{date}} {{time}}-ന് പുതിയ ടെലികൺസൾട്ടേഷൻ (റഫ് {{ref}}). തുറക്കുക: {{link}}', ['date', 'time', 'ref', 'link'], 'transactional', 'doctor', false, 'Doctor: new booking'],
  ['doctor_booking_cancelled', 'Booking {{ref}} on {{date}} at {{time}} IST was cancelled. Open: {{link}}', '{{date}} {{time}}-നുള്ള ബുക്കിംഗ് {{ref}} റദ്ദാക്കി. തുറക്കുക: {{link}}', ['date', 'time', 'ref', 'link'], 'transactional', 'doctor', false, 'Doctor: booking cancelled'],
  ['reschedule_response', 'Patient responded to your reschedule request for {{ref}}: {{response}}. Open: {{link}}', '{{ref}}-നുള്ള റീഷെഡ്യൂൾ അഭ്യർത്ഥനയ്ക്ക് രോഗി മറുപടി നൽകി: {{response}}. തുറക്കുക: {{link}}', ['ref', 'response', 'link'], 'transactional', 'doctor', false, 'Doctor: patient answered a reschedule'],
  ['ticket_update', 'Your support ticket {{ref}} has been updated. View: {{link}}', 'നിങ്ങളുടെ സപ്പോർട്ട് ടിക്കറ്റ് {{ref}} അപ്ഡേറ്റ് ചെയ്തു. കാണുക: {{link}}', ['ref', 'link'], 'service', 'patient', false, 'Support ticket update'],
] as Row[]).map(([key, en, ml, variables, category, audience, quiet_hours, description]) => ({
  key,
  channel: 'whatsapp' as const,
  provider_template_name: `sunrise_${key}_v1`,
  body_en: en,
  body_ml: ml,
  variables,
  active: key !== 'otp',
  category,
  audience,
  channels: [...(key === 'otp' ? ['sms'] : audience === 'patient' ? ALL : STAFF)] as NotificationTemplate['channels'],
  quiet_hours,
  sms_dlt_template_id: `1107${String(Math.abs([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))).padStart(15, '0').slice(0, 15)}`,
  description,
}));

export const PATIENT_ROWS: [string, string, 'female' | 'male', string, string, string[]][] = [
  // name, dob, gender, phone, city, allergies
  ['Anjali Menon', '1988-04-12', 'female', '+919847000001', 'Kakkanad, Kochi', ['Penicillin']],
  ['Rajan Pillai', '1956-09-03', 'male', '+919847000002', 'Edappally, Kochi', []],
  ['Shabna Ali', '1993-01-21', 'female', '+919847000003', 'Kozhikode', ['Sulfa']],
  ['Thomas Kurian', '1971-11-30', 'male', '+919847000004', 'Thrissur', []],
  ['Divya Suresh', '1999-06-14', 'female', '+919847000005', 'Aluva', []],
  ['Mohammed Ashraf', '1965-02-08', 'male', '+919847000006', 'Malappuram', ['NSAID']],
  ['Priya Raghavan', '1984-08-25', 'female', '+919847000007', 'Kottayam', []],
  ['Gopakumar K', '1949-12-17', 'male', '+919847000008', 'Thrissur', []],
  ['Reshma Varghese', '1990-03-09', 'female', '+919847000009', 'Kochi', []],
  ['Sanjay Das', '1979-07-01', 'male', '+919847000010', 'Kozhikode', []],
  ['Aisha Beevi', '1961-05-19', 'female', '+919847000011', 'Kannur', []],
  ['Nikhil Joseph', '1995-10-28', 'male', '+919847000012', 'Kochi', []],
  ['Sreelakshmi P', '2001-02-11', 'female', '+919847000013', 'Palakkad', []],
  ['Babu Antony', '1968-04-04', 'male', '+919847000014', 'Thrissur', ['Aspirin']],
  ['Haritha Nambiar', '1987-09-16', 'female', '+919847000015', 'Kozhikode', []],
  ['Faisal Rahman', '1982-01-27', 'male', '+919847000016', 'Kochi', []],
  ['Leela Devi', '1952-06-30', 'female', '+919847000017', 'Thrissur', []],
  ['Kiran Kumar', '1992-12-05', 'male', '+919847000018', 'Kochi', []],
];

/** Dependents of the demo patient (Anjali). [name, dob, gender, relation] */
export const DEPENDENT_ROWS: [string, string, 'female' | 'male', 'parent' | 'child'][] = [
  ['Sarojini Menon', '1958-03-02', 'female', 'parent'],
  ['Aditya Menon', '2016-07-22', 'male', 'child'],
];

/**
 * Legal pages linked from the consent screen (/legal/:key). DRAFT wording for Sunrise's legal team to
 * replace in Admin → Content; every change is versioned there.
 */
export const LEGAL_DOCUMENTS: { key: 'terms_of_use' | 'privacy_notice' | 'refund_policy'; title_en: string; title_ml: string; body_en: string; body_ml: string }[] = [
  {
    key: 'terms_of_use',
    title_en: 'Terms of Use',
    title_ml: 'ഉപയോഗ നിബന്ധനകൾ',
    body_en: `DRAFT – to be replaced by Sunrise Chain of Hospitals' approved text.

1. Sunrise Care Connect lets you consult registered medical practitioners of Sunrise Chain of Hospitals by audio or video, in line with the Telemedicine Practice Guidelines, 2020.
2. Teleconsultation is not for emergencies. In an emergency call 112 or go to the nearest emergency department.
3. The doctor decides whether a teleconsultation is suitable and may advise an in-person visit. Some medicines cannot be prescribed by teleconsultation.
4. You must give correct information about yourself and the family members you add, and keep your login private.
5. Consultations are not recorded unless both you and the doctor agree. Only the audio is recorded, only when the doctor starts it, and you can withdraw your consent at any time, which stops the recording. Prescriptions and summaries are kept in your records.
6. Fees, free follow-ups, cancellations and refunds follow the Refund Policy.
7. Grievances: see the contact details of the Grievance Officer in the app.`,
    body_ml: `കരട് – സൺറൈസ് ചെയിൻ ഓഫ് ഹോസ്പിറ്റൽസ് അംഗീകരിച്ച വാചകം ഉപയോഗിച്ച് മാറ്റണം.

1. സൺറൈസ് കെയർ കണക്റ്റ് വഴി സൺറൈസിലെ രജിസ്റ്റേർഡ് ഡോക്ടർമാരുമായി ഓഡിയോ/വീഡിയോ കൺസൾട്ടേഷൻ നടത്താം (ടെലിമെഡിസിൻ പ്രാക്ടീസ് ഗൈഡ്‌ലൈൻസ്, 2020 പ്രകാരം).
2. ടെലികൺസൾട്ടേഷൻ അടിയന്തര സാഹചര്യങ്ങൾക്കുള്ളതല്ല. അടിയന്തര ഘട്ടത്തിൽ 112-ൽ വിളിക്കുക അല്ലെങ്കിൽ അടുത്തുള്ള എമർജൻസി വിഭാഗത്തിൽ പോകുക.
3. ടെലികൺസൾട്ടേഷൻ അനുയോജ്യമാണോ എന്ന് ഡോക്ടർ തീരുമാനിക്കും; നേരിട്ട് കാണാൻ നിർദ്ദേശിച്ചേക്കാം. ചില മരുന്നുകൾ ടെലികൺസൾട്ടേഷനിൽ കുറിക്കാനാവില്ല.
4. നിങ്ങളെയും നിങ്ങൾ ചേർക്കുന്ന കുടുംബാംഗങ്ങളെയും കുറിച്ച് ശരിയായ വിവരങ്ങൾ നൽകുകയും ലോഗിൻ സ്വകാര്യമായി സൂക്ഷിക്കുകയും വേണം.
5. നിങ്ങളും ഡോക്ടറും സമ്മതിച്ചാലല്ലാതെ കൺസൾട്ടേഷനുകൾ റെക്കോർഡ് ചെയ്യില്ല. ഓഡിയോ മാത്രമേ റെക്കോർഡ് ചെയ്യൂ, ഡോക്ടർ ആരംഭിക്കുമ്പോൾ മാത്രം; നിങ്ങളുടെ സമ്മതം എപ്പോൾ വേണമെങ്കിലും പിൻവലിക്കാം, അപ്പോൾ റെക്കോർഡിംഗ് നിർത്തും. കുറിപ്പടികളും സംഗ്രഹങ്ങളും നിങ്ങളുടെ രേഖകളിൽ സൂക്ഷിക്കും.
6. ഫീസ്, സൗജന്യ ഫോളോ-അപ്പ്, റദ്ദാക്കൽ, റീഫണ്ട് എന്നിവ റീഫണ്ട് നയം പ്രകാരം.
7. പരാതികൾ: ആപ്പിലെ ഗ്രീവൻസ് ഓഫീസറുടെ വിവരങ്ങൾ കാണുക.`,
  },
  {
    key: 'privacy_notice',
    title_en: 'Privacy Notice',
    title_ml: 'സ്വകാര്യതാ അറിയിപ്പ്',
    body_en: `DRAFT – to be replaced by Sunrise Chain of Hospitals' approved text.

What we collect: your name, mobile number, date of birth and gender; the same for family members you add; symptoms, documents, consultation notes and prescriptions; payment references (never card or bank details).
Why: to provide teleconsultations, prescriptions, records, receipts and reminders, with your consent.
Who sees it: your doctor and authorised Sunrise staff with a need to know. Billing and support staff never see clinical details. Every access to records is logged.
Messages: WhatsApp and SMS messages never contain medical details – only a secure link that opens after you sign in.
Storage: in India (Supabase, Mumbai region), encrypted, with private files opened only through short-lived links.
Your rights: see your data, correct it, withdraw consent, and ask for erasure where the law allows, from your profile or by contacting the Grievance Officer.`,
    body_ml: `കരട് – സൺറൈസ് ചെയിൻ ഓഫ് ഹോസ്പിറ്റൽസ് അംഗീകരിച്ച വാചകം ഉപയോഗിച്ച് മാറ്റണം.

ശേഖരിക്കുന്നവ: പേര്, മൊബൈൽ നമ്പർ, ജനനത്തീയതി, ലിംഗം; നിങ്ങൾ ചേർക്കുന്ന കുടുംബാംഗങ്ങളുടേതും; ലക്ഷണങ്ങൾ, രേഖകൾ, കൺസൾട്ടേഷൻ കുറിപ്പുകൾ, കുറിപ്പടികൾ; പേയ്മെന്റ് റഫറൻസുകൾ (കാർഡ്/ബാങ്ക് വിവരങ്ങൾ ഒരിക്കലുമില്ല).
എന്തിന്: നിങ്ങളുടെ സമ്മതത്തോടെ ടെലികൺസൾട്ടേഷൻ, കുറിപ്പടി, രേഖകൾ, രസീതുകൾ, ഓർമ്മപ്പെടുത്തലുകൾ എന്നിവ നൽകാൻ.
ആർക്ക് കാണാം: നിങ്ങളുടെ ഡോക്ടർക്കും ആവശ്യമുള്ള അംഗീകൃത സൺറൈസ് ജീവനക്കാർക്കും. ബില്ലിംഗ്, സപ്പോർട്ട് ജീവനക്കാർ ചികിത്സാ വിവരങ്ങൾ കാണില്ല. എല്ലാ ആക്സസും രേഖപ്പെടുത്തുന്നു.
സന്ദേശങ്ങൾ: WhatsApp, SMS സന്ദേശങ്ങളിൽ ചികിത്സാ വിവരങ്ങൾ ഉണ്ടാകില്ല – സൈൻ ഇൻ ചെയ്ത ശേഷം തുറക്കുന്ന സുരക്ഷിത ലിങ്ക് മാത്രം.
സംഭരണം: ഇന്ത്യയിൽ (സുപാബേസ്, മുംബൈ), എൻക്രിപ്റ്റ് ചെയ്ത്; സ്വകാര്യ ഫയലുകൾ ഹ്രസ്വകാല ലിങ്കുകളിലൂടെ മാത്രം.
നിങ്ങളുടെ അവകാശങ്ങൾ: വിവരങ്ങൾ കാണാനും തിരുത്താനും സമ്മതം പിൻവലിക്കാനും നിയമം അനുവദിക്കുന്നിടത്ത് മായ്ക്കാനും പ്രൊഫൈലിൽ നിന്നോ ഗ്രീവൻസ് ഓഫീസർ വഴിയോ ആവശ്യപ്പെടാം.`,
  },
  {
    key: 'refund_policy',
    title_en: 'Refund Policy',
    title_ml: 'റീഫണ്ട് നയം',
    body_en: `DRAFT – to be replaced by Sunrise Chain of Hospitals' approved text.

- You can cancel a confirmed consultation in the app. The refund depends on how long before the start you cancel; the current percentages are shown before you confirm.
- If your doctor cancels, does not join, or the consultation fails for technical reasons, you choose a free reschedule or a full refund.
- If neither you nor the doctor joins, you can book a free new time with the same doctor; a refund is given on request.
- If Sunrise cancels a consultation, any refund is shown to you with the cancellation.
- Free follow-ups are not refundable, as no fee was paid.
- Refunds go back to the original payment method, usually within 5–7 working days.`,
    body_ml: `കരട് – സൺറൈസ് ചെയിൻ ഓഫ് ഹോസ്പിറ്റൽസ് അംഗീകരിച്ച വാചകം ഉപയോഗിച്ച് മാറ്റണം.

- സ്ഥിരീകരിച്ച കൺസൾട്ടേഷൻ ആപ്പിൽ റദ്ദാക്കാം. തുടങ്ങുന്നതിന് എത്ര മുമ്പ് റദ്ദാക്കുന്നു എന്നതനുസരിച്ചാണ് റീഫണ്ട്; നിലവിലെ ശതമാനം സ്ഥിരീകരിക്കും മുമ്പ് കാണിക്കും.
- ഡോക്ടർ റദ്ദാക്കുകയോ ചേരാതിരിക്കുകയോ സാങ്കേതിക തകരാർ ഉണ്ടാകുകയോ ചെയ്താൽ സൗജന്യ റീഷെഡ്യൂൾ അല്ലെങ്കിൽ പൂർണ്ണ റീഫണ്ട് തിരഞ്ഞെടുക്കാം.
- നിങ്ങളും ഡോക്ടറും ചേർന്നില്ലെങ്കിൽ അതേ ഡോക്ടറുമായി സൗജന്യമായി പുതിയ സമയം ബുക്ക് ചെയ്യാം; ആവശ്യപ്പെട്ടാൽ റീഫണ്ട് നൽകും.
- സൺറൈസ് കൺസൾട്ടേഷൻ റദ്ദാക്കിയാൽ, റീഫണ്ട് ഉണ്ടെങ്കിൽ അത് റദ്ദാക്കലിനൊപ്പം കാണിക്കും.
- സൗജന്യ ഫോളോ-അപ്പുകൾക്ക് ഫീസ് ഇല്ലാത്തതിനാൽ റീഫണ്ടില്ല.
- റീഫണ്ട് യഥാർത്ഥ പേയ്മെന്റ് രീതിയിലേക്ക്, സാധാരണയായി 5–7 പ്രവൃത്തി ദിവസത്തിനുള്ളിൽ.`,
  },
];
