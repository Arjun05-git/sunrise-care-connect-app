import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Clock, Languages, Phone, Star, Video } from 'lucide-react';
import { formatDate, formatTime, istDateKey } from '@/domain/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { DoctorCard as Doc } from '../api';
import { PersonAvatar, rupees } from './common';

export function nextSlotLabel(iso: string | null, t: (k: string, o?: Record<string, unknown>) => string, lang: string) {
  if (!iso) return t('patient.doctors.noSlots');
  const d = istDateKey(iso);
  const today = istDateKey();
  const tomorrow = istDateKey(new Date(Date.now() + 86_400_000));
  const day = d === today ? t('patient.today') : d === tomorrow ? t('patient.tomorrow') : formatDate(iso, lang);
  return t('patient.doctors.next', { when: `${day}, ${formatTime(iso, lang)}` });
}

export function DoctorCard({ d, patientQuery = '' }: { d: Doc; patientQuery?: string }) {
  const { t, i18n } = useTranslation();
  const href = `/p/doctors/${d.id}${patientQuery}`;
  return (
    <Card className="relative min-w-0 transition-shadow hover:shadow-lift">
      <CardContent className="p-4">
        <div className="flex gap-3">
          <PersonAvatar name={d.full_name} src={d.photo_url} className="h-16 w-16" />
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1 font-semibold"><Link to={href} className="truncate after:absolute after:inset-0 focus-visible:outline-none">{d.full_name}</Link><BadgeCheck className="h-4 w-4 shrink-0 text-primary" aria-label={t('patient.doctors.verified')} /></h3>
            <p className="truncate text-sm text-muted-foreground">{d.qualification}</p>
            <p className="truncate text-sm">{i18n.language === 'ml' ? d.department_name_ml : d.department_name} · {d.hospital_city}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{t('patient.doctors.years', { count: d.experience_years })}</span>
              {d.rating_count > 0 && <span className="inline-flex items-center gap-0.5"><Star className="h-3.5 w-3.5 fill-highlight text-highlight" aria-hidden />{Number(d.rating_avg).toFixed(1)} ({d.rating_count})</span>}
              <span className="inline-flex items-center gap-1"><Languages className="h-3.5 w-3.5" aria-hidden />{d.languages.join(', ')}</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <div className="min-w-0 text-sm">
            <p className="flex items-center gap-1 font-medium text-primary"><Clock className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">{nextSlotLabel(d.next_slot, t, i18n.language)}</span></p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {d.modes.map((m) => <Badge key={m} variant="outline" className="gap-1">{m === 'video' ? <Video className="h-3 w-3" aria-hidden /> : <Phone className="h-3 w-3" aria-hidden />}{t(`patient.mode.${m}`)}</Badge>)}
            </div>
          </div>
          {/* the price always sits in the same place, above Book */}
          <div className="flex shrink-0 flex-col items-end gap-1">
            {d.fee_from != null && <span className="text-sm text-muted-foreground">{t('patient.doctors.feeFrom', { fee: rupees(d.fee_from, i18n.language) })}</span>}
            <Button size="sm" className="relative z-10" asChild><Link to={href}>{t('patient.doctors.book')}</Link></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
