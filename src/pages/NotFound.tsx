import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Button } from '@/components/ui/button';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md pt-16">
      <EmptyState art="search" title={t('notFound.title')} body={t('notFound.body')} action={<Button asChild><Link to="/">{t('notFound.home')}</Link></Button>} />
    </div>
  );
}
