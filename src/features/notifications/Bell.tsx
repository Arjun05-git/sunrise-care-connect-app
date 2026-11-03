import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useRealtime } from '@/lib/realtime';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/utils';
import { markRead, nqk, useInbox } from './api';

/** In-app messages (the same events as WhatsApp / SMS), live. Opening one follows its secure link. */
export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { session } = useAuth();
  const inbox = useInbox();
  useRealtime('bell', [{ table: 'notifications', filter: `user_id=eq.${session?.user.id}` }], [nqk.inbox], undefined, !!session);
  const items = inbox.data ?? [];
  const unread = items.filter((m) => !m.read_at).length;
  const readAll = async () => {
    await markRead().catch(() => undefined);
    void qc.invalidateQueries({ queryKey: nqk.inbox });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t('nav.notifications', { count: unread })} data-ref="bell">
          <Bell className="h-5 w-5" />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-highlight px-1 text-[10px] font-bold text-highlight-foreground" aria-hidden>{unread > 9 ? '9+' : unread}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <DropdownMenuLabel className="p-0">{t('notify.bell.title')}</DropdownMenuLabel>
          {unread > 0 && <Button variant="ghost" size="sm" onClick={(e) => { e.preventDefault(); void readAll(); }}><CheckCheck aria-hidden />{t('notify.bell.readAll')}</Button>}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-96 overflow-y-auto" data-ref="bell-list">
          {items.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('notify.bell.empty')}</p> : items.map((m) => (
            <DropdownMenuItem key={m.id} className={cn('flex cursor-pointer flex-col items-start gap-0.5 whitespace-normal rounded-none border-b px-3 py-2.5 text-sm last:border-0', !m.read_at && 'bg-primary-soft/40')}
              onSelect={() => { void markRead([m.id]).then(() => qc.invalidateQueries({ queryKey: nqk.inbox })); if (m.link) nav(m.link); }}>
              <span>{m.rendered_text.replace(/\s*https?:\/\/\S+/g, '').replace(/[:\s]+$/, '')}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(m.created_at, i18n.language)}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
