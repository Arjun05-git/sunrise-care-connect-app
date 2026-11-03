import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { NavItem } from './nav';

/** Mobile bottom tab bar (patient & doctor). 56px targets, active pill, safe-area aware. */
export function BottomTabBar({ items, className, static: isStatic }: { items: NavItem[]; className?: string; static?: boolean }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.main')} className={cn(isStatic ? 'relative' : 'fixed inset-x-0 bottom-0 z-30 md:hidden', 'safe-bottom border-t bg-card/95 backdrop-blur', className)}>
      <ul className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((it) => (
          <li key={it.to}>
            <NavLink to={it.to} end={it.end} className={({ isActive }) => cn('flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors', isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}>
              {({ isActive }) => (
                <>
                  <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-primary-soft')}>
                    <it.icon className="h-5 w-5" aria-hidden />
                  </span>
                  {t(it.labelKey)}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
