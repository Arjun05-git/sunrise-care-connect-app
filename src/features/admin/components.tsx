import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthProvider';
import type { Role } from '@/auth/types';

export const useHasRole = (...roles: Role[]) => {
  const { session } = useAuth();
  return !!session && roles.includes(session.user.role);
};

/** Stable error code from an RPC / function error, translated (admin.err.* → common.error). */
export function useAdminError() {
  const { t, i18n } = useTranslation();
  return (e: unknown) => {
    const code = (e as { code?: string; message?: string })?.code ?? (e as { message?: string })?.message ?? '';
    return i18n.exists(`admin.err.${code}`) ? t(`admin.err.${code}`) : t('common.error');
  };
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
      <Lock className="h-4 w-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/**
 * Confirmation dialog for every money / policy change: extra fields + a mandatory reason
 * (≥ 5 characters) that is stored in the audit log with the change.
 */
export function ReasonDialog({ open, onOpenChange, title, description, children, confirmLabel, destructive, busy, valid = true, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children?: ReactNode; confirmLabel: string;
  destructive?: boolean; busy?: boolean; valid?: boolean; onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const short = reason.trim().length < 5;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-4">
          {children}
          <div className="space-y-1.5">
            <Label htmlFor="reason">{t('admin.reason')}</Label>
            <Textarea id="reason" rows={2} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('admin.reasonPh')} />
            <p className="text-xs text-muted-foreground">{t('admin.reasonHint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={short || !valid} loading={busy} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
