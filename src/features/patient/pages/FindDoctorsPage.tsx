import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { ConsultMode } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DOCTOR_LANGUAGES, useDoctors, useMasters, type DoctorFilters } from '../api';
import { DoctorCard } from '../components/DoctorCard';
import { QueryError } from '../components/common';

const ALL = '__all';
type FilterKey = 'dept' | 'hospital' | 'lang' | 'mode' | 'today';

/** Doctor discovery. Filters live in the URL (IDs and plain options only – nothing personal). */
export function FindDoctorsPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const masters = useMasters();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const filters: DoctorFilters = useMemo(() => ({
    q: debounced,
    department: params.get('dept') ?? undefined,
    hospital: params.get('hospital') ?? undefined,
    language: params.get('lang') ?? undefined,
    mode: (params.get('mode') as ConsultMode | null) ?? undefined,
    today: params.get('today') === '1',
  }), [debounced, params]);
  const doctors = useDoctors(filters);

  const set = (k: FilterKey, v: string | null) => {
    const next = new URLSearchParams(params);
    if (!v || v === ALL) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };
  const activeCount = (['dept', 'hospital', 'lang', 'mode', 'today'] as FilterKey[]).filter((k) => params.get(k)).length;
  const clearAll = () => { setQ(''); setParams(new URLSearchParams(), { replace: true }); };
  const patientQuery = params.get('patient') ? `?patient=${params.get('patient')}` : '';

  const deptName = (id: string) => { const d = masters.data?.departments.find((x) => x.id === id); return d ? (i18n.language === 'ml' ? d.name_ml : d.name) : ''; };
  const chips: { k: FilterKey; label: string }[] = [
    params.get('dept') ? { k: 'dept' as const, label: deptName(params.get('dept')!) } : null,
    params.get('hospital') ? { k: 'hospital' as const, label: masters.data?.hospitals.find((h) => h.id === params.get('hospital'))?.city ?? '' } : null,
    params.get('lang') ? { k: 'lang' as const, label: params.get('lang')! } : null,
    params.get('mode') ? { k: 'mode' as const, label: t(`patient.mode.${params.get('mode')}`) } : null,
    params.get('today') ? { k: 'today' as const, label: t('patient.doctors.availableToday') } : null,
  ].filter((c): c is { k: FilterKey; label: string } => !!c);

  const filterFields = (px: string) => (
    <div className="space-y-4">
      <FilterSelect id={`${px}f-dept`} label={t('patient.doctors.speciality')} value={params.get('dept')} onChange={(v) => set('dept', v)}
        options={(masters.data?.departments ?? []).map((d) => ({ value: d.id, label: i18n.language === 'ml' ? d.name_ml : d.name }))} />
      <FilterSelect id={`${px}f-hosp`} label={t('patient.doctors.hospital')} value={params.get('hospital')} onChange={(v) => set('hospital', v)}
        options={(masters.data?.hospitals ?? []).map((h) => ({ value: h.id, label: `${h.name}, ${h.city}` }))} />
      <FilterSelect id={`${px}f-lang`} label={t('patient.doctors.language')} value={params.get('lang')} onChange={(v) => set('lang', v)}
        options={DOCTOR_LANGUAGES.map((l) => ({ value: l, label: l }))} />
      <FilterSelect id={`${px}f-mode`} label={t('patient.doctors.mode')} value={params.get('mode')} onChange={(v) => set('mode', v)}
        options={(['video', 'audio'] as const).map((m) => ({ value: m, label: t(`patient.mode.${m}`) }))} />
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label htmlFor={`${px}f-today`}>{t('patient.doctors.availableToday')}</Label>
        <Switch id={`${px}f-today`} checked={params.get('today') === '1'} onCheckedChange={(v) => set('today', v ? '1' : null)} />
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader back="/p" title={t('patient.doctors.title')} />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr] [&>*]:min-w-0">
        <aside className="hidden lg:block" aria-label={t('patient.doctors.filters')}>
          <div className="sticky top-20 rounded-lg border bg-card p-4 shadow-soft">
            <h2 className="mb-3 font-semibold">{t('patient.doctors.filters')}</h2>
            {filterFields('side-')}
            {activeCount > 0 && <Button variant="link" className="mt-2 px-0" onClick={clearAll}>{t('patient.doctors.clear')}</Button>}
          </div>
        </aside>
        <div className="min-w-0 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder={t('patient.doctors.searchPh')} aria-label={t('patient.doctors.searchPh')} />
            </div>
            <Button variant="outline" className="relative lg:hidden" onClick={() => setOpen(true)} aria-label={t('patient.doctors.filters')}>
              <SlidersHorizontal aria-hidden />
              <span className="hidden sm:inline">{t('patient.doctors.filters')}</span>
              {activeCount > 0 && <Badge className="absolute -right-1.5 -top-1.5 h-5 min-w-5 justify-center px-1">{activeCount}</Badge>}
            </Button>
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <button key={c.k} onClick={() => set(c.k, null)} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-primary-soft px-3 text-sm font-medium text-primary-soft-foreground" aria-label={t('patient.doctors.removeFilter', { name: c.label })}>
                  {c.label}<X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground" aria-live="polite">{doctors.data ? t('patient.doctors.count', { count: doctors.data.length }) : ''}</p>
          {doctors.isPending ? <ListSkeleton rows={4} /> : doctors.isError ? <QueryError onRetry={() => void doctors.refetch()} /> : doctors.data.length === 0 ? (
            <EmptyState art="search" title={t('patient.doctors.noneTitle')} body={t('patient.doctors.noneBody')} action={<Button variant="outline" onClick={clearAll}>{t('patient.doctors.clear')}</Button>} />
          ) : (
            <div className={`grid grid-cols-1 gap-3 xl:grid-cols-2 ${doctors.isFetching ? 'opacity-70' : ''}`}>
              {doctors.data.map((d) => <DoctorCard key={d.id} d={d} patientQuery={patientQuery} />)}
            </div>
          )}
        </div>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" closeLabel={t('common.close')}>
          <SheetTitle>{t('patient.doctors.filters')}</SheetTitle>
          <SheetDescription className="sr-only">{t('patient.doctors.filters')}</SheetDescription>
          <div className="mt-4">{filterFields('sheet-')}</div>
          <div className="mt-6 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={clearAll}>{t('patient.doctors.clear')}</Button>
            <Button className="flex-1" onClick={() => setOpen(false)}>{t('patient.doctors.showResults', { count: doctors.data?.length ?? 0 })}</Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string | null; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ALL} onValueChange={onChange}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('patient.doctors.any')}</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
