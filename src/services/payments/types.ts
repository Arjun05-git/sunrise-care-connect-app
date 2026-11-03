/**
 * Client side of the payment integration. The browser only opens the gateway's checkout and hands
 * the signed result to the server (`payments-verify`). Orders are created, and signatures checked,
 * on the server with the key secret; card / UPI details never touch our systems.
 */
export interface PaymentOrder {
  provider: 'razorpay' | 'mock';
  key_id: string | null;
  order_id: string;
  amount: number; // rupees
  currency: 'INR';
  ref_code: string;
  seconds_left: number;
  prefill: { name?: string; contact?: string; email?: string };
}

/** Razorpay's handler payload (the mock gateway returns the same shape). */
export interface CheckoutResult {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface CheckoutOptions {
  description: string;
  themeColor: string;
  language: 'en' | 'ml';
}

export interface CheckoutProvider {
  readonly name: PaymentOrder['provider'];
  open(order: PaymentOrder, opts: CheckoutOptions): Promise<CheckoutResult>;
}

export class CheckoutCancelled extends Error {
  constructor() {
    super('payment_cancelled');
  }
}
export class CheckoutFailed extends Error {
  constructor(public reason: string) {
    super('payment_failed');
  }
}
