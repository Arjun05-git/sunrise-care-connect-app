import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, MessageSquareText, Smartphone } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { nqk, savePrefs, usePrefs, type Prefs } from './api';
import { disablePush, enablePush, pushOnThisDevice, pushSupported } from './push';

/** SMS, reminders and push on this device. (WhatsApp is the consent switch in the consents card.) */
export function NotificationPrefsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const prefs = usePrefs();
  const [device, setDevice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void pushOnThisDevice().then(setDevice).catch(() => setDevice(false)); }, []);

  const set = async (patch: Partial<Prefs>) => {
    if (!prefs.data) return;
    const next = { ...prefs.data, ...patch };
    qc.setQueryData(nqk.prefs, next);
    try {
      await savePrefs(next);
      toast.success(t('notify.prefs.saved'));
    } catch {
      toast.error(t('common.error'));
      void qc.invalidateQueries({ queryKey: nqk.prefs });
    }
  };
  const togglePush = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const r = await enablePush();
        if (r === 'denied') toast.error(t('notify.prefs.pushDenied'));
        if (r === 'unsupported') toast.error(t('notify.prefs.pushUnsupported'));
        setDevice(r === 'enabled');
        if (r === 'enabled' && prefs.data && !prefs.data.push) await set({ push: true });
      } else {
        await disablePush();
        setDevice(false);
      }
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const Row = ({ icon, title, hint, checked, onChange, disabled, id }: { icon: React.ReactNode; title: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string }) => (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 text-primary">{icon}</span>
      <div className="min-w-0 flex-1"><label htmlFor={id} className="text-sm font-medium">{title}</label><p className="text-xs text-muted-foreground">{hint}</p></div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
  return (
    <Card data-ref="notify-prefs">
      <CardHeader><CardTitle>{t('notify.prefs.title')}</CardTitle><CardDescription>{t('notify.prefs.subtitle')}</CardDescription></CardHeader>
      <CardContent className="divide-y">
        <Row id="np-sms" icon={<MessageSquareText className="h-5 w-5" />} title={t('notify.prefs.sms')} hint={t('notify.prefs.smsHint')} checked={prefs.data?.sms ?? true} disabled={!prefs.data} onChange={(v) => void set({ sms: v })} />
        <Row id="np-rem" icon={<BellRing className="h-5 w-5" />} title={t('notify.prefs.reminders')} hint={t('notify.prefs.remindersHint')} checked={prefs.data?.reminders ?? true} disabled={!prefs.data} onChange={(v) => void set({ reminders: v })} />
        <Row id="np-push" icon={<Smartphone className="h-5 w-5" />} title={t('notify.prefs.push')} hint={pushSupported() ? t('notify.prefs.pushHint') : t('notify.prefs.pushUnsupported')}
          checked={!!device} disabled={busy || device === null || !pushSupported()} onChange={(v) => void togglePush(v)} />
        <p className="pt-3 text-xs text-muted-foreground">{t('notify.prefs.privacy')}</p>
      </CardContent>
    </Card>
  );
}
