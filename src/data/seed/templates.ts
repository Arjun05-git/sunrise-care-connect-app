/** Clinical note templates: Sunrise templates (doctor_id null, for every doctor) + a demo doctor's own. */
import { ICD10 } from './icd10';

export interface NoteTemplateSeed {
  id: string;
  doctor_id: string | null;
  name: string;
  body: { chief_complaint: string; history: string; examination: string; advice: string; investigations: string; diagnoses: { code: string; description: string }[] };
}

const dx = (...codes: string[]) =>
  codes.map((code) => {
    const m = ICD10.find((x) => x.code === code);
    if (!m) throw new Error(`template ICD code ${code} missing from the master`);
    return { code: m.code, description: m.description };
  });
const id = (n: number) => `00000016-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function noteTemplates(arunDoctorId: string): NoteTemplateSeed[] {
  const sunrise = (n: number, name: string, body: Omit<NoteTemplateSeed['body'], 'diagnoses'>, codes: string[]): NoteTemplateSeed =>
    ({ id: id(n), doctor_id: null, name, body: { ...body, diagnoses: dx(...codes) } });
  return [
    sunrise(1, 'Upper respiratory infection', { chief_complaint: 'Fever, sore throat and runny nose', history: 'Duration __ days. No breathlessness, chest pain or ear discharge.', examination: 'Comfortable on video, speaking full sentences. Throat congested on self-examination with torch.', advice: 'Warm saline gargles, steam inhalation, plenty of fluids, rest. Review if fever persists beyond 3 days or if breathing becomes difficult.', investigations: '' }, ['J06.9']),
    sunrise(2, 'Acute gastroenteritis', { chief_complaint: 'Loose stools and vomiting', history: 'Episodes per day: __. No blood in stools. Passing urine normally.', examination: 'Alert, oral intake possible. No signs of severe dehydration reported.', advice: 'ORS after every loose stool, light diet, hand hygiene. Go to the emergency department for blood in stools, drowsiness or no urine for 8 hours.', investigations: 'Stool routine if not better in 48 hours' }, ['A09']),
    sunrise(3, 'Hypertension follow-up', { chief_complaint: 'Review of blood pressure', history: 'Home BP readings: __. Adherence to medicines: good. No headache, chest pain or breathlessness.', examination: 'Home BP log reviewed. No pedal oedema reported.', advice: 'Low salt diet, 30 minutes brisk walk daily, continue home BP log.', investigations: 'Lipid profile, serum creatinine, ECG' }, ['I10']),
    sunrise(4, 'Type 2 diabetes review', { chief_complaint: 'Review of blood sugar', history: 'Fasting sugar readings: __. No hypoglycaemia episodes. Diet and exercise discussed.', examination: 'Foot self-check reviewed on video: no ulcers.', advice: 'Diabetic diet, regular walking, foot care, monitor fasting sugar thrice weekly.', investigations: 'HbA1c, fasting and post-prandial blood sugar, urine microalbumin' }, ['E11.9']),
    sunrise(5, 'Allergic rhinitis', { chief_complaint: 'Sneezing and blocked nose', history: 'Seasonal / perennial. Triggers: dust, cold air.', examination: 'No breathlessness or wheeze reported.', advice: 'Avoid known triggers, saline nasal rinse, keep bedroom dust-free.', investigations: '' }, ['J30.4']),
    sunrise(6, 'Acid peptic disease', { chief_complaint: 'Burning upper abdominal pain', history: 'Related to meals. No vomiting of blood, black stools or weight loss.', examination: 'Comfortable on video.', advice: 'Small frequent meals, avoid spicy food, late-night meals and smoking. Go to the emergency department for black stools or vomiting blood.', investigations: '' }, ['K21.9']),
    sunrise(7, 'Low back pain', { chief_complaint: 'Lower back pain', history: 'Onset after __. No leg weakness, numbness or bladder / bowel problems.', examination: 'Walking independently on video. Able to bend forward with mild discomfort.', advice: 'Stay active, avoid heavy lifting, back extension exercises, hot fomentation.', investigations: '' }, ['M54.5']),
    sunrise(8, 'Urinary tract infection', { chief_complaint: 'Burning while passing urine', history: 'Frequency and urgency for __ days. No fever, flank pain or vomiting.', examination: 'Comfortable on video.', advice: 'Drink plenty of water, do not hold urine. See a doctor in person for fever, back pain or blood in urine.', investigations: 'Urine routine and culture' }, ['N39.0']),
    sunrise(9, 'Tension-type headache', { chief_complaint: 'Headache', history: 'Band-like, both sides, no vomiting, no visual disturbance, no weakness.', examination: 'Alert and oriented on video, speech normal.', advice: 'Regular sleep, screen breaks, hydration. Seek urgent care for sudden severe headache, weakness or confusion.', investigations: '' }, ['G44.2']),
    { id: id(20), doctor_id: arunDoctorId, name: 'Hypertension review (my template)', body: { chief_complaint: 'Review of blood pressure', history: '', examination: 'Home BP readings reviewed. No pedal oedema reported.', advice: 'Low salt diet, daily walk 30 min, continue home BP log.', investigations: 'Lipid profile, Serum creatinine, ECG', diagnoses: dx('I10', 'E78.5') } },
    { id: id(21), doctor_id: arunDoctorId, name: 'Chest pain triage', body: { chief_complaint: 'Chest discomfort', history: '', examination: 'Patient comfortable on video, speaking full sentences.', advice: 'If pain is severe, crushing or with sweating, call 112 immediately.', investigations: 'ECG, Troponin I, Echo', diagnoses: [] } },
  ];
}
