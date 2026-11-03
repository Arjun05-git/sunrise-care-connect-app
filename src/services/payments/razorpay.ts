import { CheckoutCancelled, CheckoutFailed, type CheckoutOptions, type CheckoutProvider, type CheckoutResult, type PaymentOrder } from './types';

type RazorpayCtor = new (opts: Record<string, unknown>) => { open(): void; on(evt: 'payment.failed', cb: (r: { error?: { description?: string } }) => void): void };
declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://checkout.razorpay.com/v1/checkout.js', async: true });
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new CheckoutFailed('script_failed'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Razorpay Standard Checkout (TEST mode with rzp_test_ keys): UPI, cards, net banking, wallets. */
export const razorpayCheckout: CheckoutProvider = {
  name: 'razorpay',
  async open(order: PaymentOrder, opts: CheckoutOptions): Promise<CheckoutResult> {
    await loadScript();
    return new Promise((resolve, reject) => {
      const rzp = new window.Razorpay!({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount * 100,
        currency: order.currency,
        name: 'Sunrise Care Connect',
        description: opts.description,
        prefill: order.prefill,
        notes: { ref: order.ref_code }, // booking reference only – no health data
        theme: { color: opts.themeColor },
        timeout: Math.max(60, order.seconds_left), // checkout closes when the slot hold ends
        method: { upi: true, card: true, netbanking: true, wallet: true },
        handler: (r: CheckoutResult) => resolve(r),
        modal: { ondismiss: () => reject(new CheckoutCancelled()), confirm_close: true },
      });
      rzp.on('payment.failed', (r) => reject(new CheckoutFailed(r.error?.description ?? 'failed')));
      rzp.open();
    });
  },
};
