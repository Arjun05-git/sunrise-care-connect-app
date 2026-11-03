import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '@/components/brand/Logo';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { formatDateLong } from '@/domain/time';
import { publicContent } from '@/features/admin/console-api';
import { NotFound } from './NotFound';

const KEYS = ['terms_of_use', 'privacy_notice', 'refund_policy'];

/** Public legal pages (/legal/:key) – the latest published version from Admin → Content. No sign-in. */
export function LegalPage() {
  const { key = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'ml' ? 'ml' : 'en';
  const q = useQuery({ queryKey: ['legal', key], enabled: KEYS.includes(key), queryFn: () => publicContent(key) });
  if (!KEYS.includes(key)) return <NotFound />;
  const doc = q.data;
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-2xl px-4 py-6">
      <Link to="/" aria-label={t('nav.home')}><Logo /></Link>
      {q.isPending ? <CardSkeleton className="mt-6" /> : q.isError || !doc ? <ErrorState onRetry={() => void q.refetch()} /> : (
        <article className="mt-6 space-y-4" data-ref="legal-doc">
          <header>
            <h1 className="text-2xl font-extrabold tracking-tight">{(lang === 'ml' ? doc.title_ml : doc.title_en) || t(`legal.key.${key}`)}</h1>
            <p className="text-sm text-muted-foreground">{t('legal.version', { version: doc.version, date: formatDateLong(doc.published_at, i18n.language) })}</p>
          </header>
          <div className="whitespace-pre-wrap text-sm leading-relaxed" lang={lang}>{lang === 'ml' ? doc.body_ml : doc.body_en}</div>
          <nav className="flex flex-wrap gap-3 border-t pt-4 text-sm" aria-label={t('legal.other')}>
            {KEYS.filter((k) => k !== key).map((k) => <Link key={k} to={`/legal/${k}`} className="font-medium text-primary hover:underline">{t(`legal.key.${k}`)}</Link>)}
          </nav>
          <EmergencyNotice compact />
        </article>
      )}
    </main>
  );
}
