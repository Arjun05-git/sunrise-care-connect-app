import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { istDateKey } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import type { FamilyMember, PatientInput, Relation } from '../api';

export const RELATIONS: Relation[] = ['spouse', 'child', 'parent', 'sibling', 'other'];
const GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const schema = (needsRelation: boolean) =>
  z.object({
    full_name: z.string().trim().min(2, 'validation.name').max(80, 'validation.name'),
    date_of_birth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'patient.v.dob')
      .refine((d) => d <= istDateKey() && d >= `${Number(istDateKey().slice(0, 4)) - 120}-01-01`, 'patient.v.dob'),
    gender: z.enum(GENDERS, { errorMap: () => ({ message: 'validation.required' }) }),
    relation: needsRelation ? z.enum(RELATIONS as [Relation, ...Relation[]], { errorMap: () => ({ message: 'validation.required' }) }) : z.any().optional(),
    blood_group: z.string().optional(),
    allergies: z.string().max(300, 'patient.v.tooLong').optional(),
    phone: z.string().trim().regex(/^([6-9]\d{9})?$/, 'auth.err.invalid_phone').optional(),
    email: z.union([z.literal(''), z.string().trim().email('auth.err.email')]).optional(),
    address: z.string().max(300, 'patient.v.tooLong').optional(),
  });
type Values = z.infer<ReturnType<typeof schema>>;

/** Patient details form, used for the account holder (onboarding / my details) and family members. */
export function MemberForm({ member, isSelf, submitLabel, busy, onSubmit }: { member?: FamilyMember | null; isSelf: boolean; submitLabel: string; busy?: boolean; onSubmit: (v: PatientInput) => void }) {
  const { t } = useTranslation();
  const form = useForm<Values>({
    resolver: zodResolver(schema(!isSelf)),
    defaultValues: {
      full_name: member?.full_name ?? '',
      date_of_birth: member?.date_of_birth ?? '',
      gender: member?.gender,
      relation: member?.relation ?? undefined,
      blood_group: member?.blood_group ?? '',
      allergies: member?.allergies.join(', ') ?? '',
      phone: member?.phone?.replace(/^\+91/, '') ?? '',
      email: member?.email ?? '',
      address: member?.address ?? '',
    },
  });

  const submit = (v: Values) =>
    onSubmit({
      id: member?.id ?? null,
      full_name: v.full_name.trim(),
      date_of_birth: v.date_of_birth,
      gender: v.gender,
      relation: isSelf ? null : (v.relation as Relation),
      blood_group: v.blood_group || null,
      allergies: (v.allergies ?? '').split(',').map((a) => a.trim()).filter(Boolean).slice(0, 20),
      phone: v.phone ? `+91${v.phone}` : null,
      email: v.email || null,
      address: v.address || null,
    });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
        <FormField control={form.control} name="full_name" render={({ field }) => (
          <FormItem><FormLabel>{t('patient.f.fullName')}</FormLabel><FormControl><Input autoComplete={isSelf ? 'name' : 'off'} {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        {!isSelf && (
          <FormField control={form.control} name="relation" render={({ field }) => (
            <FormItem>
              <FormLabel>{t('patient.f.relation')}</FormLabel>
              <Select value={field.value as string | undefined} onValueChange={field.onChange}>
                <FormControl><SelectTrigger><SelectValue placeholder={t('patient.f.choose')} /></SelectTrigger></FormControl>
                <SelectContent>{RELATIONS.map((r) => <SelectItem key={r} value={r}>{t(`patient.relation.${r}`)}</SelectItem>)}</SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )} />
        )}
        <FormField control={form.control} name="date_of_birth" render={({ field }) => (
          <FormItem><FormLabel>{t('patient.f.dob')}</FormLabel><FormControl><Input type="date" max={istDateKey()} {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="gender" render={({ field }) => (
          <FormItem>
            <FormLabel>{t('patient.f.gender')}</FormLabel>
            <FormControl>
              <RadioGroup value={field.value} onValueChange={field.onChange} className="grid grid-cols-2 gap-2">
                {GENDERS.map((g) => (
                  <label key={g} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/50">
                    <RadioGroupItem value={g} aria-label={t(`patient.gender.${g}`)} />
                    <span className="text-sm">{t(`patient.gender.${g}`)}</span>
                  </label>
                ))}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
          <FormField control={form.control} name="blood_group" render={({ field }) => (
            <FormItem>
              <FormLabel>{t('patient.f.bloodGroup')} <span className="font-normal text-muted-foreground">({t('patient.optional')})</span></FormLabel>
              <Select value={field.value || undefined} onValueChange={field.onChange}>
                <FormControl><SelectTrigger><SelectValue placeholder={t('patient.f.unknown')} /></SelectTrigger></FormControl>
                <SelectContent>{BLOOD.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
              </Select>
            </FormItem>
          )} />
          <FormField control={form.control} name="phone" render={({ field }) => (
            <FormItem>
              <FormLabel>{t('auth.mobile')} <span className="font-normal text-muted-foreground">({t('patient.optional')})</span></FormLabel>
              <div className="flex"><span className="inline-flex items-center rounded-l-xl border border-r-0 bg-muted px-3 text-sm text-muted-foreground">+91</span>
                <FormControl><Input inputMode="numeric" maxLength={10} className="rounded-l-none" {...field} /></FormControl></div>
              <FormMessage />
            </FormItem>
          )} />
        </div>
        <FormField control={form.control} name="allergies" render={({ field }) => (
          <FormItem>
            <FormLabel>{t('patient.f.allergies')} <span className="font-normal text-muted-foreground">({t('patient.optional')})</span></FormLabel>
            <FormControl><Input placeholder={t('patient.f.allergiesPh')} {...field} /></FormControl>
            <FormDescription>{t('patient.f.allergiesHint')}</FormDescription>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="email" render={({ field }) => (
          <FormItem><FormLabel>{t('patient.f.email')} <span className="font-normal text-muted-foreground">({t('patient.optional')})</span></FormLabel><FormControl><Input type="email" autoComplete={isSelf ? 'email' : 'off'} {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem><FormLabel>{t('patient.f.address')} <span className="font-normal text-muted-foreground">({t('patient.optional')})</span></FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <Button type="submit" block size="lg" loading={busy}>{submitLabel}</Button>
      </form>
    </Form>
  );
}
