import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EmptyArt = 'calendar' | 'folder' | 'bell' | 'search' | 'users' | 'construction';

/** Friendly empty state with a small inline illustration (no external assets, theme-aware). */
export function EmptyState({ title, body, action, art = 'calendar', className }: { title: ReactNode; body?: ReactNode; action?: ReactNode; art?: EmptyArt; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <Illustration kind={art} />
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function Illustration({ kind }: { kind: EmptyArt }) {
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" aria-hidden className="text-primary">
      <ellipse cx="60" cy="86" rx="40" ry="6" className="fill-muted" />
      <circle cx="96" cy="18" r="10" className="fill-highlight/30" />
      <circle cx="20" cy="30" r="5" className="fill-primary-soft" />
      {kind === 'calendar' && (
        <g>
          <rect x="30" y="20" width="60" height="56" rx="10" className="fill-card stroke-current" strokeWidth="2.5" />
          <rect x="30" y="20" width="60" height="16" rx="8" className="fill-primary-soft" />
          <path d="M44 14v12M76 14v12" className="stroke-current" strokeWidth="3" strokeLinecap="round" />
          <circle cx="48" cy="52" r="4" className="fill-primary" />
          <circle cx="60" cy="52" r="4" className="fill-muted" />
          <circle cx="72" cy="52" r="4" className="fill-muted" />
          <circle cx="48" cy="64" r="4" className="fill-muted" />
        </g>
      )}
      {kind === 'folder' && (
        <g>
          <path d="M26 30a6 6 0 0 1 6-6h18l6 6h32a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6H32a6 6 0 0 1-6-6z" className="fill-primary-soft stroke-current" strokeWidth="2.5" />
          <rect x="44" y="40" width="32" height="24" rx="4" className="fill-card stroke-current" strokeWidth="2" />
          <path d="M50 48h20M50 55h12" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
        </g>
      )}
      {kind === 'bell' && (
        <g>
          <path d="M60 18c-12 0-20 9-20 21v14l-6 9h52l-6-9V39c0-12-8-21-20-21z" className="fill-primary-soft stroke-current" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M53 66a7 7 0 0 0 14 0" className="stroke-current" strokeWidth="2.5" fill="none" />
        </g>
      )}
      {kind === 'search' && (
        <g>
          <circle cx="55" cy="44" r="18" className="fill-primary-soft stroke-current" strokeWidth="3" />
          <path d="M68 57l14 14" className="stroke-current" strokeWidth="5" strokeLinecap="round" />
        </g>
      )}
      {kind === 'users' && (
        <g>
          <circle cx="50" cy="38" r="11" className="fill-primary-soft stroke-current" strokeWidth="2.5" />
          <circle cx="74" cy="42" r="8" className="fill-card stroke-current" strokeWidth="2.5" />
          <path d="M30 74c2-12 10-18 20-18s18 6 20 18M64 74c1-8 5-13 10-13s10 5 12 13" className="stroke-current" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </g>
      )}
      {kind === 'construction' && (
        <g>
          <rect x="30" y="34" width="60" height="40" rx="8" className="fill-card stroke-current" strokeWidth="2.5" />
          <path d="M38 34l10-14h24l10 14" className="fill-primary-soft stroke-current" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M42 54h36M42 64h22" className="stroke-current" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
