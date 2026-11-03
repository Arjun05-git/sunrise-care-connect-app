import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, FlaskConical, Landmark, Smartphone, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { callFunction, FunctionError } from '@/lib/functions';
import { inr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CheckoutCancelled, CheckoutFailed, type CheckoutProvider, type CheckoutResult, type PaymentOrder } from './types';

/**
 * Test gateway checkout (local development / CI without Razorpay keys). It talks to the
 * `payments-mock-checkout` function, which signs results exactly like Razorpay, so verification,
 * webhooks and refunds run through the production code paths.
 */
type Pending = { order: PaymentOrder; resolve: (r: CheckoutResult) => void; reject: (e: Error) => void } | null;
let pending: Pending = null;
const listeners = new Set<() => void>();
const set = (p: Pending) => {
  pending = p;
  listeners.forEach((l) => l());
};

export const mockCheckout: CheckoutProvider = {
  name: 'mock',
  open: (order) => new Promise((resolve, reject) => set({ order, resolve, reject })),
};

const METHODS = [
  { id: 'upi', icon: Smartphone },
  { id: 'card', icon: CreditCard },
  { id: 'netbanking', icon: Landmark },
  { id: 'wallet', icon: Wallet },
] as const;

/** Mounted once at the app root; shows the test checkout while a payment is open. */
export function MockCheckoutHost() {
  const { t, i18n } = useTranslation();
  const p = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => pending);
  const [method, setMethod] = useState<(typeof METHODS)[number]['id']>('upi');
  const [busy, setBusy] = useState<'success' | 'failure' | null>(null);

  const finish = async (outcome: 'success' | 'failure') => {
    if (!p) return;
    setBusy(outcome);
    try {
      const r = await callFunction<CheckoutResult>('payments-mock-checkout', { order_id: p.order.order_id, method, outcome });
      p.resolve(r);
    } catch (e) {
      p.reject(new CheckoutFailed(e instanceof FunctionError ? e.code : 'failed'));
    } finally {
      setBusy(null);
      set(null);
    }
  };

  return (
    <Dialog open={!!p} onOpenChange={(o) => { if (!o && p && !busy) { p.reject(new CheckoutCancelled()); set(null); } }}>
      <DialogContent closeLabel={t('common.close')} className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FlaskConical className="h-5 w-5 text-warning" aria-hidden />{t('pay.mock.title')}</DialogTitle>
          <DialogDescription>{t('pay.mock.body')}</DialogDescription>
        </DialogHeader>
        {p && (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between rounded-xl bg-muted p-3">
              <span className="text-sm text-muted-foreground">{p.order.ref_code}</span>
              <span className="text-xl font-extrabold">{inr(p.order.amount, i18n.language)}</span>
            </div>
            <div role="radiogroup" aria-label={t('pay.mock.method')} className="grid grid-cols-2 gap-2">
              {METHODS.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => setMethod(m.id)}
                  className={cn('flex min-h-12 items-center gap-2 rounded-xl border px-3 text-sm font-medium', method === m.id ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent')}>
                  <m.icon className="h-4 w-4" aria-hidden />{t(`pay.method.${m.id}`)}
                </button>
              ))}
            </div>
            <Button block size="lg" loading={busy === 'success'} disabled={!!busy} onClick={() => void finish('success')}>{t('pay.mock.pay', { amount: inr(p.order.amount, i18n.language) })}</Button>
            <Button block variant="outline" loading={busy === 'failure'} disabled={!!busy} onClick={() => void finish('failure')}>{t('pay.mock.decline')}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
