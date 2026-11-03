import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Phone, Video } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * Entry to the consultation room. Opens the waiting room any time on the day (device check), and
 * becomes the primary "Join now" button once the join window is open. The server re-checks the window.
 */
export function JoinLink({ appt, who, joinMin = 10, closeMin = 30, size = 'sm', block }: {
  appt: { id: string; start_at: string; end_at: string; status: string; mode: string; extended_minutes?: number };
  who: 'p' | 'd'; joinMin?: number; closeMin?: number; size?: ButtonProps['size']; block?: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);
  if (!['confirmed', 'in_progress'].includes(appt.status)) return null;
  const opens = new Date(appt.start_at).getTime() - joinMin * 60_000;
  const closes = new Date(appt.end_at).getTime() + (closeMin + (appt.extended_minutes ?? 0)) * 60_000;
  if (now > closes || opens - now > 12 * 3600_000) return null; // only on the day
  const open = now >= opens;
  const Icon = appt.mode === 'audio' ? Phone : Video;
  const label = open ? t(who === 'd' ? (appt.status === 'in_progress' ? 'consult.link.rejoin' : 'consult.link.start') : 'consult.link.join') : t('consult.link.waitingRoom');
  return (
    <Button asChild size={size} block={block} variant={open ? 'default' : 'outline'}>
      <Link to={`/${who}/consult/${appt.id}`} data-ref="join-link"><Icon aria-hidden />{label}</Link>
    </Button>
  );
}
