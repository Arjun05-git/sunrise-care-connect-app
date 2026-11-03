import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// shadcn/ui Button, Sunrise sizing: 44px minimum tap target, rounded-xl, one clear primary. Labels wrap
// (the button grows taller) instead of running off a small phone, e.g. in Malayalam or at large text sizes.
const buttonVariants = cva(
  'inline-flex max-w-full items-center justify-center gap-2 rounded-xl text-center text-[15px] font-semibold leading-tight transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-card hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        highlight: 'bg-highlight text-highlight-foreground shadow-sm hover:bg-highlight/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-9 rounded-lg px-3 py-1.5 text-sm',
        lg: 'min-h-12 px-6 py-2.5 text-base',
        icon: 'h-11 w-11',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, block, asChild = false, loading, disabled, children, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp className={cn(buttonVariants({ variant, size, block, className }))} ref={ref} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {asChild ? children : (<>{loading && <Loader2 className="animate-spin" aria-hidden />}{children}</>)}
    </Comp>
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
