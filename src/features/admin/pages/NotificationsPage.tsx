import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeIndianRupee, ChevronLeft, ChevronRight, Eye, MousePointerClick, Pencil, RotateCw, Send } from 'lucide-react';
import { addDaysKey, formatDateTime, fromIst, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import {
  PAGE, render, retry, saveCosts, saveTemplate, useCosts, useOutbox, useStats, useTemplates,
  type Channel, type OutboxFilters, type OutboxRow, type Status, type Template,
} from '@/features/notifications/api';
import { ReasonDialog, useAdminError, useHasRole } from '../components';

const CHANNELS: Channel[] = ['whatsapp', 'sms', 'push', 'in_app'];
const STATUSES: Status[] = ['queued', 'sent', 'delivered', 'read', 'failed', 'skipped'];
const STATUS_VARIANT: Record<Status, BadgeProps['variant']> = { queued: 'outline', sent: 'neutral', delivered: 'success', read: 'success', failed: 'destructive', skipped: 'warning' };
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Admin: outbox with delivery status and cost counters, template management, cost rates. */
export function NotificationsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.notifications')} subtitle={t('notify.admin.subtitle')} />
      <Tabs defaultValue="outbox">
        <TabsList>
          <TabsTrigger value="outbox">{t('notify.admin.outbox')}</TabsTrigger>
          <TabsTrigger value="templates">{t('notify.admin.templates')}</TabsTrigger>
          <TabsTrigger value="costs">{t('notify.admin.costs')}</TabsTrigger>
        </TabsList>
        <TabsContent value="outbox"><Outbox /></TabsContent>
        <TabsContent value="templates"><Templates /></TabsContent>
        <TabsContent value="costs"><Costs /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- outbox
function Outbox() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const today = istDateKey();
  const [fromKey, setFromKey] = useState(addDaysKey(today, -6));
  const [toKey, setToKey] = useState(today);
  const [channel, setChannel] = useState<Channel | ''>('');
  const [status, setStatus] = useState<Status | ''>('');
  const [template, setTemplate] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<OutboxRow | null>(null);
  const from = fromIst(fromKey, '00:00').toISOString();
  const to = fromIst(addDaysKey(toKey, 1), '00:00').toISOString();
  const f: OutboxFilters = { channel, status, template, from, to, page };
  const outbox = useOutbox(f);
  const stats = useStats(from, to);
  const templates = useTemplates();
  const live = useRealtime('outbox', [{ table: 'notifications' }], [['notifications', 'outbox'], ['notifications', 'stats']]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const pages = Math.max(1, Math.ceil((outbox.data?.count ?? 0) / PAGE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5"><Label htmlFor="o-from">{t('admin.pay.from')}</Label><Input id="o-from" type="date" max={toKey} value={fromKey} onChange={(e) => reset(setFromKey)(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="o-to">{t('admin.pay.to')}</Label><Input id="o-to" type="date" max={today} value={toKey} onChange={(e) => reset(setToKey)(e.target.value)} /></div>
        <LiveBadge state={live} />
      </div>

      {/* counters */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-5" data-ref="outbox-stats">
        {CHANNELS.map((c) => {
          const s = stats.data?.by_channel.find((x) => x.channel === c);
          const sent = (s?.sent ?? 0) + (s?.delivered ?? 0) + (s?.read ?? 0);
          return (
            <Card key={c}>
              <CardContent className="space-y-1 p-4 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`notify.channel.${c}`)}</p>
                <p className="text-2xl font-bold" data-ref={`count-${c}`}>{sent}</p>
                <p className="text-xs text-muted-foreground">{t('notify.admin.counts', { delivered: (s?.delivered ?? 0) + (s?.read ?? 0), failed: s?.failed ?? 0, queued: s?.queued ?? 0, skipped: s?.skipped ?? 0 })}</p>
                {c === 'whatsapp' && !!s?.read && <p className="text-xs text-muted-foreground">{t('notify.admin.readCount', { count: s.read })}</p>}
                <p className="text-xs font-medium">{rupees(s?.cost_paise ?? 0)}</p>
              </CardContent>
            </Card>
          );
        })}
        <Card className="border-primary/40 bg-primary-soft/30">
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><BadgeIndianRupee className="h-4 w-4" aria-hidden />{t('notify.admin.cost')}</p>
            <p className="text-2xl font-bold" data-ref="cost-period">{rupees(stats.data?.cost_paise ?? 0)}</p>
            <p className="text-xs text-muted-foreground">{t('notify.admin.monthCost', { amount: rupees(stats.data?.month_cost_paise ?? 0) })}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground"><MousePointerClick className="h-3.5 w-3.5" aria-hidden />{t('notify.admin.clicked', { count: stats.data?.by_channel.reduce((n, x) => n + x.clicked, 0) ?? 0 })}</p>
          </CardContent>
        </Card>
      </div>

      {/* filters */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="o-ch">{t('notify.admin.channel')}</Label>
          <Select value={channel || 'all'} onValueChange={(v) => reset(setChannel)(v === 'all' ? '' : (v as Channel))}>
            <SelectTrigger id="o-ch"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{CHANNELS.map((c) => <SelectItem key={c} value={c}>{t(`notify.channel.${c}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-st">{t('admin.pay.status')}</Label>
          <Select value={status || 'all'} onValueChange={(v) => reset(setStatus)(v === 'all' ? '' : (v as Status))}>
            <SelectTrigger id="o-st"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`notify.status.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="o-tpl">{t('notify.admin.template')}</Label>
          <Select value={template || 'all'} onValueChange={(v) => reset(setTemplate)(v === 'all' ? '' : v)}>
            <SelectTrigger id="o-tpl"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{templates.data?.map((x) => <SelectItem key={x.key} value={x.key}>{t(`notify.tpl.${x.key}`, { defaultValue: x.key })}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {outbox.isPending ? <ListSkeleton rows={5} /> : outbox.isError ? <ErrorState onRetry={() => void outbox.refetch()} /> : outbox.data.rows.length === 0 ? (
        <Card><EmptyState art="bell" title={t('notify.admin.empty')} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-ref="outbox-table">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>{['time', 'template', 'channel', 'to', 'status', 'attempts', 'cost'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{t(`notify.admin.col.${h}`)}</th>)}<th className="sr-only">{t('notify.admin.col.open')}</th></tr>
              </thead>
              <tbody>
                {outbox.data.rows.map((r) => (
                  <tr key={r.id} className="border-t" data-ref="outbox-row">
                    <td className="whitespace-nowrap px-3 py-2">{formatDateTime(r.created_at, i18n.language)}</td>
                    <td className="px-3 py-2">{t(`notify.tpl.${r.template_key}`, { defaultValue: r.template_key })}</td>
                    <td className="px-3 py-2">{t(`notify.channel.${r.channel}`)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.to_masked ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]}>{t(`notify.status.${r.status}`)}</Badge>
                      {r.error && <span className="ml-1.5 text-xs text-muted-foreground">{t(`notify.error.${r.error.split(':')[0]}`, { defaultValue: r.error })}</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.attempts}</td>
                    <td className="px-3 py-2 tabular-nums">{rupees(r.cost_paise)}</td>
                    <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(r)} aria-label={t('notify.admin.details')}><Eye className="h-4 w-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{t('notify.admin.total', { count: outbox.data.count })}</span>
            <span className="flex items-center gap-1">
              <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t('notify.admin.prev')}><ChevronLeft className="h-4 w-4" /></Button>
              {page + 1} / {pages}
              <Button size="icon" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t('notify.admin.next')}><ChevronRight className="h-4 w-4" /></Button>
            </span>
          </div>
        </Card>
      )}
      <MessageSheet row={open} onClose={() => setOpen(null)} onRetried={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['notifications'] }); }} />
    </div>
  );
}

function MessageSheet({ row, onClose, onRetried }: { row: OutboxRow | null; onClose: () => void; onRetried: () => void }) {
  const { t, i18n } = useTranslation();
  const errText = useAdminError();
  const canRetry = useHasRole('admin', 'coordinator');
  const [busy, setBusy] = useState(false);
  const steps: [string, string | null][] = row ? [
    ['queued', row.created_at], ['scheduled', row.send_after !== row.created_at ? row.send_after : null], ['sent', row.sent_at], ['delivered', row.delivered_at],
    ['read', row.seen_at], ['clicked', row.clicked_at], ['failed', row.failed_at],
  ] : [];
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
        {row && (
          <div className="space-y-4">
            <SheetTitle>{t(`notify.tpl.${row.template_key}`, { defaultValue: row.template_key })}</SheetTitle>
            <SheetDescription>{t(`notify.channel.${row.channel}`)} · {row.to_masked ?? '—'} · {row.language.toUpperCase()} · {row.provider ?? '—'}</SheetDescription>
            <p className="whitespace-pre-wrap rounded-xl bg-muted/60 p-3 text-sm" data-ref="message-text">{row.rendered_text}</p>
            <ol className="space-y-1 text-sm">
              {steps.filter(([, at]) => at).map(([k, at]) => <li key={k} className="flex justify-between gap-2"><span>{t(`notify.step.${k}`)}</span><span className="text-muted-foreground">{formatDateTime(at!, i18n.language)}</span></li>)}
            </ol>
            {row.error && <p className="text-sm text-destructive">{t(`notify.error.${row.error.split(':')[0]}`, { defaultValue: row.error })}</p>}
            <p className="text-xs text-muted-foreground">{t('notify.admin.privacy')}</p>
            {row.status === 'failed' && canRetry && (
              <Button loading={busy} onClick={() => { setBusy(true); void retry(row.id).then(() => { toast.success(t('notify.admin.retried')); onRetried(); }).catch((e) => toast.error(errText(e))).finally(() => setBusy(false)); }}>
                <RotateCw aria-hidden />{t('notify.admin.retry')}
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- templates
function Templates() {
  const { t } = useTranslation();
  const tpl = useTemplates();
  const [edit, setEdit] = useState<Template | null>(null);
  if (tpl.isPending) return <ListSkeleton rows={6} />;
  if (tpl.isError) return <ErrorState onRetry={() => void tpl.refetch()} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('notify.admin.templatesHint')}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {tpl.data.map((x) => (
          <Card key={x.key} className={cn(!x.active && 'opacity-60')} data-ref={`tpl-${x.key}`}>
            <CardContent className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="font-semibold">{t(`notify.tpl.${x.key}`, { defaultValue: x.key })}</p>
                <Badge variant="outline" className="text-[10px]">{t(`notify.audience.${x.audience}`)}</Badge>
                <Badge variant="neutral" className="text-[10px]">{t(`notify.category.${x.category}`)}</Badge>
                {x.quiet_hours && <Badge variant="outline" className="text-[10px]">{t('notify.admin.quiet')}</Badge>}
                {!x.active && <Badge variant="warning" className="text-[10px]">{t('notify.admin.off')}</Badge>}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEdit(x)} aria-label={t('notify.admin.edit', { name: x.key })}><Pencil className="h-4 w-4" /></Button>
              </div>
              <p className="text-muted-foreground">{render(x.body_en)}</p>
              <p className="text-xs text-muted-foreground">{x.channels.map((c) => t(`notify.channel.${c}`)).join(' · ')} · <span className="font-mono">{x.provider_template_name}</span>{x.sms_dlt_template_id && <> · DLT <span className="font-mono">{x.sms_dlt_template_id}</span></>}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <TemplateSheet tpl={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function TemplateSheet({ tpl, onClose }: { tpl: Template | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const isAdmin = useHasRole('admin');
  const [draft, setDraft] = useState<Template | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = draft && tpl && draft.key === tpl.key ? draft : tpl;
  const set = (p: Partial<Template>) => d && setDraft({ ...d, ...p });
  const unknown = useMemo(() => {
    if (!d) return [];
    const all = [d.body_en, d.body_ml, d.sms_body_en ?? '', d.sms_body_ml ?? ''].join(' ');
    return [...new Set([...all.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).filter((v) => !d.variables.includes(v)))];
  }, [d]);
  const save = async (reason: string) => {
    if (!d) return;
    setBusy(true);
    try {
      await saveTemplate(d.key, { body_en: d.body_en, body_ml: d.body_ml, sms_body_en: d.sms_body_en ?? '', sms_body_ml: d.sms_body_ml ?? '', channels: d.channels, active: d.active,
        quiet_hours: d.quiet_hours, provider_template_name: d.provider_template_name, sms_dlt_template_id: d.sms_dlt_template_id ?? '' }, reason);
      toast.success(t('notify.admin.saved'));
      await qc.invalidateQueries({ queryKey: ['notifications', 'templates'] });
      setConfirm(false);
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!tpl} onOpenChange={(o) => { if (!o) { setDraft(null); onClose(); } }}>
      <SheetContent side="right" className="w-full max-w-xl overflow-y-auto">
        {d && (
          <div className="space-y-4">
            <SheetTitle>{t(`notify.tpl.${d.key}`, { defaultValue: d.key })}</SheetTitle>
            <SheetDescription>{d.description}</SheetDescription>
            <p className="rounded-lg bg-muted p-2 text-xs">{t('notify.admin.vars')} {d.variables.map((v) => <code key={v} className="mx-0.5 rounded bg-card px-1">{`{{${v}}}`}</code>)}</p>
            {(['body_en', 'body_ml', 'sms_body_en', 'sms_body_ml'] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`t-${k}`}>{t(`notify.admin.field.${k}`)}</Label>
                <Textarea id={`t-${k}`} rows={3} maxLength={1000} disabled={!isAdmin} value={d[k] ?? ''} placeholder={k.startsWith('sms') ? t('notify.admin.smsSame') : undefined} onChange={(e) => set({ [k]: e.target.value })} />
                {d[k] && <p className="text-xs text-muted-foreground"><Send className="mr-1 inline h-3 w-3" aria-hidden />{render(d[k]!)}</p>}
              </div>
            ))}
            {unknown.length > 0 && <p role="alert" className="text-sm text-destructive">{t('notify.admin.unknownVars', { list: unknown.join(', ') })}</p>}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('notify.admin.channels')}</legend>
              <div className="flex flex-wrap gap-4">
                {CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={d.channels.includes(c)} disabled={!isAdmin} onCheckedChange={(v) => set({ channels: v ? [...d.channels, c] : d.channels.filter((x) => x !== c) })} />{t(`notify.channel.${c}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="t-wa">{t('notify.admin.field.provider_template_name')}</Label><Input id="t-wa" disabled={!isAdmin} value={d.provider_template_name} onChange={(e) => set({ provider_template_name: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="t-dlt">{t('notify.admin.field.sms_dlt_template_id')}</Label><Input id="t-dlt" disabled={!isAdmin} value={d.sms_dlt_template_id ?? ''} onChange={(e) => set({ sms_dlt_template_id: e.target.value })} /></div>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm"><span>{t('notify.admin.quietLong')}</span><Switch checked={d.quiet_hours} disabled={!isAdmin} onCheckedChange={(v) => set({ quiet_hours: v })} /></label>
            <label className="flex items-center justify-between gap-3 text-sm"><span>{t('notify.admin.active')}</span><Switch checked={d.active} disabled={!isAdmin} onCheckedChange={(v) => set({ active: v })} /></label>
            <p className="text-xs text-muted-foreground">{t('notify.admin.approvalHint')}</p>
            {isAdmin && <Button disabled={unknown.length > 0 || d.channels.length === 0} onClick={() => setConfirm(true)} data-ref="tpl-save">{t('common.save')}</Button>}
            <ReasonDialog open={confirm} onOpenChange={setConfirm} title={t('notify.admin.saveTitle')} confirmLabel={t('common.save')} busy={busy} onConfirm={(r) => void save(r)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- costs
function Costs() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const costs = useCosts();
  const errText = useAdminError();
  const allowed = useHasRole('admin', 'finance');
  const [draft, setDraft] = useState<{ whatsapp: string; sms: string; push: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!costs.data) return <ListSkeleton rows={2} />;
  const d = draft ?? { whatsapp: String(costs.data.whatsapp / 100), sms: String(costs.data.sms / 100), push: String(costs.data.push / 100) };
  const paise = (v: string) => Math.round(Number(v) * 100);
  const valid = (['whatsapp', 'sms', 'push'] as const).every((k) => d[k] !== '' && Number(d[k]) >= 0 && Number(d[k]) <= 10);
  return (
    <Card className="max-w-xl">
      <CardHeader><CardTitle>{t('notify.admin.ratesTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('notify.admin.ratesHint')}</p>
        {(['whatsapp', 'sms', 'push'] as const).map((k) => (
          <div key={k} className="flex items-center gap-3">
            <Label htmlFor={`c-${k}`} className="w-40">{t(`notify.admin.rate.${k}`)}</Label>
            <span className="text-sm text-muted-foreground">₹</span>
            <Input id={`c-${k}`} type="number" step="0.01" min="0" max="10" className="max-w-[8rem]" disabled={!allowed} value={d[k]} onChange={(e) => setDraft({ ...d, [k]: e.target.value })} />
          </div>
        ))}
        {allowed && <Button disabled={!valid || !draft} onClick={() => setConfirm(true)}>{t('common.save')}</Button>}
        <ReasonDialog open={confirm} onOpenChange={setConfirm} title={t('notify.admin.ratesTitle')} confirmLabel={t('common.save')} busy={busy}
          onConfirm={(r) => { setBusy(true); void saveCosts({ whatsapp: paise(d.whatsapp), sms: paise(d.sms), push: paise(d.push) }, r)
            .then(() => { toast.success(t('notify.admin.saved')); setDraft(null); setConfirm(false); return qc.invalidateQueries({ queryKey: ['notifications', 'costs'] }); })
            .catch((e) => toast.error(errText(e))).finally(() => setBusy(false)); }} />
      </CardContent>
    </Card>
  );
}
