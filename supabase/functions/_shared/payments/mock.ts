import { hmacHex, safeEqual } from './crypto.ts';
import type { GatewayPayment, PaymentProvider } from './provider.ts';

/**
 * Local test gateway with Razorpay's exact signature scheme, so the verify / webhook / refund code
 * paths are the same as production. Payment ids carry method + amount (and are covered by the
 * signature, so they can't be altered): pay_mock_<method>_<paise>_<random>.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  readonly publicKey = null;
  constructor(private secret: string, private webhookSecret: string) {}

  static rand(n = 14) {
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('');
  }

  async createOrder() {
    return { orderId: `order_mock_${MockProvider.rand()}` };
  }

  /** What the mock checkout calls when the "patient" pays. */
  async simulatePayment(orderId: string, method: string, amountInr: number) {
    const paymentId = `pay_mock_${method}_${Math.round(amountInr * 100)}_${MockProvider.rand()}`;
    return { paymentId, signature: await hmacHex(this.secret, `${orderId}|${paymentId}`) };
  }

  async signWebhook(rawBody: string) {
    return hmacHex(this.webhookSecret, rawBody);
  }

  async verifyPaymentSignature({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }) {
    return safeEqual(await hmacHex(this.secret, `${orderId}|${paymentId}`), signature);
  }

  async verifyWebhookSignature(rawBody: string, signature: string) {
    return safeEqual(await hmacHex(this.webhookSecret, rawBody), signature);
  }

  async getPayment(paymentId: string): Promise<GatewayPayment> {
    const m = /^pay_mock_([a-z]+)_(\d+)_[a-z0-9]+$/.exec(paymentId);
    if (!m) throw new Error('mock_unknown_payment');
    return { id: paymentId, orderId: '', status: 'captured', method: m[1]!, amountInr: Number(m[2]) / 100 };
  }

  async capture(paymentId: string) {
    return this.getPayment(paymentId);
  }

  async refund() {
    return { id: `rfnd_mock_${MockProvider.rand()}`, status: 'processed' as const };
  }

  async findRefund() {
    return null;
  }
}
