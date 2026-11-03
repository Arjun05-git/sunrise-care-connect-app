import type { SupabaseClient } from '@supabase/supabase-js';
import { providerFor, type ProviderName } from './payments/index.ts';

interface Claim { refund_id: string; amount: number; provider: ProviderName; provider_payment_id: string; ref_code: string; retry: boolean }

/**
 * Execute one queued refund exactly once: claim (DB row lock + 5-minute lease) → gateway → settle.
 * Our refund id is sent as the gateway `receipt`, so a retry after a crash first looks the refund up
 * instead of refunding twice. A gateway "pending" refund stays `initiated` until the webhook settles it.
 */
export async function processRefund(svc: SupabaseClient, refundId: string): Promise<{ status: string; provider_refund_id?: string }> {
  const { data: claim, error } = await svc.rpc('claim_refund', { p_refund: refundId });
  if (error) throw error;
  if (!claim) return { status: 'skipped' };
  const c = claim as Claim;
  const gw = providerFor(c.provider);
  try {
    const found = c.retry ? await gw.findRefund(c.provider_payment_id, c.refund_id) : null;
    const r = found ?? (await gw.refund({ paymentId: c.provider_payment_id, amountInr: c.amount, receipt: c.refund_id, notes: { ref: c.ref_code } }));
    const status = r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'initiated';
    const { error: e2 } = await svc.rpc('settle_refund', { p_refund: c.refund_id, p_status: status, p_provider_refund_id: r.id, p_failure: status === 'failed' ? 'gateway_failed' : null });
    if (e2) throw e2;
    return { status, provider_refund_id: r.id };
  } catch (e) {
    // leave the claim in place: the sweep retries after the lease (and looks the refund up first)
    console.error('refund_error', (e as Error).message);
    return { status: 'retry_later' };
  }
}
