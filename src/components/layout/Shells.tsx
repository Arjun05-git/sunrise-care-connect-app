import { lazy, Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { useAuth } from '@/auth/AuthProvider';
import { BottomTabBar } from './BottomTabBar';
import { DemoBanner } from './DemoBanner';
import { Sidebar } from './Sidebar';
import { SkipLink } from './SkipLink';
import { TopBar } from './TopBar';
import type { NavItem } from './nav';
import { isDemo } from '@/lib/config';

// the live bell reads Supabase – loaded lazily and never in demo mode
const LiveBell = lazy(() => import('@/features/notifications/Bell').then((m) => ({ default: m.NotificationBell })));
const bell = isDemo ? undefined : <Suspense fallback={null}><LiveBell /></Suspense>;

/** Patient & doctor: top bar (inline nav on md+) + bottom tab bar on phones. */
export function MobileTabShell({ items, homeTo, emergencyNotice }: { items: NavItem[]; homeTo: string; emergencyNotice?: boolean }) {
  const { session, signOut } = useAuth();
  const { t } = useTranslation();
  const loc = useLocation();
  return (
    <div className="min-h-dvh">
      <SkipLink />
      <DemoBanner />
      <TopBar homeTo={homeTo} items={items} userName={session?.user.name || session?.user.phone || ''} roleLabel={session ? t(`roles.${session.user.role}`) : undefined} onSignOut={() => void signOut()} bell={bell} />
      <main id="main" className="mx-auto max-w-6xl px-4 pb-28 pt-5 md:pb-10">
        {/* min height: the emergency notice below starts off-screen, so content arriving on a slow
            connection doesn't push it around (layout shift) */}
        <div key={loc.pathname} className="min-h-[75dvh] animate-fade-up">
          <Outlet />
        </div>
        {emergencyNotice && <EmergencyNotice compact className="mx-auto mt-6 max-w-2xl" />}
      </main>
      <BottomTabBar items={items} />
    </div>
  );
}

/** Admin: persistent left sidebar on desktop, sheet drawer on smaller screens. */
export function SidebarShell({ items, homeTo }: { items: NavItem[]; homeTo: string }) {
  const { session, signOut } = useAuth();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const common = { items, userName: session?.user.name, roleLabel: session ? t(`roles.${session.user.role}`) : undefined, onSignOut: () => void signOut() };
  return (
    <div className="min-h-dvh">
      <SkipLink />
      <div className="flex">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r lg:block">
          <Sidebar {...common} />
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" closeLabel={t('common.close')}>
            <SheetTitle className="sr-only">{t('nav.main')}</SheetTitle>
            <Sidebar {...common} onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <div className="min-w-0 flex-1">
          <DemoBanner />
          <TopBar homeTo={homeTo} onMenu={() => setOpen(true)} logoClassName="lg:hidden" bell={bell} />
          <main id="main" className="mx-auto max-w-7xl p-4 sm:p-6">
            <div key={loc.pathname} className="animate-fade-up">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
