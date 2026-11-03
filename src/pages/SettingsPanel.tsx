import { useTranslation } from 'react-i18next';
import { Download, LogOut, Minus, Plus, Share } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { PageHeader } from '@/components/layout/PageHeader';
import { FONT_SCALE, useTheme, type Language, type ThemeChoice } from '@/lib/theme';
import { useAuth } from '@/auth/AuthProvider';
import { useInstall } from '@/lib/pwa';

/** "Install the app" card: the browser's install prompt, or the iOS Share → Add to Home Screen hint. */
function InstallCard() {
  const { t } = useTranslation();
  const { mode, install } = useInstall();
  if (mode === 'none') return null;
  return (
    <Card data-ref="install-card">
      <CardHeader><CardTitle>{t('pwa.installTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('pwa.installBody')}</p>
        {mode === 'prompt'
          ? <Button onClick={() => void install().then((ok) => ok && toast.success(t('pwa.installed')))}><Download />{t('pwa.install')}</Button>
          : <p className="flex items-start gap-2 text-sm"><Share className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />{t('pwa.iosHint')}</p>}
      </CardContent>
    </Card>
  );
}

/** Profile tab for now: display preferences + sign out (patient & doctor). */
export function SettingsPanel({ titleKey = 'nav.profile', withHeader = true }: { titleKey?: string; withHeader?: boolean }) {
  const { t } = useTranslation();
  const { prefs, setPrefs } = useTheme();
  const { session, signOut } = useAuth();
  const step = (d: number) => setPrefs({ fontScale: Math.min(FONT_SCALE.max, Math.max(FONT_SCALE.min, Math.round((prefs.fontScale + d) * 10) / 10)) });
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {withHeader && <PageHeader title={t(titleKey)} subtitle={session?.user.name || session?.user.phone || undefined} />}
      <Card>
        <CardHeader><CardTitle>{t('settings.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium" id="lang-l">{t('settings.language')}</p>
            <Segmented<Language> aria-labelledby="lang-l" value={prefs.language} onValueChange={(v) => setPrefs({ language: v })}
              options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം', lang: 'ml' }]} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium" id="theme-l">{t('settings.theme')}</p>
            <Segmented<ThemeChoice> aria-labelledby="theme-l" value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v })}
              options={(['light', 'dark', 'system'] as const).map((v) => ({ value: v, label: t(`settings.${v}`) }))} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium" id="fs-l">{t('settings.textSize')}</p>
            <div className="flex items-center gap-3" role="group" aria-labelledby="fs-l">
              <Button variant="outline" size="icon" onClick={() => step(-FONT_SCALE.step)} disabled={prefs.fontScale <= FONT_SCALE.min} aria-label={t('settings.smaller')}><Minus /></Button>
              <p className="flex-1 text-center" aria-live="polite"><span className="font-semibold">Aa</span> <span className="text-sm text-muted-foreground">{Math.round(prefs.fontScale * 100)}%</span></p>
              <Button variant="outline" size="icon" onClick={() => step(FONT_SCALE.step)} disabled={prefs.fontScale >= FONT_SCALE.max} aria-label={t('settings.larger')}><Plus /></Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <InstallCard />
      <Button variant="outline" block onClick={() => void signOut()}><LogOut />{t('auth.signOut')}</Button>
    </div>
  );
}
