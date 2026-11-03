import { cn } from '@/lib/utils';

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg width="32" height="32" viewBox="0 0 64 64" aria-hidden className="shrink-0">
        <rect width="64" height="64" rx="16" className="fill-primary" />
        <circle cx="32" cy="38" r="12" fill="#FBBF24" />
        <path d="M14 42h36" stroke="white" strokeWidth="4" strokeLinecap="round" />
        <path d="M32 16v6M18 22l4 4M46 22l-4 4" stroke="#FDE68A" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M28 46h8M32 42v8" stroke="white" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {withText && (
        <span className="leading-tight max-[359px]:sr-only">
          <span className="block text-[15px] font-extrabold tracking-tight">Sunrise Care</span>
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-primary">Connect</span>
        </span>
      )}
    </span>
  );
}
