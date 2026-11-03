import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, Languages, LogOut, Menu, Moon, Sun, UserRound } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { NavItem } from './nav';

export interface TopBarProps {
  homeTo: string;
  /** Inline nav shown on md+ (mobile uses the bottom tab bar). */
  items?: NavItem[];
  userName?: string;
  roleLabel?: string;
  onSignOut?: () => void;
  onMenu?: () => void;
  showLogo?: boolean;
  logoClassName?: string;
  notificationsCount?: number;
  className?: string;
  static?: boolean;
  extra?: ReactNode;
  /** Live notification bell; replaces the static icon when given. */
  bell?: ReactNode;
}

/** Sticky top bar: logo, desktop nav, language & theme quick switches, notifications, user menu. */
export function TopBar({ homeTo, items, userName, roleLabel, onSignOut, onMenu, showLogo = true, logoClassName, notificationsCount = 0, className, static: isStatic, extra, bell }: TopBarProps) {
  const { t } = useTranslation();
  const { prefs, resolved, setPrefs } = useTheme();
  return (
    <header className={cn(isStatic ? 'relative' : 'sticky top-0 z-30', 'safe-top border-b bg-background/85 backdrop-blur', className)}>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        {onMenu && (
          <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" onClick={onMenu} aria-label={t('nav.openMenu')}>
            <Menu className="h-5 w-5" />
          </Button>
        )}
        {showLogo && <Link to={homeTo} aria-label={t('nav.home')} className={logoClassName}><Logo /></Link>}
        {items && (
          <nav aria-label={t('nav.main')} className="ml-6 hidden items-center gap-1 md:flex">
            {items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => cn('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors', isActive ? 'bg-primary-soft text-primary-soft-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
                <it.icon className="h-4 w-4" aria-hidden />
                {t(it.labelKey)}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {extra}
          <Button variant="ghost" size="icon" onClick={() => setPrefs({ language: prefs.language === 'en' ? 'ml' : 'en' })} aria-label={t('settings.switchLanguage')} title={t('settings.switchLanguage')}>
            <Languages className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setPrefs({ theme: resolved === 'dark' ? 'light' : 'dark' })} aria-label={resolved === 'dark' ? t('settings.useLight') : t('settings.useDark')}>
            {resolved === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
          {bell ?? (
            <Button variant="ghost" size="icon" className="relative" aria-label={t('nav.notifications', { count: notificationsCount })}>
              <Bell className="h-5 w-5" />
              {notificationsCount > 0 && <span className="absolute right-2.5 top-2.5 h-2.5 w-2.5 rounded-full bg-highlight ring-2 ring-background" aria-hidden />}
            </Button>
          )}
          {userName && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('nav.account')}><UserRound className="h-5 w-5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <span className="block text-sm text-foreground">{userName}</span>
                  {roleLabel && <span className="block font-normal">{roleLabel}</span>}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}><LogOut />{t('auth.signOut')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
