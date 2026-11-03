import { z } from 'zod';

/** Pre-consult form vocabulary (stored as stable English codes; labels are translated). */
export const BODY_AREAS = ['general', 'head', 'eyes_ent', 'chest', 'stomach', 'skin', 'joints_back', 'urinary', 'women', 'mental', 'child'] as const;
export const SYMPTOMS = [
  'fever', 'cough', 'cold', 'sore_throat', 'headache', 'body_ache', 'fatigue', 'breathlessness', 'chest_pain', 'palpitations',
  'dizziness', 'vomiting', 'diarrhoea', 'abdominal_pain', 'rash', 'itching', 'joint_pain', 'back_pain', 'burning_urine', 'anxiety', 'sleep',
] as const;
export const DURATIONS = ['today', '1_3_days', '4_7_days', '1_4_weeks', 'over_month'] as const;

/** Symptoms that may need emergency care – the form shows the 112 warning prominently. */
export const RED_FLAGS: readonly string[] = ['chest_pain', 'breathlessness', 'palpitations'];

const optionalRange = (min: number, max: number) =>
  z.string().trim().refine((v) => v === '' || (/^\d+(\.\d+)?$/.test(v) && Number(v) >= min && Number(v) <= max), 'patient.v.range');

export const symptomSchema = z.object({
  body_area: z.enum(BODY_AREAS, { errorMap: () => ({ message: 'patient.v.bodyArea' }) }),
  symptoms: z.array(z.enum(SYMPTOMS)).max(20),
  duration: z.enum(DURATIONS, { errorMap: () => ({ message: 'patient.v.duration' }) }),
  severity: z.number().int().min(0).max(10),
  description: z.string().trim().min(10, 'patient.v.describe').max(1000, 'patient.v.tooLong'),
  vitals: z.object({
    bp: z.string().trim().refine((v) => v === '' || /^\d{2,3}\/\d{2,3}$/.test(v), 'patient.v.bp'),
    pulse: optionalRange(30, 220),
    temperature: optionalRange(93, 110),
    spo2: optionalRange(50, 100),
    weight: optionalRange(1, 300),
    sugar: optionalRange(20, 700),
  }),
  allergies: z.string().max(300, 'patient.v.tooLong'),
  current_medicines: z.string().max(500, 'patient.v.tooLong'),
  past_history: z.string().max(500, 'patient.v.tooLong'),
});

export type SymptomValues = z.infer<typeof symptomSchema>;
export const VITAL_KEYS = ['bp', 'pulse', 'temperature', 'spo2', 'weight', 'sugar'] as const;
