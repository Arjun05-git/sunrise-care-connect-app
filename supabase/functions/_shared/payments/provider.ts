/**
 * PaymentProvider – the server-side gateway contract. Order creation, signature checks, capture and
 * refunds only ever run on the server (they need the key secret). Amounts are whole rupees here;
 * implementations convert to the gateway's unit (paise for Razorpay).
 */
export type ProviderName = 'razorpay' | 'mock';

export interface GatewayPayment {
  id: string;
  orderId: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  method: string | null;
  amountInr: number;
}

export interface GatewayRefund {
  id: string;
  status: 'pending' | 'processed' | 'failed';
}

export interface PaymentProvider {
  readonly name: ProviderName;
  /** Public key the checkout needs (Razorpay key_id); null for the mock gateway. */
  readonly publicKey: string | null;
  createOrder(input: { amountInr: number; receipt: string; notes: Record<string, string> }): Promise<{ orderId: string }>;
  /** Checkout handler signature: HMAC_SHA256(order_id|payment_id, key_secret). */
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): Promise<boolean>;
  /** Webhook signature: HMAC_SHA256(raw body, webhook_secret). */
  verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean>;
  getPayment(paymentId: string): Promise<GatewayPayment>;
  capture(paymentId: string, amountInr: number): Promise<GatewayPayment>;
  /** `receipt` is our refund id – lets a retry find a refund that was created before a crash. */
  refund(input: { paymentId: string; amountInr: number; receipt: string; notes: Record<string, string> }): Promise<GatewayRefund>;
  findRefund(paymentId: string, receipt: string): Promise<GatewayRefund | null>;
}
