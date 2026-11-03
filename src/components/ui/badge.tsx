import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold [&_svg]:size-3 [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-primary-soft text-primary-soft-foreground',
      neutral: 'border border-border bg-muted text-muted-foreground',
      highlight: 'bg-highlight-soft text-warning',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      destructive: 'bg-destructive-soft text-destructive',
      outline: 'border border-border text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
