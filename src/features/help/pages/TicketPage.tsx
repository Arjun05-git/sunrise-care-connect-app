import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';
import { TICKET_VARIANT } from '@/features/admin/console-api';
import { postTicketMessage, useMyTicket } from '../api';

/** One support ticket: the conversation with Sunrise and a reply box. */
export function TicketPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const q = useMyTicket(id);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  if (q.isPending) return <CardSkeleton />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  const { ticket: tk, messages } = q.data;
  const send = async () => {
    setBusy(true);
    try {
      await postTicketMessage(tk.id, body.trim());
      setBody('');
      await qc.invalidateQueries({ queryKey: ['help'] });
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader back="/p/help" title={tk.subject} subtitle={<span><span className="font-mono">{tk.ref_code}</span> · {t(`help.cat.${tk.category}`)}</span>} />
      <Badge variant={TICKET_VARIANT[tk.status]} data-ref="ticket-status">{t(`help.st.${tk.status}`)}</Badge>
      <ol className="space-y-2" aria-label={t('help.conversation')} data-ref="conversation">
        <li className="rounded-xl border bg-card p-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{t('help.you')} · {formatDateTime(tk.created_at, lang)}</p><p className="whitespace-pre-wrap">{tk.description}</p></li>
        {messages.map((m) => (
          <li key={m.id} className={cn('rounded-xl border p-3 text-sm', m.author_kind === 'staff' ? 'ml-6 bg-primary-soft/50' : 'mr-6 bg-card')}>
            <p className="mb-1 text-xs text-muted-foreground">{m.author_kind === 'staff' ? t('help.sunrise') : t('help.you')} · {formatDateTime(m.created_at, lang)}</p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>
      {tk.resolution && (tk.status === 'resolved' || tk.status === 'closed') && (
        <Card className="border-success/40"><CardContent className="p-3 text-sm"><p className="text-xs font-semibold text-success">{t('help.resolution')}</p><p className="whitespace-pre-wrap">{tk.resolution}</p></CardContent></Card>
      )}
      {tk.status !== 'closed' ? (
        <div className="space-y-2">
          <Label htmlFor="reply">{tk.status === 'resolved' ? t('help.reopen') : t('help.reply')}</Label>
          <Textarea id="reply" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex justify-end"><Button disabled={!body.trim()} loading={busy} onClick={() => void send()} data-ref="reply-send"><Send aria-hidden />{t('help.send')}</Button></div>
        </div>
      ) : <p className="text-sm text-muted-foreground">{t('help.closed')}</p>}
    </div>
  );
}
