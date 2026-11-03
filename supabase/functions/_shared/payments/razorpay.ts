import { hmacHex, safeEqual } from './crypto.ts';
import type { GatewayPayment, GatewayRefund, PaymentProvider } from './provider.ts';

type Fetch = typeof fetch;
interface RzpPayment { id: string; order_id: string; status: GatewayPayment['status']; method: string | null; amount: number }
interface RzpRefund { id: string; status: GatewayRefund['status']; receipt?: string | null }

/** Razorpay Orders / Payments / Refunds REST API (TEST mode with rzp_test_ keys). */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  constructor(
    private keyId: string,
    private keySecret: string,
    private webhookSecret: string,
    private http: Fetch = fetch,
    private base = 'https://api.razorpay.com/v1',
  ) {}

  get publicKey() {
    return this.keyId;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.http(this.base + path, {
      method,
      headers: { Authorization: 'Basic ' + btoa(`${this.keyId}:${this.keySecret}`), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    if (!res.ok) throw new Error(`razorpay_${res.status}_${data.error?.code ?? 'error'}`);
    return data as T;
  }

  private static toPayment(p: RzpPayment): GatewayPayment {
    return { id: p.id, orderId: p.order_id, status: p.status, method: p.method, amountInr: p.amount / 100 };
  }

  async createOrder({ amountInr, receipt, notes }: { amountInr: number; receipt: string; notes: Record<string, string> }) {
    const o = await this.call<{ id: string }>('POST', '/orders', { amount: Math.round(amountInr * 100), currency: 'INR', receipt, notes, payment_capture: 1 });
    return { orderId: o.id };
  }

  async verifyPaymentSignature({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }) {
    return safeEqual(await hmacHex(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  async verifyWebhookSignature(rawBody: string, signature: string) {
    return !!this.webhookSecret && safeEqual(await hmacHex(this.webhookSecret, rawBody), signature);
  }

  async getPayment(paymentId: string) {
    return RazorpayProvider.toPayment(await this.call<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`));
  }

  async capture(paymentId: string, amountInr: number) {
    return RazorpayProvider.toPayment(await this.call<RzpPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: Math.round(amountInr * 100), currency: 'INR' }));
  }

  async refund({ paymentId, amountInr, receipt, notes }: { paymentId: string; amountInr: number; receipt: string; notes: Record<string, string> }) {
    const r = await this.call<RzpRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: Math.round(amountInr * 100), speed: 'normal', receipt, notes });
    return { id: r.id, status: r.status };
  }

  async findRefund(paymentId: string, receipt: string) {
    const list = await this.call<{ items: RzpRefund[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    const r = list.items.find((x) => x.receipt === receipt);
    return r ? { id: r.id, status: r.status } : null;
  }
}
