import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  lang?: string;
}

/**
 * A choice between a few values that looks like a tab strip but is a radio group (WAI-ARIA radiogroup
 * pattern): one Tab stop, arrow keys move and select. Use it for filters and preferences; use Tabs only
 * when each option shows its own panel.
 */
export function Segmented<T extends string>({ value, onValueChange, options, className, ...aria }: {
  value: T;
  onValueChange: (v: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const i = (from + step + options.length) % options.length;
    onValueChange(options[i]!.value);
    refs.current[i]?.focus();
  };
  return (
    <div role="radiogroup" {...aria} className={cn('inline-flex w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted p-1 text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            lang={o.lang}
            data-state={on ? 'active' : 'inactive'}
            onClick={() => onValueChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
            }}
            className="inline-flex min-h-[40px] flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 min-[360px]:px-3 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm [&_svg]:size-4"
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
