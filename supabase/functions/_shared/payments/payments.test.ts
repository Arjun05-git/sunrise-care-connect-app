// @vitest-environment node
import { createHmac } from 'node:crypto';
import { hmacHex, safeEqual } from './crypto.ts';
import { MockProvider } from './mock.ts';
import { RazorpayProvider } from './razorpay.ts';
import { latin, renderReceipt, type ReceiptData } from '../receipt.ts';

const nodeHmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');

describe('signatures', () => {
  it('HMAC-SHA256 hex matches Node crypto (Razorpay scheme)', async () => {
    expect(await hmacHex('key_secret', 'order_1|pay_1')).toBe(nodeHmac('key_secret', 'order_1|pay_1'));
  });
  it('constant-time compare', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('RazorpayProvider', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace('https://api.razorpay.com/v1', '');
    const body = path === '/orders' ? { id: 'order_T1' }
      : path.endsWith('/refund') ? { id: 'rfnd_T1', status: 'pending' }
      : path.includes('/refunds') ? { items: [{ id: 'rfnd_X', status: 'processed', receipt: 'our-refund-id' }] }
      : path.endsWith('/capture') ? { id: 'pay_T1', order_id: 'order_T1', status: 'captured', method: 'upi', amount: 80000 }
      : { id: 'pay_T1', order_id: 'order_T1', status: 'authorized', method: 'upi', amount: 80000 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const rzp = new RazorpayProvider('rzp_test_key', 'secret', 'whsec', fakeFetch);

  beforeEach(() => (calls.length = 0));

  it('creates orders in paise with basic auth and auto-capture', async () => {
    expect(await rzp.createOrder({ amountInr: 800, receipt: 'SC-ABC123', notes: { ref: 'SC-ABC123' } })).toEqual({ orderId: 'order_T1' });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ amount: 80000, currency: 'INR', receipt: 'SC-ABC123', payment_capture: 1 });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('rzp_test_key:secret').toString('base64'));
  });
  it('verifies checkout and webhook signatures', async () => {
    expect(await rzp.verifyPaymentSignature({ orderId: 'order_T1', paymentId: 'pay_T1', signature: nodeHmac('secret', 'order_T1|pay_T1') })).toBe(true);
    expect(await rzp.verifyPaymentSignature({ orderId: 'order_T1', paymentId: 'pay_T2', signature: nodeHmac('secret', 'order_T1|pay_T1') })).toBe(false);
    expect(await rzp.verifyWebhookSignature('{"a":1}', nodeHmac('whsec', '{"a":1}'))).toBe(true);
    expect(await rzp.verifyWebhookSignature('{"a":2}', nodeHmac('whsec', '{"a":1}'))).toBe(false);
  });
  it('maps payments (paise → rupees), captures and refunds with our id as receipt', async () => {
    expect(await rzp.getPayment('pay_T1')).toMatchObject({ status: 'authorized', amountInr: 800, orderId: 'order_T1' });
    expect((await rzp.capture('pay_T1', 800)).status).toBe('captured');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ amount: 80000, currency: 'INR' });
    expect(await rzp.refund({ paymentId: 'pay_T1', amountInr: 250, receipt: 'our-refund-id', notes: {} })).toEqual({ id: 'rfnd_T1', status: 'pending' });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ amount: 25000, receipt: 'our-refund-id' });
    expect(await rzp.findRefund('pay_T1', 'our-refund-id')).toEqual({ id: 'rfnd_X', status: 'processed' });
    expect(await rzp.findRefund('pay_T1', 'other')).toBeNull();
  });
  it('turns gateway errors into stable codes', async () => {
    const failing = new RazorpayProvider('k', 's', 'w', (async () => new Response('{"error":{"code":"BAD_REQUEST_ERROR"}}', { status: 400 })) as unknown as typeof fetch);
    await expect(failing.createOrder({ amountInr: 1, receipt: 'r', notes: {} })).rejects.toThrow('razorpay_400_BAD_REQUEST_ERROR');
  });
});

describe('MockProvider', () => {
  const mock = new MockProvider('gw-secret', 'wh-secret');
  it('produces Razorpay-style signed results that verify, and binds the amount into the id', async () => {
    const { orderId } = await mock.createOrder();
    const { paymentId, signature } = await mock.simulatePayment(orderId, 'upi', 650);
    expect(await mock.verifyPaymentSignature({ orderId, paymentId, signature })).toBe(true);
    expect(await mock.getPayment(paymentId)).toMatchObject({ status: 'captured', method: 'upi', amountInr: 650 });
    const tampered = paymentId.replace('_65000_', '_100_');
    expect(await mock.verifyPaymentSignature({ orderId, paymentId: tampered, signature })).toBe(false);
  });
  it('signs webhooks with its own secret', async () => {
    const body = '{"event":"payment.captured"}';
    expect(await mock.verifyWebhookSignature(body, await mock.signWebhook(body))).toBe(true);
    expect(await mock.verifyWebhookSignature(body, nodeHmac('gw-secret', body))).toBe(false);
  });
});

describe('receipt PDF', () => {
  const data: ReceiptData = {
    receipt_no: 'SCR-2026-000001', ref_code: 'SC-ABC123', amount: 800, currency: 'INR', method: 'upi', provider: 'razorpay',
    provider_payment_id: 'pay_T1', captured_at: '2026-10-23T05:00:00Z', status: 'partially_refunded', patient_name: 'അഞ്ജലി Menon',
    doctor_name: 'Dr. Arun Nair', doctor_reg: 'TCMC/40000', department: 'Cardiology',
    hospital: { name: 'Sunrise Hospital Kakkanad', city: 'Kochi', address: 'Kakkanad', phone: '+91 484 000 0000' },
    mode: 'video', consult_type: 'first', start_at: '2026-10-24T04:30:00Z', refunds: [{ amount: 200, status: 'processed', at: '2026-10-23T06:00:00Z' }],
  };
  it('maps typographic punctuation for the Latin-1 PDF font', () => {
    expect(latin('Seaport–Airport Road · ₹500 “ok”')).toBe('Seaport-Airport Road · Rs.500 "ok"');
    expect(latin('അഞ്ജലി')).toBe('??????');
  });
  it('renders a one-page PDF, even with non-Latin names', async () => {
    const pdf = await renderReceipt(data);
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('Receipt SCR-2026-000001');
  });
});
