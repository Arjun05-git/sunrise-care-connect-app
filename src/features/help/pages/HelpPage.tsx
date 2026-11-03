import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Phone, Plus } from 'lucide-react';
import { formatDate, formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { rpcErrorCode } from '@/lib/supabase';
import { TICKET_VARIANT } from '@/features/admin/console-api';
import { createTicket, TICKET_CATEGORIES, useMyRecentAppointments, useMyTickets } from '../api';

/** Help & support: the user's tickets and a form to raise one (a person at Sunrise replies in the app). */
export function HelpPage() {
  const { t, i18n } = useTranslation();
  const tickets = useMyTickets();
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader back="/p/profile" title={t('help.title')} subtitle={t('help.subtitle')}
        actions={!creating && <Button size="sm" onClick={() => setCreating(true)} data-ref="new-ticket"><Plus aria-hidden />{t('help.new')}</Button>} />
      {creating && <NewTicket onDone={() => setCreating(false)} />}
      {tickets.isPending ? <ListSkeleton rows={3} /> : tickets.isError ? <ErrorState onRetry={() => void tickets.refetch()} /> : (tickets.data ?? []).length === 0 ? (
        !creating && <Card><EmptyState art="search" title={t('help.none')} body={t('help.noneBody')} /></Card>
      ) : (
        <Card><ul className="divide-y" data-ref="my-tickets">{tickets.data!.map((x) => (
          <li key={x.id}><Link to={`/p/help/${x.id}`} className="flex items-center gap-3 p-4 hover:bg-accent">
            <div className="min-w-0 flex-1"><p className="truncate font-semibold">{x.subject}</p>
              <p className="text-xs text-muted-foreground"><span className="font-mono">{x.ref_code}</span> · {t(`help.cat.${x.category}`)} · {formatDateTime(x.created_at, i18n.language)}</p></div>
            <Badge variant={TICKET_VARIANT[x.status]}>{t(`help.st.${x.status}`)}</Badge><ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          </Link></li>))}</ul></Card>
      )}
      <p className="flex items-center gap-2 text-sm text-muted-foreground"><Phone className="h-4 w-4" aria-hidden />{t('help.call')}</p>
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const appts = useMyRecentAppointments();
  const [category, setCategory] = useState<string>('appointment');
  const [appt, setAppt] = useState('none');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = subject.trim().length >= 5 && body.trim().length >= 10;
  const send = async () => {
    setBusy(true);
    try {
      const id = await createTicket(category, subject.trim(), body.trim(), appt === 'none' ? null : appt);
      toast.success(t('help.created'));
      await qc.invalidateQueries({ queryKey: ['help'] });
      onDone();
      nav(`/p/help/${id}`);
    } catch (e) {
      toast.error(rpcErrorCode(e) === 'rate_limited' ? t('help.rateLimited') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-ref="ticket-form">
      <CardHeader><CardTitle>{t('help.new')}</CardTitle><CardDescription>{t('help.newHint')}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="h-cat">{t('help.category')}</Label>
            <Select value={category} onValueChange={setCategory}><SelectTrigger id="h-cat"><SelectValue /></SelectTrigger>
              <SelectContent>{TICKET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`help.cat.${c}`)}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="h-appt">{t('help.booking')}</Label>
            <Select value={appt} onValueChange={setAppt}><SelectTrigger id="h-appt"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">{t('help.noBooking')}</SelectItem>
                {(appts.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.ref_code} · {formatDate(a.start_at, i18n.language)}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="h-sub">{t('help.subject')}</Label><Input id="h-sub" maxLength={140} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="h-body">{t('help.describe')}</Label><Textarea id="h-body" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('help.privacy')}</p></div>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onDone}>{t('common.cancel')}</Button><Button disabled={!ok} loading={busy} onClick={() => void send()} data-ref="ticket-submit">{t('help.send')}</Button></div>
      </CardContent>
    </Card>
  );
}
