import { useLayoutEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import type { ConsentType } from '@/domain/types';
import { Logo } from '@/components/brand/Logo';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CardSkeleton } from '@/components/feedback/states';
import { ALL_CONSENTS, REQUIRED_CONSENTS, useConsents, useSetConsents, useSettings } from '../api';
import { QueryError } from '../components/common';

/**
 * Consent screen (DPDP Act 2023 + Telemedicine Practice Guidelines 2020). The texts and versions
 * come from app_settings, so legal can update them; a new version asks again. Each consent is
 * stored separately with its version and time (consents table, audited).
 */
export function ConsentPage() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const settings = useSettings();
  const consents = useConsents();
  const save = useSetConsents();
  const [checked, setChecked] = useState<Record<ConsentType, boolean>>({ terms: false, data_processing: false, teleconsultation: false, whatsapp_opt_in: false, marketing: false }); // opt-in is never pre-ticked (DPDP)

  // before paint: otherwise the boxes show unticked for one frame and a quick tap toggles a consent off
  useLayoutEffect(() => {
    if (!consents.data || !settings.data) return;
    const v = settings.data.consent_versions;
    setChecked((c) => {
      const out = { ...c };
      for (const r of consents.data) if (r.version === v[r.consent_type]) out[r.consent_type] = true;
      return out;
    });
  }, [consents.data, settings.data]);

  const allRequired = REQUIRED_CONSENTS.every((c) => checked[c]);
  const lang = i18n.language === 'ml' ? 'ml' : 'en';

  const submit = async () => {
    try {
      await save.mutateAsync({ types: ALL_CONSENTS.filter((c) => checked[c]), granted: true });
      if (!checked.whatsapp_opt_in) await save.mutateAsync({ types: ['whatsapp_opt_in'], granted: false });
      const next = params.get('next');
      nav(next && next.startsWith('/p') ? next : '/p', { replace: true });
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <div className="min-h-dvh bg-gradient-to-b from-primary-soft/60 via-background to-background">
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 py-6">
        <Logo />
        <div className="mb-5 mt-8">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-card shadow-soft"><ShieldCheck className="h-6 w-6 text-primary" aria-hidden /></div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t('patient.consent.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('patient.consent.subtitle')}</p>
        </div>
        {settings.isPending || consents.isPending ? (
          <CardSkeleton />
        ) : settings.isError ? (
          <QueryError onRetry={() => void settings.refetch()} />
        ) : (
          <Card>
            <CardContent className="space-y-1 p-2 sm:p-3">
              {ALL_CONSENTS.map((c) => (
                <label key={c} htmlFor={`consent-${c}`} className="flex cursor-pointer gap-3 rounded-xl p-3 hover:bg-accent">
                  <Checkbox id={`consent-${c}`} className="mt-0.5" checked={checked[c]} onCheckedChange={(v) => setChecked((s) => ({ ...s, [c]: v === true }))} />
                  <span className="text-sm">
                    <span className="block font-semibold">
                      {t(`patient.consent.${c}`)} {REQUIRED_CONSENTS.includes(c) ? <span className="text-destructive">*</span> : <span className="font-normal text-muted-foreground">({t('patient.optional')})</span>}
                    </span>
                    <span className="mt-0.5 block text-muted-foreground">{settings.data.consent_texts?.[c]?.[lang]}</span>
                  </span>
                </label>
              ))}
            </CardContent>
          </Card>
        )}
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm" data-ref="legal-links">
          <span className="text-muted-foreground">{t('legal.read')}</span>
          {(['terms_of_use', 'privacy_notice', 'refund_policy'] as const).map((k) => (
            <a key={k} href={`/legal/${k}`} target="_blank" rel="noopener" className="font-medium text-primary underline-offset-2 hover:underline">{t(`legal.key.${k}`)}</a>
          ))}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">{t('patient.consent.withdrawNote')}</p>
        <div className="mt-auto space-y-3 pt-6">
          <Button block size="lg" disabled={!allRequired} loading={save.isPending} onClick={() => void submit()}>{t('patient.consent.agree')}</Button>
          <EmergencyNotice compact />
        </div>
      </div>
    </div>
  );
}
