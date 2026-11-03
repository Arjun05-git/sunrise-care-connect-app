import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/lib/theme';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** shadcn/ui Toaster wired to the app theme. Use `toast.success/error/message` from 'sonner'. */
const Toaster = (props: ToasterProps) => {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="top-center"
      closeButton
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: 'group toast rounded-xl group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lift',
          description: 'group-[.toast]:text-muted-foreground',
          success: 'group-[.toaster]:[&_[data-icon]]:text-success',
          error: 'group-[.toaster]:[&_[data-icon]]:text-destructive',
          warning: 'group-[.toaster]:[&_[data-icon]]:text-warning',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
