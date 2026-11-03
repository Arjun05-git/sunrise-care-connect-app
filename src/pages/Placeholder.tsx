import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Card } from '@/components/ui/card';

/** Placeholder for screens built in later phases. Keeps routing and navigation testable now. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t(titleKey)} />
      <Card>
        <EmptyState art="construction" title={t('placeholder.title')} body={t('placeholder.body')} />
      </Card>
    </div>
  );
}
