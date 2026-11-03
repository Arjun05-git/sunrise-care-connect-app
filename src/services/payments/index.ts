import { callFunction, downloadFunctionFile } from '@/lib/functions';
import { mockCheckout } from './mock';
import { razorpayCheckout } from './razorpay';
import type { CheckoutOptions, CheckoutProvider, PaymentOrder } from './types';

export * from './types';

const PROVIDERS: Record<PaymentOrder['provider'], CheckoutProvider> = { razorpay: razorpayCheckout, mock: mockCheckout };

export interface VerifyResult {
  result: 'confirmed' | 'confirmed_late' | 'already_captured' | 'refund_pending';
  appointment_id: string;
  payment_id: string;
  receipt_no: string;
  appointment_status: string;
}

/**
 * Pay for a held booking: server creates the order (amount from the DB) → the gateway's checkout
 * collects the payment → the server verifies the signature and confirms the booking.
 */
export async function payForAppointment(appointmentId: string, opts: CheckoutOptions): Promise<VerifyResult> {
  const order = await callFunction<PaymentOrder>('payments-create-order', { appointment_id: appointmentId });
  const result = await PROVIDERS[order.provider].open(order, opts);
  return callFunction<VerifyResult>('payments-verify', { order_id: result.razorpay_order_id, payment_id: result.razorpay_payment_id, signature: result.razorpay_signature });
}

export const downloadReceipt = (paymentId: string) => downloadFunctionFile('payments-receipt', { payment_id: paymentId }, 'receipt.pdf');
