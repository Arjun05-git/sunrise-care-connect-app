import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Search, Send } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { cn } from '@/lib/utils';
import { ReadOnlyNote, useAdminError, useHasRole } from '../components';
import { postTicketMessage, staffList, TICKET_CATEGORIES, TICKET_VARIANT, updateTicket, useTicket, useTickets, type TicketStatus } from '../console-api';

const VIEWS = ['active', 'open', 'in_progress', 'resolved', 'closed', 'all'] as const;

/** Support tickets: queue, conversation (internal notes stay with staff), assignment and resolution. */
export function SupportPage() {
  const { t, i18n } = useTranslation();
  const allowed = useHasRole('admin', 'coordinator');
  const [view, setView] = useState<(typeof VIEWS)[number]>('active');
  const [category, setCategory] = useState('all');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  const list = useTickets({ status: view === 'all' ? undefined : view, category: category === 'all' ? undefined : category, assignee: mine ? 'me' : undefined, q: term || undefined });
  if (!allowed) return <div className="space-y-4"><PageHeader title={t('admin.support')} /><ReadOnlyNote>{t('adm.tkt.noAccess')}</ReadOnlyNote></div>;
  const rows = list.data?.rows ?? [];
  const age = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.support')} subtitle={t('adm.tkt.subtitle')} />
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5"><Label htmlFor="t-view">{t('adm.tkt.view')}</Label>
          <Select value={view} onValueChange={(v) => setView(v as typeof view)}><SelectTrigger id="t-view"><SelectValue /></SelectTrigger>
            <SelectContent>{VIEWS.map((v) => <SelectItem key={v} value={v}>{t(`adm.tkt.v.${v}`)}{list.data?.counts && v !== 'all' && v !== 'active' ? ` (${list.data.counts[v] ?? 0})` : ''}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="t-cat">{t('adm.tkt.category')}</Label>
          <Select value={category} onValueChange={setCategory}><SelectTrigger id="t-cat"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{TICKET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`help.cat.${c}`)}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="t-q">{t('adm.tkt.search')}</Label>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="t-q" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.tkt.searchPh')} /></div></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><Switch checked={mine} onCheckedChange={setMine} />{t('adm.tkt.mine')}</label>
      </Card>
      {list.isPending ? <ListSkeleton rows={4} /> : list.isError ? <ErrorState onRetry={() => void list.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="search" title={t('adm.tkt.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm" data-ref="ticket-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">{['ref', 'subject', 'from', 'assignee', 'age', 'status'].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{t(`adm.tkt.col.${h}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="cursor-pointer border-b last:border-0 hover:bg-accent" onClick={() => setOpen(r.id)}>
                <td className="px-4 py-2.5"><button className="font-mono text-xs font-semibold text-primary hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{r.ref_code}</button></td>
                <td className="px-4 py-2.5"><span className="font-medium">{r.subject}</span><span className="block text-xs text-muted-foreground">{t(`help.cat.${r.category}`)}{r.appointment_ref ? ` · ${r.appointment_ref}` : ''} · {t('adm.tkt.messages', { count: r.messages })}</span></td>
                <td className="px-4 py-2.5">{r.user_name}<span className="block text-xs text-muted-foreground">{r.user_phone}</span></td>
                <td className="px-4 py-2.5">{r.assignee_name ?? <span className="text-muted-foreground">{t('adm.tkt.unassigned')}</span>}</td>
                <td className={cn('px-4 py-2.5 tabular-nums', !r.first_response_at && r.status === 'open' && age(r.created_at) >= 24 && 'font-semibold text-destructive')}>
                  {t('adm.tkt.hours', { count: age(r.created_at) })}{!r.first_response_at && r.status === 'open' && <span className="block text-xs font-normal">{t('adm.tkt.noReply')}</span>}</td>
                <td className="px-4 py-2.5"><Badge variant={TICKET_VARIANT[r.status]}>{t(`help.st.${r.status}`)}</Badge></td>
              </tr>))}</tbody>
          </table>
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" closeLabel={t('common.close')} className="w-full overflow-y-auto sm:max-w-lg">
          {open && <TicketDetail id={open} lang={i18n.language} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function TicketDetail({ id, lang }: { id: string; lang: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const { session } = useAuth();
  const q = useTicket(id);
  const staff = useQuery({ queryKey: ['console', 'staff'], queryFn: staffList });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState<TicketStatus>('open');
  const [assignee, setAssignee] = useState('none');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const tk = q.data?.ticket;
  useEffect(() => { if (tk) { setStatus(tk.status); setAssignee(tk.assigned_to ?? 'none'); setResolution(tk.resolution ?? ''); } }, [tk]);
  if (q.isPending) return <><SheetTitle className="sr-only">{t('admin.support')}</SheetTitle><ListSkeleton rows={3} /></>;
  if (q.isError || !tk) return <><SheetTitle className="sr-only">{t('admin.support')}</SheetTitle><ErrorState onRetry={() => void q.refetch()} /></>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['console'] });
  const assignable = (staff.data ?? []).filter((u) => u.roles.some((r) => r === 'admin' || r === 'coordinator'));
  const send = async () => {
    setBusy(true);
    try {
      await postTicketMessage(tk.id, body.trim(), internal);
      setBody('');
      toast.success(internal ? t('adm.tkt.noteAdded') : t('adm.tkt.replied'));
      await refresh();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await updateTicket(tk.id, status, assignee === 'none' ? null : assignee, resolution);
      toast.success(t('adm.tkt.updated'));
      await refresh();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-ref="ticket-detail">
      <div><SheetTitle>{tk.subject}</SheetTitle>
        <SheetDescription><span className="font-mono">{tk.ref_code}</span> · {t(`help.cat.${tk.category}`)} · {formatDateTime(tk.created_at, lang)}</SheetDescription></div>
      <p className="whitespace-pre-wrap rounded-xl bg-muted/60 p-3 text-sm">{tk.description}</p>
      <ol className="space-y-2" aria-label={t('adm.tkt.conversation')}>
        {q.data!.messages.map((m) => (
          <li key={m.id} className={cn('rounded-xl border p-3 text-sm', m.internal ? 'border-dashed bg-warning-soft/40' : m.author_kind === 'staff' ? 'bg-primary-soft/40' : 'bg-card')}>
            <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {m.internal && <Lock className="h-3 w-3" aria-hidden />}
              {m.internal ? t('adm.tkt.internal') : m.author_kind === 'staff' ? t('adm.tkt.sunrise') : t('adm.tkt.user')} · {formatDateTime(m.created_at, lang)}
            </p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>
      {tk.status !== 'closed' && (
        <div className="space-y-2">
          <Label htmlFor="t-reply">{internal ? t('adm.tkt.noteLabel') : t('adm.tkt.replyLabel')}</Label>
          <Textarea id="t-reply" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm"><Switch checked={internal} onCheckedChange={setInternal} data-ref="internal-toggle" />{t('adm.tkt.internalToggle')}</label>
            <Button size="sm" disabled={!body.trim()} loading={busy} onClick={() => void send()} data-ref="ticket-send"><Send aria-hidden />{internal ? t('adm.tkt.addNote') : t('adm.tkt.reply')}</Button>
          </div>
          {!internal && <p className="text-xs text-muted-foreground">{t('adm.tkt.replyHint')}</p>}
        </div>
      )}
      <Separator />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="t-st">{t('adm.tkt.status')}</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)}><SelectTrigger id="t-st"><SelectValue /></SelectTrigger>
            <SelectContent>{(['open', 'in_progress', 'resolved', 'closed'] as const).map((s) => <SelectItem key={s} value={s}>{t(`help.st.${s}`)}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="t-as">{t('adm.tkt.assignee')}</Label>
          <Select value={assignee} onValueChange={setAssignee}><SelectTrigger id="t-as"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">{t('adm.tkt.unassigned')}</SelectItem>
              {assignable.map((u) => <SelectItem key={u.id} value={u.id}>{u.full_name}{u.id === session?.user.id ? ` (${t('adm.users.you')})` : ''}</SelectItem>)}</SelectContent></Select></div>
        {(status === 'resolved' || status === 'closed') && (
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="t-res">{t('adm.tkt.resolution')}</Label>
            <Textarea id="t-res" rows={2} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} /></div>
        )}
      </div>
      <div className="flex justify-end"><Button variant="secondary" loading={busy} disabled={(status === 'resolved' || status === 'closed') && resolution.trim().length < 5} onClick={() => void save()} data-ref="ticket-save">{t('adm.tkt.save')}</Button></div>
    </div>
  );
}
