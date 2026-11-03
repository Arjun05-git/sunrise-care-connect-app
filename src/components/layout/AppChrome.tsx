import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/pwa';
import { initNative } from '@/lib/native';

/**
 * App-wide pieces that sit outside the role shells: the offline banner and, in the Android/iOS
 * app, the native bridge (status bar, back button, notification taps).
 */
export function AppChrome() {
  const { t } = useTranslation();
  const online = useOnline();
  const navigate = useNavigate();
  useEffect(() => { void initNative((path) => navigate(path)); }, [navigate]);
  if (online) return null;
  return (
    <div role="status" data-ref="offline-banner" className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-foreground px-3 py-1.5 text-center text-xs font-semibold text-background">
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('pwa.offline')}</span>
    </div>
  );
}
