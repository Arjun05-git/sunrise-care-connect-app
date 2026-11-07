import { useTranslation } from 'react-i18next';
import { Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRecording } from './useRecording';

type Props = Parameters<typeof useRecording>[0];

/** Consent + start/stop controls for audio recording of a consultation. Renders nothing while the hospital has recording off. */
export function RecordingPanel(props: Props) {
  const { t } = useTranslation();
  const r = useRecording(props);
  const doctor = props.role === 'doctor';
  if (r.phase === 'off') return null;

  let body: React.ReactNode = null;
  switch (r.phase) {
    case 'idle':
      body = doctor ? <Button size="sm" variant="secondary" onClick={() => void r.giveConsent()}>{t('consult.rec.ask')}</Button> : null;
      break;
    case 'asked':
      body = <><span>{t('consult.rec.waitingPatient')}</span><Button size="sm" variant="ghost" onClick={() => void r.withdrawConsent()}>{t('consult.rec.cancelAsk')}</Button></>;
      break;
    case 'invited':
      body = <><span>{t('consult.rec.invite')}</span><Button size="sm" onClick={() => void r.giveConsent()}>{t('consult.rec.allow')}</Button></>;
      break;
    case 'ready':
      body = doctor
        ? <Button size="sm" disabled={!r.canRecord.ok} onClick={() => void r.start()}>{t('consult.rec.start')}</Button>
        : <><span>{t('consult.rec.agreed')}</span><Button size="sm" variant="ghost" onClick={() => void r.withdrawConsent()}>{t('consult.rec.withdraw')}</Button></>;
      break;
    case 'recording':
      body = <><span className="flex items-center gap-1 font-medium"><Circle className="h-3 w-3 animate-pulse fill-red-500 text-red-500" aria-hidden />{t('consult.rec.recording')}</span>
        {doctor ? <Button size="sm" variant="secondary" onClick={() => void r.stop()}>{t('consult.rec.stop')}</Button> : <Button size="sm" variant="ghost" onClick={() => void r.withdrawConsent()}>{t('consult.rec.withdraw')}</Button>}</>;
      break;
    case 'saving':
      body = <span>{t('consult.rec.saving')}</span>;
      break;
    case 'interrupted':
      body = <><span>{t('consult.rec.interrupted')}</span><Button size="sm" variant="secondary" onClick={() => void r.endInterrupted()}>{t('consult.rec.endInterrupted')}</Button></>;
      break;
  }
  const notice = r.error ? t(`consult.rec.error.${r.error}`, { defaultValue: t('consult.rec.error.generic') }) : doctor && r.phase === 'ready' && !r.canRecord.ok ? t(`consult.rec.error.${r.canRecord.reason === 'provider' ? 'unsupported_provider' : 'unsupported_browser'}`) : null;
  if (!body && !notice) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-black/60 px-3 py-2 text-xs text-white">
      {body}
      {notice && <span className="text-amber-300">{notice}</span>}
    </div>
  );
}
