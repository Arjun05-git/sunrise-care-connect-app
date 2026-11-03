import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Search } from 'lucide-react';
import { ageFromDob, formatDate, formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { PersonAvatar } from '@/features/patient/components/common';
import { useMyDoctor, useMyPatients } from '../api';

/** Patients this doctor has consulted or has booked – only these are visible under RLS. */
export function PatientsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const me = useMyDoctor();
  const patients = useMyPatients(me.data?.id);
  const [q, setQ] = useState('');
  const list = useMemo(() => (patients.data ?? []).filter((p) => !q || `${p.patient.full_name} ${p.patient.his_mrn ?? ''}`.toLowerCase().includes(q.toLowerCase())), [patients.data, q]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t('nav.patients')} subtitle={t('doctor.pts.subtitle')} />
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" className="pl-11" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('doctor.pts.search')} aria-label={t('doctor.pts.search')} />
      </div>
      {patients.isPending || me.isPending ? <ListSkeleton rows={4} /> : patients.isError ? <ErrorState onRetry={() => void patients.refetch()} /> : list.length === 0 ? (
        <Card><EmptyState art="users" title={t('doctor.pts.none')} /></Card>
      ) : (
        <Card>
          <ul className="divide-y">
            {list.map(({ patient: p, visits, last, next }) => (
              <li key={p.id}>
                <Link to={`/d/patients/${p.id}`} className="flex items-center gap-3 p-4 hover:bg-accent">
                  <PersonAvatar name={p.full_name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.full_name} <span className="text-sm font-normal text-muted-foreground">· {t('patient.age', { count: ageFromDob(p.date_of_birth) })} · {t(`patient.gender.${p.gender}`)}</span></p>
                    <p className="truncate text-xs text-muted-foreground">
                      {next ? t('doctor.pts.next', { when: formatDateTime(next, lang) }) : last ? t('doctor.pts.last', { when: formatDate(last, lang) }) : ''}
                      {visits > 0 ? ` · ${t('doctor.pts.visits', { count: visits })}` : ''}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
