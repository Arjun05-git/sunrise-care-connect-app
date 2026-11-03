import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { cn } from '@/lib/utils';
import type { NavItem } from './nav';

export interface SidebarProps {
  items: NavItem[];
  userName?: string;
  roleLabel?: string;
  onNavigate?: () => void;
  onSignOut?: () => void;
  className?: string;
}

/** Admin left sidebar (desktop; rendered inside a Sheet on smaller screens). */
export function Sidebar({ items, userName, roleLabel, onNavigate, onSignOut, className }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex h-full flex-col bg-card', className)}>
      <div className="flex h-16 items-center border-b px-5"><Logo /></div>
      <nav aria-label={t('nav.main')} className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => cn('flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors', isActive ? 'bg-primary-soft text-primary-soft-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
            <n.icon className="h-[18px] w-[18px]" aria-hidden />
            {t(n.labelKey)}
          </NavLink>
        ))}
      </nav>
      {(userName || onSignOut) && (
        <div className="border-t p-3">
          {userName && (
            <div className="px-3 pb-2 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">{userName}</div>
              {roleLabel}
            </div>
          )}
          {onSignOut && (
            <button type="button" onClick={onSignOut} className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <LogOut className="h-[18px] w-[18px]" aria-hidden />
              {t('auth.signOut')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
