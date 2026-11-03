/** 200 common ICD-10 codes for the diagnosis search (WHO ICD-10 descriptions, abbreviated). */
import type { Icd10 } from '@/domain/types';

const raw = `A09|Infectious gastroenteritis and colitis, unspecified
A01.0|Typhoid fever
A15.0|Tuberculosis of lung
A90|Dengue fever
A91|Dengue haemorrhagic fever
A92.0|Chikungunya virus disease
A27.9|Leptospirosis, unspecified
A75.3|Scrub typhus
B01.9|Varicella without complication
B02.9|Zoster without complication
B05.9|Measles without complication
B15.9|Hepatitis A without hepatic coma
B16.9|Acute hepatitis B
B18.1|Chronic viral hepatitis B
B18.2|Chronic viral hepatitis C
B20|HIV disease
B35.4|Tinea corporis
B35.6|Tinea cruris
B36.0|Pityriasis versicolor
B37.0|Candidal stomatitis
B37.3|Candidiasis of vulva and vagina
B54|Unspecified malaria
B86|Scabies
B82.9|Intestinal parasitism, unspecified
U07.1|COVID-19, virus identified
D50.9|Iron deficiency anaemia, unspecified
D51.9|Vitamin B12 deficiency anaemia
D64.9|Anaemia, unspecified
D69.6|Thrombocytopenia, unspecified
E03.9|Hypothyroidism, unspecified
E05.9|Thyrotoxicosis, unspecified
E04.9|Nontoxic goitre, unspecified
E10.9|Type 1 diabetes mellitus without complications
E11.9|Type 2 diabetes mellitus without complications
E11.65|Type 2 diabetes mellitus with hyperglycaemia
E11.40|Type 2 diabetes mellitus with diabetic neuropathy
E11.21|Type 2 diabetes mellitus with diabetic nephropathy
E11.31|Type 2 diabetes mellitus with retinopathy
E16.2|Hypoglycaemia, unspecified
E28.2|Polycystic ovarian syndrome
E55.9|Vitamin D deficiency, unspecified
E66.9|Obesity, unspecified
E78.0|Pure hypercholesterolaemia
E78.5|Hyperlipidaemia, unspecified
E79.0|Hyperuricaemia without signs of gout
E86.0|Dehydration
E87.1|Hypo-osmolality and hyponatraemia
E87.6|Hypokalaemia
F32.9|Depressive episode, unspecified
F41.1|Generalized anxiety disorder
F41.9|Anxiety disorder, unspecified
F43.2|Adjustment disorders
F51.0|Nonorganic insomnia
F10.2|Alcohol dependence syndrome
F90.0|Attention-deficit hyperactivity disorder
G40.9|Epilepsy, unspecified
G43.9|Migraine, unspecified
G44.2|Tension-type headache
G47.3|Sleep apnoea
G51.0|Bell's palsy
G56.0|Carpal tunnel syndrome
G62.9|Polyneuropathy, unspecified
G20|Parkinson's disease
G30.9|Alzheimer's disease, unspecified
G35|Multiple sclerosis
G45.9|Transient cerebral ischaemic attack, unspecified
H10.9|Conjunctivitis, unspecified
H00.0|Hordeolum (stye)
H04.1|Dry eye syndrome
H25.9|Senile cataract, unspecified
H40.9|Glaucoma, unspecified
H52.1|Myopia
H60.9|Otitis externa, unspecified
H65.9|Nonsuppurative otitis media
H66.9|Otitis media, unspecified
H61.2|Impacted cerumen
H81.1|Benign paroxysmal vertigo
H91.9|Hearing loss, unspecified
H93.1|Tinnitus
I10|Essential (primary) hypertension
I11.9|Hypertensive heart disease without heart failure
I20.9|Angina pectoris, unspecified
I21.9|Acute myocardial infarction, unspecified
I25.1|Atherosclerotic heart disease
I48.9|Atrial fibrillation, unspecified
I49.9|Cardiac arrhythmia, unspecified
I50.9|Heart failure, unspecified
I63.9|Cerebral infarction, unspecified
I64|Stroke, not specified as haemorrhage or infarction
I69.3|Sequelae of cerebral infarction
I73.9|Peripheral vascular disease, unspecified
I80.2|Deep vein thrombosis
I83.9|Varicose veins of lower extremities
I84.9|Haemorrhoids, unspecified
I95.9|Hypotension, unspecified
J00|Acute nasopharyngitis (common cold)
J01.9|Acute sinusitis, unspecified
J02.9|Acute pharyngitis, unspecified
J03.9|Acute tonsillitis, unspecified
J04.0|Acute laryngitis
J06.9|Acute upper respiratory infection, unspecified
J11.1|Influenza with other respiratory manifestations
J18.9|Pneumonia, unspecified
J20.9|Acute bronchitis, unspecified
J30.4|Allergic rhinitis, unspecified
J32.9|Chronic sinusitis, unspecified
J35.0|Chronic tonsillitis
J44.1|COPD with acute exacerbation
J44.9|Chronic obstructive pulmonary disease, unspecified
J45.9|Asthma, unspecified
J46|Status asthmaticus
J90|Pleural effusion
K02.9|Dental caries, unspecified
K05.1|Chronic gingivitis
K12.0|Recurrent oral aphthae
K21.0|Gastro-oesophageal reflux disease with oesophagitis
K21.9|Gastro-oesophageal reflux disease without oesophagitis
K25.9|Gastric ulcer, unspecified
K27.9|Peptic ulcer, unspecified
K29.7|Gastritis, unspecified
K30|Functional dyspepsia
K35.8|Acute appendicitis, other and unspecified
K40.9|Inguinal hernia, unspecified
K42.9|Umbilical hernia
K52.9|Noninfective gastroenteritis and colitis
K58.9|Irritable bowel syndrome without diarrhoea
K59.0|Constipation
K60.2|Anal fissure, unspecified
K70.3|Alcoholic cirrhosis of liver
K74.6|Other and unspecified cirrhosis of liver
K76.0|Fatty (change of) liver, NEC
K80.2|Calculus of gallbladder without cholecystitis
K81.0|Acute cholecystitis
K85.9|Acute pancreatitis, unspecified
L01.0|Impetigo
L02.9|Cutaneous abscess, unspecified
L03.9|Cellulitis, unspecified
L20.9|Atopic dermatitis, unspecified
L21.9|Seborrhoeic dermatitis, unspecified
L23.9|Allergic contact dermatitis, unspecified
L30.9|Dermatitis, unspecified
L40.0|Psoriasis vulgaris
L50.9|Urticaria, unspecified
L60.0|Ingrowing nail
L63.9|Alopecia areata, unspecified
L65.9|Nonscarring hair loss, unspecified
L70.0|Acne vulgaris
L80|Vitiligo
M06.9|Rheumatoid arthritis, unspecified
M10.9|Gout, unspecified
M17.9|Gonarthrosis (knee osteoarthritis), unspecified
M19.9|Arthrosis, unspecified
M25.5|Pain in joint
M43.6|Torticollis
M47.8|Other spondylosis
M50.9|Cervical disc disorder, unspecified
M51.2|Other specified intervertebral disc displacement
M54.2|Cervicalgia
M54.4|Lumbago with sciatica
M54.5|Low back pain
M62.8|Muscle strain, other specified
M75.0|Adhesive capsulitis of shoulder
M77.1|Lateral epicondylitis
M79.1|Myalgia
M79.7|Fibromyalgia
M81.0|Postmenopausal osteoporosis
M72.2|Plantar fascial fibromatosis
N10|Acute pyelonephritis
N17.9|Acute kidney failure, unspecified
N18.9|Chronic kidney disease, unspecified
N20.0|Calculus of kidney
N30.0|Acute cystitis
N39.0|Urinary tract infection, site not specified
N40|Hyperplasia of prostate
N63|Unspecified lump in breast
N76.0|Acute vaginitis
N92.0|Excessive and frequent menstruation with regular cycle
N94.6|Dysmenorrhoea, unspecified
N95.1|Menopausal and female climacteric states
N97.9|Female infertility, unspecified
O21.0|Mild hyperemesis gravidarum
O24.4|Diabetes mellitus arising in pregnancy
O13|Gestational hypertension
Z34.9|Supervision of normal pregnancy, unspecified
R05|Cough
R06.0|Dyspnoea
R07.4|Chest pain, unspecified
R10.4|Other and unspecified abdominal pain
R11|Nausea and vomiting
R19.7|Diarrhoea, unspecified
R21|Rash and other nonspecific skin eruption
R42|Dizziness and giddiness
R50.9|Fever, unspecified
R51|Headache
R53|Malaise and fatigue
R55|Syncope and collapse
R63.4|Abnormal weight loss
R73.0|Abnormal glucose tolerance test (prediabetes)
S00.9|Superficial injury of head, unspecified
S13.4|Sprain of cervical spine
S60.9|Superficial injury of wrist and hand
S93.4|Sprain of ankle
T14.0|Superficial injury of unspecified body region
T63.0|Toxic effect of snake venom
T78.4|Allergy, unspecified
W54|Bitten or struck by dog
Z00.0|General medical examination
Z01.4|Gynaecological examination (general) (routine)
Z09|Follow-up examination after treatment
Z23|Need for immunization
Z71.3|Dietary counselling and surveillance
Z76.0|Issue of repeat prescription
Z79.4|Long term (current) use of insulin
Z86.7|Personal history of diseases of the circulatory system`;

export const ICD10: Icd10[] = raw.split('\n').map((l) => {
  const [code, description] = l.split('|');
  return { code, description };
});
