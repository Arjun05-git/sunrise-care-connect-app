import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useAuth } from '@/auth/AuthProvider';
import { rpcErrorCode } from '@/lib/supabase';
import { useFamily, useSavePatient } from '../api';
import { MemberForm } from '../components/MemberForm';
import { QueryError, useRpcErrorText } from '../components/common';
import { AbhaCard } from '@/features/integrations/AbhaCard';

/** Add (/p/profile/family/new) or edit (/p/profile/family/:id) a family member or my own details. */
export function MemberPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const { session, setSession } = useAuth();
  const family = useFamily();
  const save = useSavePatient();
  const errText = useRpcErrorText();
  const isNew = id === 'new';
  const member = isNew ? null : family.data?.find((m) => m.id === id);
  const isSelf = !!member?.is_primary;

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader back="/p/profile" title={isNew ? t('patient.family.add') : isSelf ? t('patient.profile.myDetails') : t('patient.family.edit')} />
      {family.isPending ? (
        <CardSkeleton />
      ) : family.isError ? (
        <QueryError onRetry={() => void family.refetch()} />
      ) : !isNew && !member ? (
        <EmptyState art="users" title={t('patient.family.notFound')} />
      ) : (
        <Card>
          <CardContent className="p-5">
            <MemberForm
              member={member}
              isSelf={isSelf}
              busy={save.isPending}
              submitLabel={t('common.save')}
              onSubmit={async (v) => {
                try {
                  await save.mutateAsync(v);
                  if (isSelf && session) setSession({ ...session, user: { ...session.user, name: v.full_name } });
                  toast.success(t('common.saved'));
                  nav('/p/profile');
                } catch (e) {
                  toast.error(errText(rpcErrorCode(e)));
                }
              }}
            />
          </CardContent>
        </Card>
      )}
      {member && <div className="mt-4"><AbhaCard patientId={member.id} /></div>}
    </div>
  );
}
